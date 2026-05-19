# Runbook: Stuck Bet Recovery

## What this is

The crash-recovery worker (`runRecovery`) runs automatically at every server startup.
It scans `bet_log` for non-terminal rows (PENDING, ROLLBACK_PENDING, SETTLING) and
drives each one to a terminal state by replaying the appropriate wallet call:

- **PENDING** → issues `/rollback` (spec §5.5: unknown `betTxnId` returns 200 noop,
  so this is safe whether the operator ever debited or not) → **VOIDED**
- **ROLLBACK_PENDING** → issues `/rollback` with a deterministic idempotency key
  (`rb-<betTxnId>`) → **VOIDED**
- **SETTLING** → re-issues `/win` using `winTxnId`/`multiplier`/`winAmountMinor`
  stored at the moment the row entered SETTLING → **SETTLED** (or **WIN_FAILED**
  if the operator wallet is permanently unresponsive)

The recovery log line appears in server output before the `[server] listening` line:

```
[recovery] report {"pending":{...},"rollbackPending":{...},"settling":{...}}
```

---

## When you need this runbook

- A player reports "my bet vanished" or "my win didn't credit" and the incident
  window straddles a server restart or crash.
- You see non-zero counts in the `[recovery] report` log on startup.
- You want to manually verify that a stuck bet has been resolved.
- You receive an `[alert] win_failed` or `[alert] rollback_failed` line in server logs
  (see "Alert signals" below).

---

## Alert signals

Task 4.1 introduced `ConsoleAlerter`, which is the primary on-call signal for stuck
bets. It writes a single structured line to **stderr** whenever a win or rollback
permanently fails. Two line formats:

**Happy path — full JSON payload:**

```
[alert] win_failed {"kind":"win_failed","betRow":{...},"source":"cashout"|"recovery","error":"..."}
[alert] rollback_failed {"kind":"rollback_failed","betRow":{...},"reason":"...","error":"..."}
```

- `source` is `"cashout"` when the failure happened in the live cashout path or
  `"recovery"` when it happened during the startup recovery sweep.
- `error` is the `WalletError` code the operator returned (e.g. `WALLET_INTERNAL`).
- `reason` (rollback_failed only) is a human-readable description of why recovery
  gave up on the rollback.

**Partial-signal fallback — fires when JSON.stringify fails on the event object:**

```
[alert] win_failed (serialization failed) <betId>
[alert] rollback_failed (serialization failed) <betId>
```

The betId is always emitted as a plain string even in this degraded path, so
on-call can still look up the row and act.

### grep / journalctl recipes

```bash
# Tail live alert lines from a log file
grep '\[alert\] win_failed' /var/log/galaxy-crash.log

# Include rollback alerts too
grep '\[alert\]' /var/log/galaxy-crash.log

# If running under systemd — stream live
journalctl -u galaxy-crash -f | grep '\[alert\]'

# Pull all alerts from the last 24 h and pretty-print their JSON payloads
grep '\[alert\] win_failed' /var/log/galaxy-crash.log \
  | awk '{$1=$2=""; print $0}' \
  | jq '.'
```

---

## Diagnose

Inspect the SQLite database directly:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, state, error_code, win_txn_id, rollback_txn_id, updated_at
   FROM bet_log
   WHERE state NOT IN ('SETTLED','LOST','VOIDED')
   ORDER BY updated_at DESC
   LIMIT 50;"
```

### Non-terminal states explained

| State             | Meaning                                                         |
|-------------------|-----------------------------------------------------------------|
| `PENDING`         | `/bet` was sent but the process crashed before we got a reply.  |
| `ROLLBACK_PENDING`| We know /bet may have debited; we need to send `/rollback`.     |
| `SETTLING`        | `/bet` succeeded and `/win` was sent but not confirmed settled. |

---

## What recovery does automatically

On the **next server restart**, `runRecovery` will:

1. Move every `PENDING` row to `ROLLBACK_PENDING` (tagged `recovery_pending_at_startup`).
2. Send `/rollback` for every `ROLLBACK_PENDING` row.
   - If the operator never debited (PENDING case), the stub/operator returns `status:"noop"`.
   - If the operator did debit, the balance is refunded. Row → **VOIDED**.
3. Re-send `/win` for every `SETTLING` row using the persisted `winTxnId`.
   - The operator's idempotency table (spec §9) ensures no double-credit.
   - On success → **SETTLED**. On retry exhaustion → **WIN_FAILED**.

No manual action is required for PENDING or ROLLBACK_PENDING rows — restart is enough.

---

## Manual restart test

Use this procedure to verify recovery end-to-end in a staging environment.

**Prerequisites**: operator stub running on port 4000.

```bash
# 1. Start the operator stub in one terminal
npm run --workspace=tools/operator-stub start

# 2. Start the server and grab its PID
npm run --workspace=packages/server dev &
SERVER_PID=$!

# 3. Place a bet via the WebSocket or a direct wallet-client call
#    (the bet must be in PENDING or SETTLING state when you kill)

# 4. Kill the server hard (simulates a crash mid-flight)
kill -9 $SERVER_PID

# 5. Inspect the DB — should show a PENDING or ROLLBACK_PENDING row
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, state FROM bet_log WHERE state NOT IN ('SETTLED','LOST','VOIDED');"

# 6. Restart the server
npm run --workspace=packages/server dev

# 7. Grep the startup output for the recovery line
# Expected: [recovery] report {"pending":{"resolved":1,...},...}

# 8. Confirm the row is now terminal
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, state, rollback_txn_id FROM bet_log ORDER BY updated_at DESC LIMIT 5;"
```

---

## When recovery can't help: WIN_FAILED rows

If `/win` exhausts all retries (6 attempts with exponential back-off), the row
transitions to `WIN_FAILED`. Recovery will NOT retry these — they require manual
intervention via the force-credit admin endpoint (see "Force-crediting a WIN_FAILED
row" below).

To list all WIN_FAILED rows:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, player_id, win_txn_id, win_amount_minor, multiplier,
          win_op_txn_id, error_code, updated_at
   FROM bet_log WHERE state = 'WIN_FAILED' ORDER BY updated_at DESC;"
```

---

## Force-crediting a WIN_FAILED row

### Prerequisite: ADMIN_API_TOKEN

The admin surface is gated on the `ADMIN_API_TOKEN` environment variable set on the
running server process. **When unset, every admin request returns 503 ADMIN_DISABLED
— this is intentional fail-closed behaviour.** A misconfigured deployment cannot
accidentally reach the force-credit path.

Set the variable before starting the server:

```bash
# Development / staging
export ADMIN_API_TOKEN=<your-secret>
npm run --workspace=packages/server dev

# Production — put the secret in your deploy secret manager (e.g. AWS Secrets
# Manager, Kubernetes Secret, Fly.io secret) and inject it as the ADMIN_API_TOKEN
# env var. Do not hard-code it in any config file committed to the repo.
```

Phase 5.2 will replace this shared-secret scheme with JWT + roles. Until then,
protect the secret as you would a root password.

---

### Confirm the row is WIN_FAILED and retrievable

Before calling force-credit, verify the row exists and is in the right state:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, state, win_txn_id, win_amount_minor, multiplier,
          win_op_txn_id, error_code, updated_at
   FROM bet_log WHERE bet_id = '<betId>';"
```

The row must be in `WIN_FAILED` state and must have non-NULL values for
`win_txn_id`, `win_amount_minor`, and `multiplier`. If any of these are NULL,
see "If force-credit is impossible (BET_NOT_RECONSTRUCTIBLE)" below.

---

### Issue the force-credit request

```bash
curl -s -X POST http://localhost:3001/admin/v1/bet-log/<betId>/force-credit \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_API_TOKEN" \
  -d '{"reason":"Operator confirmed via support ticket #1234; manual settlement requested."}'
```

Replace `localhost:3001` with the actual server host/port in your environment.
The `reason` field is mandatory and must be a non-empty string — it is written
verbatim into the `admin_audit` row as the chain-of-custody note.

---

### Expected responses

**200 — success (WIN_FAILED → SETTLED):**

```json
{
  "ok": true,
  "betId": "<betId>",
  "state": "SETTLED",
  "operatorTxnId": "<operator-assigned-transaction-id>"
}
```

Record the `operatorTxnId` in the support ticket. It is the operator's reference
for the credit that was issued.

**All error branches:**

| HTTP | `error.code` | When | What to do |
|------|--------------|------|------------|
| 400 | `INVALID_REQUEST` | `reason` field is missing, not a string, or blank | Provide a non-empty `reason` string |
| 401 | `INVALID_ADMIN_TOKEN` | `X-Admin-Token` header missing, sent as an array, or value does not match `ADMIN_API_TOKEN` | Verify the env var value; check for copy-paste whitespace |
| 503 | `ADMIN_DISABLED` | `ADMIN_API_TOKEN` env var is unset or empty on the server | Set the env var and restart the server, then retry |
| 404 | `BET_NOT_FOUND` | No row exists for this `betId` | Re-check the betId for typos |
| 409 | `BET_NOT_WIN_FAILED` | Row exists but is in a different state | Check the actual state — it may already be `SETTLED`; no action needed |
| 409 | `BET_NOT_RECONSTRUCTIBLE` | `win_txn_id`, `win_amount_minor`, or `multiplier` is NULL on the row | Data-integrity event — see "If force-credit is impossible" below; escalate to engineering immediately |
| 503 | `OPERATOR_UNAVAILABLE` | Operator's `WalletClient` is not in the registry (operator paused or deleted) | Unpause/re-register the operator in the registry, then retry |
| 502 | _(WalletError code from operator)_ | Operator's `/win` endpoint returned a permanent error | See "If force-credit fails again (502)" below |
| 409 | `TRANSITION_FAILED` | Operator credited the player but our `bet_log` row could not move to `SETTLED` | Data-integrity event — open a P0 ticket; the player IS credited (operator side), our record is inconsistent. Use the `admin_audit` row's `payload.operatorTxnId` to confirm what was issued |
| 500 | `INTERNAL` | Unexpected server-side error | Check server logs for `[admin] force_credit: unexpected error:` |

---

### Audit trail

Every force-credit attempt (from step 2 onwards — after the `reason` validation
passes) writes an immutable row to the `admin_audit` table. To inspect what was
done to a specific bet:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT id, actor, action, target, payload_json, datetime(at,'unixepoch') AS at_utc
   FROM admin_audit
   WHERE target = '<betId>'
   ORDER BY at DESC;"
```

To see the last 10 force-credit attempts across all bets:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT id, actor, target, payload_json, datetime(at,'unixepoch') AS at_utc
   FROM admin_audit
   WHERE action = 'force_credit'
   ORDER BY at DESC
   LIMIT 10;"
```

**`payload_json` fields** (parsed from the stored JSON):

| Field | Present when | Meaning |
|-------|-------------|---------|
| `result` | always | One of: `settled`, `failed`, `not_found`, `rejected_state`, `not_reconstructible`, `operator_unavailable`, `transition_error`, `internal_error` |
| `reason` | always (except `internal_error`) | The human-supplied reason string |
| `operatorTxnId` | `result=settled` or `result=transition_error` | Operator's transaction reference for the credit |
| `balanceMinor` | `result=settled` | Player's balance after the credit (in minor currency units) |
| `error` | `result=failed` | The `WalletError` code the operator returned |
| `state` | `result=rejected_state` | The actual state of the row (e.g. `SETTLED`, `VOIDED`) |
| `missingFields` | `result=not_reconstructible` | Array naming which of `winTxnId`, `winAmountMinor`, `multiplier` was NULL |
| `operatorId` | `result=operator_unavailable` | The operatorId whose client was missing |

---

### If force-credit fails again (502)

The operator's `/win` endpoint is still returning a permanent error. The row stays
`WIN_FAILED`. **Do not retry blindly.**

Steps:
1. Note the `error` code in the 502 response body and in the `admin_audit` row.
2. Contact the operator's ops team. Ask them to confirm whether the player should
   be credited and whether their system has any record of the original `winTxnId`.
3. If the operator says "we never received that bet" — they may need to clear their
   idempotency record for that `txnId` server-side before a retry will succeed.
4. If the operator says "we already credited manually via our UI" — the player is
   made whole; coordinate to get the operator's transaction reference and record it.
   Then escalate to engineering to manually mark the bet as SETTLED in `bet_log`
   with the correct `win_op_txn_id` — this is not an on-call self-service operation.
5. If the operator is unresponsive — escalate per the escalation section below.

---

### If force-credit is impossible (BET_NOT_RECONSTRUCTIBLE)

A Phase 1.6 invariant was broken: `win_txn_id`, `win_amount_minor`, and/or
`multiplier` must be persisted to `bet_log` before the `/win` call is attempted.
If any of these is NULL, the force-credit endpoint cannot reconstruct the win
request safely.

The `admin_audit` row's `payload.missingFields` names which fields are NULL:

| Missing field | Recovery path |
|---------------|--------------|
| `winTxnId` | Manual credit via operator backoffice. Mint a new transaction reference and coordinate with the operator to credit the player. Do not use force-credit — it requires the original `winTxnId` to safely re-issue. Escalate to engineering. |
| `winAmountMinor` | If `multiplier` is present, re-derive from `bet_log.amount_minor × multiplier`. Escalate to engineering to patch the row and then retry force-credit. |
| `multiplier` | Check round history to recover the crash point for this `round_id`. Escalate to engineering. |

**This is not an on-call self-service fix.** File a P0 ticket with the `bet_id`,
the full `bet_log` row dump, and the `admin_audit` payload. Engineering must
investigate how the invariant broke.

---

## Escalation

If a bet remains stuck after a restart, or a `WIN_FAILED` row needs resolution:

1. Dump the full row for the affected `bet_id`:
   ```bash
   sqlite3 ./data/galaxy-crash.db \
     "SELECT * FROM bet_log WHERE bet_id = '<bet_id>';"
   ```
2. Check the `admin_audit` table — it is the chain-of-custody for every
   force-credit action (immutable, keyed by `target = bet_id`):
   ```bash
   sqlite3 ./data/galaxy-crash.db \
     "SELECT id, actor, action, target, payload_json, datetime(at,'unixepoch') AS at_utc
      FROM admin_audit WHERE target = '<bet_id>' ORDER BY at DESC;"
   ```
3. Cross-reference against the operator's transaction ledger (Phase 8 reconciliation
   tooling will automate this; until then, do it by hand).
4. File a ticket with:
   - The `bet_id` and `player_id`
   - The full row dump from step 1
   - All `admin_audit` rows from step 2
   - The server `[recovery] report` log from the last startup
   - The operator's transaction reference (`win_op_txn_id` or `bet_op_txn_id`)
   - The `[alert]` log line(s) that triggered the incident
