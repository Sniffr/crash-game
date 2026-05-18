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
intervention.

**Planned tool**: the Task 4.2 admin force-credit endpoint (`POST /admin/v1/bet-log/:betId/force-credit`)
(path per plan Task 4.2; may be /admin/v1/bets/:betId/force-credit per studio-backoffice spec §6.3 — reconciled at Task 5.1.)
will allow operators to manually settle a `WIN_FAILED` row after confirming the credit
status with the operator's ledger. See the runbook coming in Task 4.3.

To list all WIN_FAILED rows:

```bash
sqlite3 ./data/galaxy-crash.db \
  "SELECT bet_id, player_id, win_txn_id, win_amount_minor, error_code, updated_at
   FROM bet_log WHERE state = 'WIN_FAILED' ORDER BY updated_at DESC;"
```

---

## Escalation

If a bet remains stuck after a restart, or a `WIN_FAILED` row needs resolution:

1. Dump the full row for the affected `bet_id`:
   ```bash
   sqlite3 ./data/galaxy-crash.db \
     "SELECT * FROM bet_log WHERE bet_id = '<bet_id>';"
   ```
2. Cross-reference against the operator's transaction ledger (Task 8.1 reconciliation
   tooling will automate this).
3. File a ticket with:
   - The `bet_id` and `player_id`
   - The full row dump from step 1
   - The server `[recovery] report` log from the last startup
   - The operator's transaction reference (`win_op_txn_id` or `bet_op_txn_id`)
