# Operator Backoffice REST API — v1

**Status:** Draft v1 · **Audience:** Casino operators integrating Galaxy Crash · **Date:** 2026-05-18

What we expose **to each casino**. Strictly scoped to that operator's own data — there is no cross-operator visibility on this surface. REST only. All routes prefixed `/op/v1`.

If you are an operator integrating us, this complements the [Seamless Wallet Integration Spec](seamless-wallet-v1.md) — the wallet spec describes the calls **we make to you** in real time; this spec describes the calls **you can make to us** for support tooling, reconciliation, and per-player operations.

---

## 1. Authentication

Same credentials as the wallet integration. Each request signed per wallet spec §4.2 (canonical signing string + headers). See wallet spec §4.2 for the exact signing-string construction and header list.

```
X-API-Key:    <your apiKey>
X-Timestamp:  <unix-seconds>
X-Nonce:      <uuid v4>
X-Signature:  <hex hmac-sha256>
Content-Type: application/json
```

Signing string:
```
METHOD + "\n" + PATH + "\n" + X-Timestamp + "\n" + X-Nonce + "\n" + SHA256(body-bytes)
```

The same `signingKey` shared between us authenticates both directions. We reject:
- Missing or malformed headers → `401 INVALID_REQUEST`
- Bad HMAC → `401 INVALID_SIGNATURE`
- Timestamp skew > 300s → `401 STALE_REQUEST`
- Reused nonce within 10 min → `401 NONCE_REUSED`
- Operator account exists but is paused → `403 OPERATOR_PAUSED`

**Tenant scoping is automatic**: every query is implicitly filtered by the operator the `apiKey` resolves to. Asking us for a round that belongs to another operator returns `404`, never the round.

For `GET` requests the body is empty (`""`) and its SHA256 is the SHA256 of the empty string.

---

## 2. Conventions

### 2.1 Pagination

```
?cursor=<opaque>&limit=<1..200>      (default 50)
```

The cursor is an opaque base64-JSON keyset token. Treat it as an opaque string — do not parse or construct it manually. Response:

```json
{ "items": [...], "nextCursor": "...", "count": 50 }
```

`nextCursor` is `null` on the last page. Rows are ordered newest-first by `(created_at DESC, id DESC)`.

### 2.2 Time

Unix seconds, integer, UTC. Filters: `from` (inclusive), `to` (exclusive).

### 2.3 Money

Integer minor units + `currency`. See wallet spec §11.

### 2.4 Errors

```json
{
  "error": {
    "code":    "PLAYER_NOT_FOUND",
    "message": "No player with id 'op-acme-pid-9999'",
    "requestId": "01HZ..."
  }
}
```

Codes:
- `INVALID_REQUEST` (400) — malformed request body or query params
- `INVALID_SIGNATURE` / `STALE_REQUEST` / `NONCE_REUSED` (401) — auth failure
- `OPERATOR_PAUSED` (403) — operator account is paused; only `GET /health` works
- `NOT_FOUND` (404) — resource not found or belongs to another operator (no existence leak)
- `INVALID_STATE` (409) — e.g. terminating an already-closed session
- `LIMIT_OUT_OF_RANGE` (422) — `/limits` outside studio-allowed bounds
- `RATE_LIMITED` (429)
- `INTERNAL` (500)

### 2.5 Rate limiting

Default 60 req/s per operator, burst 200. Configurable per operator via studio backoffice. Headers on every response:

```
X-RateLimit-Limit:     60
X-RateLimit-Remaining: 47
X-RateLimit-Reset:     1716000060
```

### 2.6 Audit

Every **mutation** on this surface is recorded to the `operator_audit` table as a row `{ operatorId, action, target, payload, at }` (action ∈ `session.terminate`, `player.lock`, `player.unlock`, `limits.update`). Audit writes are best-effort (they never block or fail the mutation) and are scoped per operator. Denied attempts (cross-tenant / not-found, which return a `404` with no existence leak) are **not** audited. **Reads are not audited.**

---

## 3. Health & catalogue (unauthenticated allowed)

### 3.1 `GET /op/v1/health`

Public — no signature required. For monitoring.
```json
{ "ok": true, "version": "1.4.2", "gamesAvailable": ["galaxy-crash"] }
```

### 3.2 `GET /op/v1/games`

Signed. Lists the games + RTP variants + bet bounds available to your operator account.

```json
{
  "games": [
    {
      "gameId": "galaxy-crash",
      "name":   "Galaxy Crash",
      "rtpVariant": 97.0,
      "enabled": true,
      "minBetMinor": { "EUR": 10, "USD": 10 },
      "maxBetMinor": { "EUR": 500000, "USD": 500000 }
    }
  ]
}
```

---

## 4. Rounds

Round data is derived from `bet_log` rows grouped by `round_id`. There is no separate rounds table. As a result, fields that come from the live RNG loop (server seed, crash point, round number) are not persisted and are returned as `null` — this is the honest-null discipline and will be resolved in a future phase when a dedicated rounds table is added.

### 4.1 `GET /op/v1/rounds/:roundId`

Single round, scoped to your operator. Returns `404 ROUND_NOT_FOUND` if the round has no bets from your players.

The round summary fields match the `RoundSummary` shape from the `listRoundsFiltered` helper. For operator-scoped requests, `operatorIds` always contains exactly one element — your operator id (bets from other operators in the same round are not returned).

```json
{
  "roundId":        "rnd-2026-05-18-00193847",
  "roundNumber":    null,
  "crashPoint":     null,
  "serverSeedHash": null,
  "serverSeed":     null,
  "betCount":       3,
  "totalStakeMinor": { "EUR": 30000 },
  "totalPayoutMinor": null,
  "distinctPlayers": 2,
  "maxMultiplier":  3.42,
  "startedAt":      1716000000,
  "crashedAt":      1716000012,
  "yourBets": [
    {
      "betId":          "bet-...-1",
      "playerId":       "op-acme-pid-9183",
      "sessionId":      "ses-...",
      "roundId":        "rnd-...",
      "amountMinor":    10000,
      "currency":       "EUR",
      "state":          "SETTLED",
      "betTxnId":       "txn-...-a1",
      "winTxnId":       "txn-...-a2",
      "rollbackTxnId":  null,
      "betOpTxnId":     "op-tx-77182",
      "winOpTxnId":     "op-tx-77191",
      "winAmountMinor": 24500,
      "multiplier":     2.45,
      "errorCode":      null,
      "createdAt":      1716000010,
      "updatedAt":      1716000023
    }
  ]
}
```

**Null fields (Phase-future gaps):** `roundNumber`, `crashPoint`, `serverSeedHash`, `serverSeed`, and `totalPayoutMinor` are always `null` in v1 — the underlying data is not persisted in `bet_log` and requires a dedicated rounds table (Phase-future).

Players from other operators in the same round are not listed.

### 4.2 `GET /op/v1/rounds?from=...&to=...&playerId=...&minMultiplier=...`

List rounds with at least one of your bets. Filters: `from`, `to`, `minMultiplier`, `maxMultiplier`, `cursor`, `limit`. Pagination: §2.1 convention; keyset ordered by `(lastAt DESC, roundId DESC)`.

Response:
```json
{ "items": [ ...RoundSummary shapes as 4.1 without yourBets... ], "nextCursor": "...", "count": 10 }
```

---

## 5. Bets

### 5.1 `GET /op/v1/bets`

Filters: `playerId`, `state`, `from`, `to`, `betId`, `txnId`, `cursor`, `limit`.

Pagination: §2.1 convention; keyset ordered by `(createdAt DESC, betId DESC)`.

Item shape (derived from `BetRow` — all fields present):
```json
{
  "betId":          "bet-...-1",
  "operatorId":     "op-acme",
  "playerId":       "op-acme-pid-9183",
  "sessionId":      "ses-...",
  "roundId":        "rnd-...",
  "amountMinor":    10000,
  "currency":       "EUR",
  "state":          "SETTLED",
  "betTxnId":       "txn-...-a1",
  "winTxnId":       "txn-...-a2",
  "rollbackTxnId":  null,
  "betOpTxnId":     "op-tx-77182",
  "winOpTxnId":     "op-tx-77191",
  "winAmountMinor": 24500,
  "multiplier":     2.45,
  "errorCode":      null,
  "createdAt":      1716000010,
  "updatedAt":      1716000023
}
```

States: `PENDING | ARMED | FLYING | SETTLING | SETTLED | LOST | ROLLBACK_PENDING | VOIDED | WIN_FAILED`.

The `operatorId` field is always the calling operator's id (scoped automatically).

### 5.2 `GET /op/v1/bets/:betId`

Single bet, includes timeline + the wallet calls we made on your endpoints:

```json
{
  "bet": { "...as 5.1...": null },
  "timeline": [
    { "state": "PENDING", "at": 1716000010, "actor": "system" },
    { "state": "SETTLED", "at": 1716000023, "actor": "system",
      "operatorTxnId": "op-tx-77191" }
  ],
  "walletCalls": [
    { "kind": "bet",  "txnId": "txn-...-a1",
      "request": null,
      "response": { "operatorTxnId": "op-tx-77182" },
      "attempts": null, "totalMs": null },
    { "kind": "win",  "txnId": "txn-...-a2",
      "request": null,
      "response": { "operatorTxnId": "op-tx-77191" },
      "attempts": null, "totalMs": null }
  ]
}
```

**Phase-future gaps:** `timeline` contains at most 2 entries (creation + current state); per-transition history requires a dedicated `bet_state_transitions` table. `walletCalls[].request` is `null` (request body is stored as a hash only, not in full). `walletCalls[].attempts` and `.totalMs` are `null` (retry count and latency are not persisted in v1).

Useful for support: when a player asks "where's my win", look up the bet, see exactly which of your wallet endpoints returned what.

---

## 6. Players

### 6.1 `GET /op/v1/players/:playerId/sessions`

List this player's sessions on our side (game launches). Pagination: §2.1.

```json
{ "items": [
  { "sessionId": "ses-...", "startedAt": 1716000000,
    "endedAt": 1716003600, "currency": "EUR",
    "betCount": 12, "stakeMinor": 120000, "winMinor": 95000 }
  ],
  "nextCursor": null,
  "count": 1
}
```

Returns `404 PLAYER_NOT_FOUND` if the player has no sessions under your operator id.

### 6.2 `GET /op/v1/players/:playerId/bets`

Same as §5.1 with `playerId` pre-filtered to this player. Accepts the same `state`, `from`, `to`, `cursor`, `limit` filters. Pagination: §2.1.

### 6.3 `POST /op/v1/players/:playerId/lock`

**Responsible-gambling enforcement (RG) / AML hold.** Immediately stops accepting bets from this player on our side.

```json
{ "reason": "self_excluded", "message": "Session closed at your request." }
```

Response `204`.

**Effects (v1 implementation):** Operationally equivalent to calling `POST /op/v1/sessions/:sessionId/terminate` for every active session this player has under your operator. Each session's WebSocket connections are closed with a `session_terminated` frame and the session is deleted from the store. In-flight bets are queued for rollback (same as §7.1 terminate). Future `/launch` calls for this player are not automatically rejected in v1 — see note below.

**Important v1 limitation:** There is no persistent `player_locks` table in v1. Lock is not a stored state — it terminates all current sessions but does not prevent the player from launching a new session via a new `/launch` call after the lock. The operator's own system is responsible for blocking the re-launch flow (i.e., do not generate a new session token for a locked player). A persistent `player_locks` table that rejects `/launch` at the server level is deferred to Phase-future.

Returns `404 PLAYER_NOT_FOUND` if the player has no sessions under your operator.

**Audit:** on success, writes an `operator_audit` row (action `player.lock`, target = playerId). A `404` denied attempt is not audited (§2.6).

### 6.4 `POST /op/v1/players/:playerId/unlock`

Intended reversal of §6.3. Response `204`.

**v1 behaviour:** Because there is no persistent lock state (see §6.3 note), this endpoint is a no-op in v1 — it returns `204` without taking any server-side action. Its presence in the API preserves the unlock affordance for forward compatibility when persistent player locks are added. Your own system should re-enable session launches for this player.

**Audit:** writes an `operator_audit` row (action `player.unlock`, target = playerId) even though no server-side state changes (§2.6).

---

## 7. Sessions

### 7.1 `POST /op/v1/sessions/:sessionId/terminate`

Force-close a specific session (a player may have multiple — different tabs). Used for RG self-exclusion, AML holds, and operator-initiated session management.

Request body:
```json
{ "reason": "self_excluded", "message": "Session closed by operator." }
```
Both fields are optional strings; `reason` defaults to `"operator_terminated"`, `message` defaults to `"Session closed by operator."`.

Response `204`.

**Effects (required — all three must be durable):**

1. **WebSocket close:** all WebSocket connections for this `sessionId` receive a `session_terminated` frame `{ type: "session_terminated", data: { reason: "...", message: "..." } }` before the socket is closed with code `4001` and reason string `"session_terminated"`.

2. **Durable session invalidation:** the session is **deleted from the session store** (not merely closed). This means any subsequent reconnect attempt with the same `?session=<sessionId>` token will find no session row and will receive `{ type: "session_invalid", data: { reason: "not found" } }` from the server `hello` handler — the player cannot refresh to restore the session. **Closing the socket alone is insufficient** (the session row would survive a refresh and allow reconnect — see Phase 3.3 note below).

3. **In-flight bet rollback:** any bets in `ARMED` or `FLYING` state for this session are marked for rollback. Each bet's `cashedOut` flag is set immediately (preventing the round loop from double-processing); `voidOperatorBet` is called per-bet. If `voidOperatorBet` throws for a bet, the bet stays in a non-terminal state and the Phase 1.7 recovery worker will re-drive the rollback — a void failure does NOT block the session termination or the `204` response.

**Tenant scope:** a session belonging to another operator returns `404 SESSION_NOT_FOUND` with the same body as "session not found" — no existence leak. The identical `404` is returned for unknown sessions, sessions owned by demo/unauthenticated users, and cross-tenant sessions.

**After terminate:** any subsequent WebSocket `hello` with the same `sessionId` will receive `{ type: "session_invalid", data: { reason: "not found" } }` from the server (the session row has been deleted from the store). The player must obtain a new session token from your launch flow.

**Audit:** on success (ownership confirmed), writes an `operator_audit` row (action `session.terminate`, target = sessionId, payload `{ reason }`). The cross-tenant / not-found `404` is not audited (§2.6).

> _**Phase 3.3 note (resolved):** The Phase 3.3 stub shipped this endpoint closing the WebSocket and voiding in-flight bets but NOT deleting the session from the store (refresh-defeatable). **The durable fix has LANDED in Phase 6.4:** terminate now calls `deleteSession` after closing the sockets, so a reconnect with the same token finds no session row and receives `session_invalid`. Integrators testing against the running server now see the durable behaviour._

### 7.2 `GET /op/v1/sessions/:sessionId`

```json
{
  "sessionId":   "ses-...",
  "playerId":    "op-acme-pid-9183",
  "currency":    "EUR",
  "startedAt":   1716000000,
  "lastSeenAt":  1716000900
}
```

**State model:** This endpoint returns `200` for an active (live) session and `404 SESSION_NOT_FOUND` for any session that does not exist in the store. There is no `TERMINATED` or `EXPIRED` state in the response — terminated and expired sessions are deleted from the store (see §7.1 and store TTL expiry logic), so they are indistinguishable from never-existing sessions. This is the simplest model consistent with the `deleteSession` implementation.

Rationale for the "404 on terminate" choice: keeping deleted sessions as rows with a `terminated_at` column (for a terminated-history view) would require schema changes to the session store and is deferred to Phase-future. The simpler deletion model is implemented in v1.

---

## 8. Financial

### 8.1 `GET /op/v1/financial/summary?from=...&to=...&groupBy=currency,day`

Your operator's GGR/NGR for the window. Default groupBy: `currency`.

Allowed `groupBy` values: `'currency'` and/or `'day'`. **`'operator'` is not a valid groupBy value on this surface** — your operator id is always the implicit scope and is never returned as a field in the rows. Providing `groupBy=operator` returns `400 INVALID_REQUEST`.

`from` and `to` are required (unix seconds, integer). `to` must be greater than `from`. Window cap: 365 days.

Optional filter: `currency=<code>` narrows the report to a single currency (still operator-scoped). Omit it to report across all your enabled currencies.

```json
{
  "from": 1715000000, "to": 1716000000,
  "groupBy": ["currency", "day"],
  "rows": [
    { "currency": "EUR", "day": "2026-05-17",
      "betCount": 1820, "stakeMinor": 18200000, "winMinor": 17654000,
      "ggrMinor": 546000, "ngrMinor": 546000 }
  ]
}
```

**Field definitions:**
- `stakeMinor`: sum of `amountMinor` for bets in states `SETTLED`, `LOST`, or `WIN_FAILED`.
- `winMinor`: sum of `winAmountMinor` for bets in state `SETTLED` only.
- `ggrMinor`: `stakeMinor − winMinor`.
- `ngrMinor`: `ggrMinor` (bonuses = 0 in v1; field reserved for future use).
- `VOIDED` bets are excluded (stake was refunded in full).
- `WIN_FAILED` bets: stake is counted, win is NOT (operator hasn't confirmed credit; counted after force-credit resolves to `SETTLED`).

**Not present on this surface:** `ourShareMinor` and `shareBps` are studio-internal (the revenue-share split is not disclosed to operators on this surface). The operator sees their own GGR/NGR only.

### 8.2 `GET /op/v1/operator-tx?from=...&to=...&cursor=...`

**Reconciliation endpoint.** Returns the raw transaction stream we recorded for your operator in the window. You diff this against your own ledger nightly.

Pagination: §2.1 convention; keyset ordered by `(createdAt DESC, txnId DESC)`. `from`/`to` are inclusive/exclusive bounds on `created_at`.

Item shape (derived from `IdempotencyWithBet` — joined from `txn_idempotency` + `bet_log`):
```json
{
  "items": [
    { "txnId":        "txn-...-a1",
      "operatorTxnId": "op-tx-77182",
      "kind":         "bet",
      "playerId":     "op-acme-pid-9183",
      "betId":        "bet-...-1",
      "amountMinor":  10000,
      "currency":     "EUR",
      "status":       "OK",
      "errorCode":    null,
      "attempts":     null,
      "totalMs":      null,
      "createdAt":    1716000010 },
    { "txnId":        "txn-...-a2",
      "operatorTxnId": "op-tx-77191",
      "kind":         "win",
      "playerId":     "op-acme-pid-9183",
      "betId":        "bet-...-1",
      "amountMinor":  24500,
      "currency":     "EUR",
      "status":       "OK",
      "errorCode":    null,
      "attempts":     null,
      "totalMs":      null,
      "createdAt":    1716000023 }
  ],
  "nextCursor": null,
  "count": 2
}
```

**Field notes:**
- `kind`: `"bet"` | `"win"` | `"rollback"`.
- `amountMinor`: for `"win"` kind this is `winAmountMinor` (the credit amount); for `"bet"` and `"rollback"` it is `amountMinor` (the debit/refund amount).
- `status`: `"OK"` for confirmed transactions. `"FAILED"` if the stored response indicates failure.
- `attempts` and `totalMs` are `null` (retry count and latency not persisted in v1 — Phase-future gap).
- Drill into a specific txn via `GET /op/v1/transactions/:txnId` in Appendix A.

**Note on `/transactions` vs `/operator-tx`:** `/operator-tx` is the operator's transaction feed for reconciliation. There is no separate `/transactions` endpoint on the `/op/v1` surface — `/operator-tx` is the single feed. (The plan's "spec §6.5 /transactions" reference maps to this section; the section numbering in this spec differs from the plan's draft numbering.)

Required for our daily reconciliation. We hit *your* `/operator-tx` daily; you SHOULD hit ours and compare.

---

## 9. Limits & game configuration

### 9.1 `GET /op/v1/limits`

Your current per-currency bet bounds.
```json
{ "limits": [
  { "currency": "EUR", "minBetMinor": 10, "maxBetMinor": 500000 },
  { "currency": "USD", "minBetMinor": 10, "maxBetMinor": 500000 } ] }
```

### 9.2 `POST /op/v1/limits`

Update your bet bounds within studio-allowed ceilings.
```json
{ "currency": "EUR", "minBetMinor": 50, "maxBetMinor": 200000 }
```
Errors:
- `422 LIMIT_OUT_OF_RANGE` if outside the studio ceiling for your operator.
- `422 CURRENCY_NOT_ENABLED` if currency not in your enabled list.

Response `200` echoing the `GET /limits` shape with the updated values.

**v1 enforcement (honest subset):** the operator model has **no per-operator "studio ceiling" field**, so v1 enforces only what is real: `CURRENCY_NOT_ENABLED` (currency not in your enabled list) plus the basic invariants `minBetMinor >= 1`, `maxBetMinor >= minBetMinor`, both non-negative integers — these are the only triggers of `422 LIMIT_OUT_OF_RANGE` today. A true studio ceiling that caps how high an operator may raise its own bounds is **Phase-future**.

**v1 persistence gap (operator-wide, not per-currency):** the operator model stores a **single operator-wide** `minBetMinor`/`maxBetMinor`, not a per-currency map. Updating e.g. EUR limits therefore updates the operator-wide bound affecting **all** currencies. Per-currency persistence is Phase-future — the same fan-out gap as `GET /limits` and `GET /games`.

**Audit:** on success, writes an `operator_audit` row (action `limits.update`, target = currency, payload `{ minBetMinor, maxBetMinor }`) (§2.6).

### 9.3 `GET /op/v1/games/:gameId/config`
Your per-game config (RTP variant, enabled). Currently only `galaxy-crash`. Read-only via this surface — RTP variant changes go through studio (us).

---

## 10. Webhooks (push from us to you)

You configure a single webhook URL during onboarding. We POST signed payloads (signature scheme as §1) on:

| Event | When |
|---|---|
| `bet.win_failed` | A `/win` call to your wallet exhausted retries. Manual intervention needed. |
| `bet.force_credited` | Our staff used `force-credit`. Notification only — money already moved. |
| `reconciliation.mismatch` | Our daily run found a drift. Body lists txnIds. |
| `operator.paused` / `operator.resumed` | Status change in our system. |
| `session.terminated` | A session we ended (TTL, error). |

Payload:
```json
{
  "event": "bet.win_failed",
  "eventId": "evt-...",          // idempotency key — dedupe on your side
  "at": 1716000023,
  "data": { ... event-specific ... }
}
```

Retry policy: 5 attempts at 1s/5s/30s/2m/10m on non-2xx. After 5, the event is dropped from the queue but remains queryable at `GET /op/v1/events?from=...`.

### 10.1 `GET /op/v1/events`

Polling alternative to webhooks. Filters: `from`, `to`, `event`, `cursor`.

---

## 11. OpenAPI

`GET /op/v1/openapi.json` — no auth required. Reveals shapes only.

---

## 12. Sandbox

Sandbox base URL: `https://sandbox.galaxy-crash.io/op/v1`. Same auth scheme; uses your sandbox credentials (issued separately from production). The `operator-stub` (`tools/operator-stub`) is what sandbox uses as a fake wallet — you can run it locally for offline development.

---

## 13. Versioning

`/op/v1/...` is stable. Breaking changes ship as `/op/v2/...`. We commit to ≥ 12 months of overlap, with deprecation notices in `Sunset` and `Deprecation` headers per [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594).

---

## Appendix A — Daily reconciliation workflow

1. `GET /op/v1/operator-tx?from=T-24h&to=T` — collect our records.
2. Compare against your own ledger by `(operatorTxnId)` and `(txnId)`.
3. For any mismatch:
   - If we recorded a txn you have no record of → check your idempotency log; we will have the request body in `GET /op/v1/transactions/:txnId` (drill-down into the specific txn by our `txnId`).
   - If you recorded a txn we have no record of → likely a network failure where your debit succeeded but our response was lost. Reach out via the on-call channel; our staff use `force-credit` or `manual-rollback` to repair.
4. We run the same reconciliation against your `/operator-tx` daily at 00:15 UTC. Mismatches we find are POSTed to your webhook as `reconciliation.mismatch`.

Two-sided reconciliation eliminates almost all single-point ledger drift.
