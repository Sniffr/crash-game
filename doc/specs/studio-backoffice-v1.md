# Studio Backoffice REST API — v1

**Status:** Draft v1 · **Audience:** Internal (Galaxy Crash staff: admin, finance, support, ops) · **Date:** 2026-05-18

The "overall" backoffice. Cross-tenant control plane over operators, rounds, bets, money, and reconciliation. REST only — no UI. All routes are prefixed `/admin/v1`.

---

## 1. Auth & roles

### 1.1 Login

```
POST /admin/v1/auth/login
{ "username": "alice", "password": "..." }
→ 200
{ "token": "<jwt>", "expiresAt": 1716018000, "roles": ["admin"] }
```

JWT is HS256, signed with `JWT_SECRET` env var. Claims:
```json
{ "sub": "alice", "roles": ["admin"], "iat": ..., "exp": ... }
```
TTL: 8h. Refresh by re-login (no refresh-token flow in v1).

### 1.2 Logout

```
POST /admin/v1/auth/logout
Authorization: Bearer <jwt>
→ 204
```
Adds the JWT's `jti` to a revocation list (in-memory; cleared at TTL).

### 1.3 Roles

| Role | Capabilities |
|---|---|
| `admin` | Everything (operator CRUD, key rotation, kill switch, force-credit, manual rollback, settlement export, admin user mgmt) |
| `finance` | Read all financial endpoints; export settlements |
| `support` | Read rounds/bets/players; cannot mutate money or operators |
| `viewer` | Read-only across the board; no money detail |

Required role(s) appear in each endpoint's spec. `403` returned on insufficient role.

### 1.4 Standard headers

All requests:
```
Authorization: Bearer <jwt>
```

All responses:
```
X-Request-Id: <uuid>     # always set, useful for support tickets
Content-Type: application/json
```

---

## 2. Conventions

### 2.1 Pagination

List endpoints accept `?cursor=<opaque>&limit=<1..200>` (default 50).

Response:
```json
{
  "items": [...],
  "nextCursor": "eyJpZCI6IDEyMzQ1fQ==",   // null when no more
  "count": 50
}
```

Cursors are opaque (base64 JSON) and stable across page sizes within a query.

### 2.2 Timestamps

All timestamps in API are **unix seconds (integer)**, UTC. Clients format for display.

### 2.3 Money

Always integer **minor units** + `currency` string. Never decimal. See wallet spec §11.

### 2.4 Errors

```json
{
  "error": {
    "code":    "OPERATOR_NOT_FOUND",
    "message": "No operator with id 'acme'",
    "details": { "operatorId": "acme" }
  }
}
```

HTTP status codes:
- `400` validation errors
- `401` missing/invalid JWT
- `403` role insufficient
- `404` resource not found
- `409` conflict (duplicate, state-machine violation)
- `422` semantically invalid (e.g. trying to credit a bet that never debited)
- `500` server error
- `503` upstream wallet down (when operator action is needed)

---

## 3. Identity

### 3.1 `GET /admin/v1/me` — current admin
Roles: any
```json
{ "username": "alice", "roles": ["admin", "finance"], "lastLoginAt": 1715999000 }
```

### 3.2 `GET /admin/v1/admins` — list admins
Roles: `admin`
```json
{ "items": [{ "username": "alice", "roles": ["admin"], "createdAt": ..., "lastLoginAt": ... }], "nextCursor": null, "count": 1 }
```

### 3.3 `POST /admin/v1/admins` — create admin
Roles: `admin`
Request:
```json
{ "username": "bob", "password": "...", "roles": ["support"] }
```
Response 201: same shape as 3.2 entry.

### 3.4 `PATCH /admin/v1/admins/:username` — update roles / reset password
Roles: `admin`
```json
{ "roles": ["support", "finance"], "password": "..." }  // either or both
```

### 3.5 `DELETE /admin/v1/admins/:username`
Roles: `admin`. Cannot delete self.

---

## 4. Operators

### 4.1 `GET /admin/v1/operators`
Roles: any
Filters: `?status=active|paused|sandbox`, `?q=name-substring`, `?cursor=…`

Item:
```json
{
  "operatorId":      "acme",
  "name":            "Acme Casino",
  "walletBaseUrl":   "https://wallet.acme.com/v1",
  "adapter":         "native",
  "currencies":      ["EUR", "USD"],
  "minBetMinor":     10,
  "maxBetMinor":     500000,
  "rtpVariant":      97.0,
  "jurisdictions":   ["MT", "DE"],
  "status":          "active",
  "createdAt":       1700000000,
  "updatedAt":       1715000000
}
```

API key and signing key are **never** returned here.

### 4.2 `POST /admin/v1/operators`
Roles: `admin`

Request:
```json
{
  "operatorId":    "acme",         // slug, [a-z0-9-]{2,32}
  "name":          "Acme Casino",
  "walletBaseUrl": "https://wallet.acme.com/v1",
  "adapter":       "native",       // "native" | "softswiss"
  "currencies":    ["EUR", "USD"],
  "minBetMinor":   10,
  "maxBetMinor":   500000,
  "rtpVariant":    97.0,
  "jurisdictions": ["MT"],
  "status":        "sandbox"       // recommended initial
}
```

Response 201:
```json
{
  "operator": { ...as 4.1... },
  "credentials": {
    "apiKey":    "ak_live_018f...",          // shown once
    "signingKey": "base64-32-bytes-secret"   // shown once
  }
}
```
Audit row written with `actor=<jwt.sub>`, `action="operator.create"`.

### 4.3 `GET /admin/v1/operators/:id`
Roles: any. Returns the same shape as 4.1 item, plus:
```json
{
  "games": [
    { "gameId": "galaxy-crash", "enabled": true, "rtpVariant": 97.0 }
  ],
  "limits": {
    "EUR": { "minBetMinor": 10, "maxBetMinor": 500000 },
    "USD": { "minBetMinor": 10, "maxBetMinor": 500000 }
  }
}
```

### 4.4 `PATCH /admin/v1/operators/:id`
Roles: `admin`. Updateable fields: `name`, `walletBaseUrl`, `currencies`, `minBetMinor`, `maxBetMinor`, `rtpVariant`, `jurisdictions`, `adapter`. Cannot change `operatorId` or `status` (use dedicated endpoints).

### 4.5 `POST /admin/v1/operators/:id/regen-signing-key`
Roles: `admin`. Rotates the HMAC secret.
Response:
```json
{ "signingKey": "base64-32-bytes-secret", "rotatedAt": 1716000000 }
```
Old key is invalid immediately. Operator integration breaks until they pick up the new key — pause the operator first if you want graceful handoff.

### 4.6 `POST /admin/v1/operators/:id/pause`
Roles: `admin`. Sets `status=paused`. Effects:
- New launches return 503 with `OPERATOR_PAUSED`.
- In-flight rounds finish normally; new bets are refused.
Body optional: `{ "reason": "investigation" }` → recorded in audit.

### 4.7 `POST /admin/v1/operators/:id/resume`
Roles: `admin`. Returns to `status=active`.

### 4.8 `GET /admin/v1/operators/:id/credentials`
Roles: `admin`. **Only returns success once, immediately after 4.2 or 4.5.** Subsequent calls return:
```json
{ "error": { "code": "CREDENTIALS_NOT_VISIBLE", "message": "Use regen-signing-key to issue new credentials." } }
```
Implementation: a short-lived (60s) in-memory cache of credentials emitted from create/rotate.

### 4.9 `PATCH /admin/v1/operators/:id/games/:gameId`
Roles: `admin`. Per-operator game config.
```json
{ "enabled": true, "rtpVariant": 95.0, "minBetMinor": 25, "maxBetMinor": 1000000 }
```

---

## 5. Rounds

### 5.1 `GET /admin/v1/rounds`
Roles: any
Filters:
- `operatorId` (optional)
- `from`, `to` (unix seconds; default last 24h)
- `minMultiplier`, `maxMultiplier`
- `playerId` (operator-scoped: requires `operatorId`)
- `cursor`, `limit`

Item:
```json
{
  "roundId":        "rnd-2026-05-18-00193847",
  "operatorId":     "acme",
  "roundNumber":    193847,
  "crashPoint":     3.42,
  "betCount":       18,
  "totalStakeMinor":{ "EUR": 250000 },
  "totalPayoutMinor":{ "EUR": 412500 },
  "startedAt":      1716000000,
  "crashedAt":      1716000012,
  "serverSeedHash": "..."
}
```

### 5.2 `GET /admin/v1/rounds/:roundId`
Roles: any. Full detail:
```json
{
  "round": { ...as 5.1 plus... "serverSeed": "...", "clientSeedRef": "...", "rngFormulaVersion": "v1" },
  "bets":  [ { /* §6.1 bet item */ } ]
}
```
Reveals `serverSeed` (round is over). Support uses this to verify player disputes.

---

## 6. Bets

### 6.1 `GET /admin/v1/bets`
Roles: any
Filters: `operatorId`, `playerId`, `state`, `from`, `to`, `betId`, `txnId`, `cursor`, `limit`

Item:
```json
{
  "betId":           "bet-018f...-1",
  "operatorId":      "acme",
  "playerId":        "op-acme-pid-9183",
  "roundId":         "rnd-2026-05-18-00193847",
  "amountMinor":     10000,
  "currency":        "EUR",
  "state":           "SETTLED",
  "autoCashout":     2.0,
  "betTxnId":        "txn-...-a1",
  "winTxnId":        "txn-...-a2",
  "rollbackTxnId":   null,
  "winAmountMinor":  24500,
  "multiplier":      2.45,
  "errorCode":       null,
  "createdAt":       1716000010,
  "updatedAt":       1716000023
}
```

States: `PENDING | ARMED | FLYING | SETTLING | SETTLED | LOST | ROLLBACK_PENDING | VOIDED | WIN_FAILED`.

### 6.2 `GET /admin/v1/bets/:betId`
Roles: any. Includes full state-machine timeline:
```json
{
  "bet": { ...as 6.1... },
  "timeline": [
    { "state": "PENDING", "at": 1716000010, "actor": "system" },
    { "state": "ARMED",   "at": 1716000010, "actor": "system", "operatorTxnId": "op-tx-77182", "operatorLatencyMs": 87 },
    { "state": "SETTLING","at": 1716000023, "actor": "system" },
    { "state": "SETTLED", "at": 1716000023, "actor": "system", "operatorTxnId": "op-tx-77191", "operatorLatencyMs": 122 }
  ],
  "walletCalls": [
    { "kind": "bet",  "txnId": "txn-...-a1", "request": {...}, "response": {...}, "attempts": 1, "totalMs": 87 },
    { "kind": "win",  "txnId": "txn-...-a2", "request": {...}, "response": {...}, "attempts": 1, "totalMs": 122 }
  ]
}
```

### 6.3 `POST /admin/v1/bets/:betId/force-credit`
Roles: `admin`
Request:
```json
{ "reason": "operator confirmed receipt via email", "ticketRef": "ZD-12345" }
```
Effects: reissues `/win` once more (same txnId). On success → `SETTLED`. Otherwise stays `WIN_FAILED` with new attempt logged. Always writes an `admin_audit` row.

Errors:
- `409 BET_NOT_IN_FAILED_STATE` if bet isn't `WIN_FAILED`.

### 6.4 `POST /admin/v1/bets/:betId/manual-rollback`
Roles: `admin`. For the case where the operator denies a `/bet` debit but the round has already played out — voids locally + alerts. Returns the bet to `VOIDED`.

Errors:
- `409 BET_TERMINAL` if bet is `SETTLED` or `LOST` (already settled cleanly).

---

## 7. Transactions

### 7.1 `GET /admin/v1/transactions`
Roles: `finance`, `admin`
Filters: `operatorId`, `playerId`, `kind` (`bet|win|rollback`), `from`, `to`, `cursor`, `limit`

Item:
```json
{
  "txnId":          "txn-...-a2",
  "operatorId":     "acme",
  "operatorTxnId":  "op-tx-77191",
  "kind":           "win",
  "playerId":       "op-acme-pid-9183",
  "betId":          "bet-...-1",
  "amountMinor":    24500,
  "currency":       "EUR",
  "status":         "OK",        // OK | FAILED | NOOP
  "errorCode":      null,
  "attempts":       1,
  "totalMs":        122,
  "createdAt":      1716000023
}
```

---

## 8. Financial

### 8.1 `GET /admin/v1/financial/ggr`
Roles: `finance`, `admin`
Query: `?from=<unix>&to=<unix>&groupBy=operator,currency,day`

```json
{
  "from": 1715000000, "to": 1716000000,
  "groupBy": ["operator", "currency", "day"],
  "rows": [
    { "operatorId": "acme", "currency": "EUR", "day": "2026-05-17",
      "betCount": 1820, "stakeMinor": 18200000, "winMinor": 17654000,
      "ggrMinor": 546000, "ngrMinor": 546000 }
  ]
}
```
GGR = stake − win. NGR = GGR − bonuses (v1: bonuses always 0; field reserved).

### 8.2 `GET /admin/v1/financial/settlement?period=2026-04`
Roles: `finance`, `admin`. Generates a monthly settlement summary per operator per currency:
```json
{
  "period": "2026-04",
  "operators": [
    { "operatorId": "acme",
      "currencies": [
        { "currency": "EUR",
          "stakeMinor": 540000000, "winMinor": 524000000,
          "ggrMinor": 16000000, "shareBps": 1500,
          "ourShareMinor": 2400000 } ] } ]
}
```
`shareBps` is the contractual revenue share in basis points (default 1500 = 15%; set per operator at onboarding — extend operator schema in Phase 5 implementation).

### 8.3 `POST /admin/v1/financial/settlement/:period/invoice`
Roles: `finance`, `admin`
Request:
```json
{ "operatorId": "acme" }
```
Response: an invoice JSON (and audit row); intentionally machine-readable for export to accounting tooling.

---

## 9. Reconciliation

### 9.1 `GET /admin/v1/reconciliation/runs`
Roles: any
Filters: `operatorId`, `from`, `to`, `status` (`OK|MISMATCHES|FAILED`), `cursor`.

### 9.2 `GET /admin/v1/reconciliation/runs/:id`
Roles: any
```json
{
  "run": { "id": 42, "operatorId": "acme",
           "windowStart": 1715900000, "windowEnd": 1715986400,
           "checkedCount": 1820, "mismatchCount": 2, "status": "MISMATCHES" },
  "mismatches": [
    { "txnId": "txn-...-x9", "kind": "missing_on_operator",
      "details": { "ourAmountMinor": 5000, "operatorRecord": null } },
    { "txnId": "txn-...-y3", "kind": "amount_mismatch",
      "details": { "ours": 10000, "theirs": 9900 } }
  ]
}
```

### 9.3 `POST /admin/v1/reconciliation/runs`
Roles: `admin`
Request:
```json
{ "operatorId": "acme", "windowStart": 1715900000, "windowEnd": 1715986400 }
```
Triggers an on-demand run. Returns `202 Accepted` with the run id.

---

## 10. Health & metrics

### 10.1 `GET /admin/v1/health/summary?window=1h|24h`
Roles: any
```json
{
  "window": "1h",
  "operators": [
    { "operatorId": "acme",
      "walletCalls": 4218,
      "errorRate": 0.0021,
      "latencyP50Ms": 84, "latencyP95Ms": 220, "latencyP99Ms": 510 } ]
}
```

### 10.2 `GET /admin/v1/metrics`
Roles: any. Prometheus exposition format. Not JSON.

---

## 11. Games

### 11.1 `GET /admin/v1/games`
Roles: any
```json
{ "items": [
  { "gameId": "galaxy-crash", "name": "Galaxy Crash",
    "rtpVariants": [97.0, 95.0, 92.0],
    "themesAvailable": ["default", "neon", "retro"] } ] }
```

### 11.2 Per-operator-game config — see §4.9.

---

## 12. Audit log

### 12.1 `GET /admin/v1/audit`
Roles: `admin`
Filters: `actor`, `action`, `target`, `from`, `to`, `cursor`.
```json
{ "items": [
  { "id": 1234, "actor": "alice", "action": "operator.regen-signing-key",
    "target": "operator:acme", "payload": { "rotatedAt": 1716000000 },
    "at": 1716000000 } ] }
```

Audit is **append-only**; no delete endpoint.

---

## 13. OpenAPI

A machine-readable OpenAPI 3.1 document MUST be served at `GET /admin/v1/openapi.json` (public — no auth needed; reveals only endpoint shapes, not data). Hand-write or generate; either is fine.

---

## 14. Versioning

`/admin/v1/...` is stable. Breaking changes ship as `/admin/v2/...` and run in parallel for ≥ 6 months.
