# Operator Backoffice REST API — v1

**Status:** Draft v1 · **Audience:** Casino operators integrating Galaxy Crash · **Date:** 2026-05-18

What we expose **to each casino**. Strictly scoped to that operator's own data — there is no cross-operator visibility on this surface. REST only. All routes prefixed `/op/v1`.

If you are an operator integrating us, this complements the [Seamless Wallet Integration Spec](seamless-wallet-v1.md) — the wallet spec describes the calls **we make to you** in real time; this spec describes the calls **you can make to us** for support tooling, reconciliation, and per-player operations.

---

## 1. Authentication

Same credentials as the wallet integration. Each request signed per wallet spec §4.2:

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

**Tenant scoping is automatic**: every query is implicitly filtered by the operator the `apiKey` resolves to. Asking us for a round that belongs to another operator returns `404`, never the round.

For `GET` requests the body is empty (`""`) and its SHA256 is the SHA256 of the empty string.

---

## 2. Conventions

### 2.1 Pagination

```
?cursor=<opaque>&limit=<1..200>      (default 50)
```
Response:
```json
{ "items": [...], "nextCursor": "...", "count": 50 }
```

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
- `INVALID_REQUEST` (400)
- `INVALID_SIGNATURE` / `STALE_REQUEST` / `NONCE_REUSED` (401)
- `OPERATOR_INACTIVE` (403) — operator paused; only `GET /health` works
- `NOT_FOUND` (404)
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

### 4.1 `GET /op/v1/rounds/:roundId`

Single round, scoped to your operator. `404` if the round has no bets from your players.

```json
{
  "roundId":        "rnd-2026-05-18-00193847",
  "roundNumber":    193847,
  "crashPoint":     3.42,
  "serverSeedHash": "...",
  "serverSeed":     "...",            // only after round CRASHED/closed
  "startedAt":      1716000000,
  "crashedAt":      1716000012,
  "yourBets": [
    {
      "betId":       "bet-...-1",
      "playerId":    "op-acme-pid-9183",
      "amountMinor": 10000,
      "currency":    "EUR",
      "state":       "SETTLED",
      "betTxnId":    "txn-...-a1",
      "winTxnId":    "txn-...-a2",
      "winAmountMinor": 24500,
      "multiplier":  2.45,
      "createdAt":   1716000010,
      "updatedAt":   1716000023
    }
  ]
}
```

Players from other operators in the same round are not listed.

### 4.2 `GET /op/v1/rounds?from=...&to=...&playerId=...&minMultiplier=...`

List rounds with at least one of your bets. Filters: `from`, `to`, `playerId`, `minMultiplier`, `maxMultiplier`, `cursor`, `limit`.

---

## 5. Bets

### 5.1 `GET /op/v1/bets`

Filters: `playerId`, `state`, `from`, `to`, `betId`, `txnId`, `cursor`, `limit`.

Item shape: same as wallet spec §10 + §5.3/§5.4 fields:
```json
{
  "betId":          "bet-...-1",
  "playerId":       "op-acme-pid-9183",
  "roundId":        "rnd-...",
  "amountMinor":    10000,
  "currency":       "EUR",
  "state":          "SETTLED",
  "betTxnId":       "txn-...-a1",
  "winTxnId":       "txn-...-a2",
  "rollbackTxnId":  null,
  "winAmountMinor": 24500,
  "multiplier":     2.45,
  "createdAt":      1716000010,
  "updatedAt":      1716000023
}
```

States: `PENDING | ARMED | FLYING | SETTLING | SETTLED | LOST | ROLLBACK_PENDING | VOIDED | WIN_FAILED`.

### 5.2 `GET /op/v1/bets/:betId`

Single bet, includes timeline + the wallet calls we made on your endpoints:

```json
{
  "bet": { ...as 5.1... },
  "timeline": [
    { "state": "PENDING", "at": 1716000010 },
    { "state": "ARMED",   "at": 1716000010, "yourTxnId": "op-tx-77182" },
    { "state": "SETTLING","at": 1716000023 },
    { "state": "SETTLED", "at": 1716000023, "yourTxnId": "op-tx-77191" }
  ],
  "walletCalls": [
    { "kind": "bet",  "txnId": "txn-...-a1", "attempts": 1, "totalMs": 87,
      "yourStatus": 200, "yourResponse": { "operatorTxnId": "op-tx-77182" } },
    { "kind": "win",  "txnId": "txn-...-a2", "attempts": 1, "totalMs": 122,
      "yourStatus": 200, "yourResponse": { "operatorTxnId": "op-tx-77191" } }
  ]
}
```

Useful for support: when a player asks "where's my win", look up the bet, see exactly which of your wallet endpoints returned what.

---

## 6. Players

### 6.1 `GET /op/v1/players/:playerId/sessions`

List this player's sessions on our side (game launches).

```json
{ "items": [
  { "sessionId": "ses-...", "startedAt": 1716000000,
    "endedAt": 1716003600, "currency": "EUR",
    "betCount": 12, "stakeMinor": 120000, "winMinor": 95000 } ] }
```

### 6.2 `GET /op/v1/players/:playerId/bets`

Same as §5.1 with `playerId` pre-filtered.

### 6.3 `POST /op/v1/players/:playerId/lock`

Stop accepting bets from this player immediately on our side. (RG enforcement, AML hold.)
```json
{ "reason": "self_excluded", "message": "Session closed at your request." }
```
Response `204`. Effects: ends any active session(s); voids in-flight bet via `/rollback`; rejects future `/launch` for this player with `403 PLAYER_BLOCKED` until you call §6.4.

### 6.4 `POST /op/v1/players/:playerId/unlock`
Reverses §6.3. Response `204`.

---

## 7. Sessions

### 7.1 `POST /op/v1/sessions/:sessionId/terminate`

Force-close a specific session (a player may have multiple — different tabs). Per wallet spec §6.3.

```json
{ "reason": "self_excluded", "message": "Session closed by operator." }
```
Response `204`.

### 7.2 `GET /op/v1/sessions/:sessionId`
```json
{
  "sessionId":   "ses-...",
  "playerId":    "op-acme-pid-9183",
  "currency":    "EUR",
  "startedAt":   1716000000,
  "endedAt":     null,
  "state":       "ACTIVE",       // ACTIVE | TERMINATED | EXPIRED
  "lastSeenAt":  1716000900
}
```

---

## 8. Financial

### 8.1 `GET /op/v1/financial/summary?from=...&to=...&groupBy=currency,day`

Your operator's GGR/NGR for the window. Default groupBy: `currency`.

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

### 8.2 `GET /op/v1/operator-tx?from=...&to=...&cursor=...`

**Reconciliation endpoint.** Returns the raw transaction stream we recorded for your operator in the window. You diff this against your own ledger nightly.

```json
{
  "items": [
    { "txnId": "txn-...-a1", "yourTxnId": "op-tx-77182",
      "kind": "bet", "playerId": "op-acme-pid-9183",
      "betId": "bet-...-1", "amountMinor": 10000, "currency": "EUR",
      "status": "OK", "at": 1716000010 },
    { "txnId": "txn-...-a2", "yourTxnId": "op-tx-77191",
      "kind": "win", "betId": "bet-...-1",
      "amountMinor": 24500, "currency": "EUR",
      "status": "OK", "at": 1716000023 }
  ],
  "nextCursor": null
}
```

Required for our spec §12 mutual reconciliation. We hit *your* `/operator-tx` daily; you SHOULD hit ours and compare.

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
- `422 LIMIT_OUT_OF_RANGE` if outside studio ceiling for your operator.
- `422 CURRENCY_NOT_ENABLED` if currency not in your enabled list.

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
2. Compare against your own ledger by `(yourTxnId)` and `(txnId)`.
3. For any mismatch:
   - If we recorded a txn you have no record of → check your idempotency log; we will have the request body in `GET /op/v1/transactions/:txnId` (drill-down).
   - If you recorded a txn we have no record of → likely a network failure where your debit succeeded but our response was lost. Reach out via the on-call channel; our staff use `force-credit` or `manual-rollback` to repair.
4. We run the same reconciliation against your `/operator-tx` daily at 00:15 UTC. Mismatches we find are POSTed to your webhook as `reconciliation.mismatch`.

Two-sided reconciliation eliminates almost all single-point ledger drift.
