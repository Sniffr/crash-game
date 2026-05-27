# Studio Backoffice REST API — v1

**Status:** Draft v1 · **Audience:** Internal (Galaxy Crash staff: admin, finance, support, ops) · **Date:** 2026-05-18

The "overall" backoffice. Cross-tenant control plane over operators, rounds, bets, money, and reconciliation. REST only — no UI. All routes are prefixed `/admin/v1`.

---

## 1. Auth & roles

> **Phase-4 interim auth (current):** Phase 4 ships a static `X-Admin-Token` header gate
> checked against the `ADMIN_API_TOKEN` environment variable. Integrators targeting the
> running Phase-4 server must send `X-Admin-Token: <secret>` on every request instead of
> `Authorization: Bearer <jwt>`. Phase 5.2 replaces this stub with the JWT flow described
> below in §1.1 and §1.2. Integrators planning ahead for Phase 5.2 should target the
> `/auth/login` JWT flow; the auth errors `INVALID_ADMIN_TOKEN` and `ADMIN_DISABLED`
> (Phase-4-only) are superseded by JWT-flow errors when Task 5.2 ships — all other
> endpoint error codes remain stable across both phases.

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

All timestamps in API are **unix seconds (integer)**, UTC. Clients format for display. Window filters are half-open: `from` is **inclusive**, `to` is **exclusive** (`created_at >= from AND created_at < to`) — consistent across all list endpoints and the financial report, so adjacent windows never double-count a boundary row.

### 2.3 Money

Always integer **minor units** + `currency` string. Never decimal. See wallet spec §11.

### 2.4 Errors

```json
{
  "error": {
    "code":    "OPERATOR_NOT_FOUND",
    "message": "No operator with id 'acme'"
  }
}
```

The shipped error envelope is `{ "error": { "code": "...", "message": "..." } }`. Extra
error-specific fields MAY be inlined into the error object by operator-originated error
responses (e.g. `balanceMinor` on an operator `INSUFFICIENT_FUNDS` reply that is
proxied through §6.3 as a 502). The `code` and `message` fields are always present.

HTTP status codes:
- `400` validation errors
- `401` missing/invalid auth credential (Phase 4: `INVALID_ADMIN_TOKEN`; Phase 5.2+: `INVALID_JWT`)
- `403` role insufficient
- `404` resource not found
- `409` conflict (duplicate, state-machine violation)
- `500` server error
- `502` upstream operator returned a permanent error (proxied WalletError)
- `503` upstream wallet down or admin API unconfigured

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

Item (all fields from `bet_log`; API uses camelCase):
```json
{
  "betId":           "bet-018f...-1",
  "operatorId":      "acme",
  "playerId":        "op-acme-pid-9183",
  "sessionId":       "sess-...",
  "roundId":         "rnd-2026-05-18-00193847",
  "currency":        "EUR",
  "amountMinor":     10000,
  "state":           "SETTLED",
  "betTxnId":        "txn-...-a1",
  "winTxnId":        "txn-...-a2",
  "rollbackTxnId":   null,
  "betOpTxnId":      "op-tx-77182",
  "winOpTxnId":      "op-tx-77191",
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

### 6.3 `POST /admin/v1/bet-log/:betId/force-credit`
Roles: `admin`

Every actionable invocation (steps 2 onward — after `reason` validation passes) writes
an immutable `admin_audit` row; see §12 Audit log for the schema and per-branch payload
shapes. The 400 `INVALID_REQUEST` path does **not** write an audit row (pre-validation;
the betId may not even exist — auditing every malformed request would pollute the log
with noise before any bet lookup).

Request body (`Content-Type: application/json`):
```json
{ "reason": "operator confirmed receipt via email" }
```
- `reason` — non-empty string, **required**. Written verbatim into the `admin_audit` row
  as the chain-of-custody note.

Effects: re-issues `/win` using the **original** `winTxnId` already persisted on the row
(Phase 2.2 outbound idempotency + operator §9 dedupe make this safe even if the operator
already credited). On success → row transitions `WIN_FAILED → SETTLED`. On operator
refusal → row stays `WIN_FAILED`; audit row written with `result: "failed"`.

**200 — success:**
```json
{
  "ok": true,
  "betId": "<betId>",
  "state": "SETTLED",
  "operatorTxnId": "<operator-assigned-transaction-id>"
}
```

**Error inventory:**

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | `reason` missing, not a string, or blank |
| 401 | `INVALID_ADMIN_TOKEN` | `X-Admin-Token` header missing, sent as an array, or value does not match `ADMIN_API_TOKEN` (Phase-4 stub; Task 5.2 replaces with JWT 401 `INVALID_JWT`) |
| 503 | `ADMIN_DISABLED` | `ADMIN_API_TOKEN` env var unset/empty — admin API fully disabled (Phase-4 stub only; absent in Phase 5.2 JWT flow) |
| 404 | `BET_NOT_FOUND` | No row exists for this `betId` |
| 409 | `BET_NOT_WIN_FAILED` | Row exists but is in a state other than `WIN_FAILED` |
| 409 | `BET_NOT_RECONSTRUCTIBLE` | `winTxnId`, `winAmountMinor`, or `multiplier` is NULL on the row — data-integrity event; see audit `missingFields` |
| 503 | `OPERATOR_UNAVAILABLE` | Operator's `WalletClient` not in the registry (operator paused or deleted) |
| 502 | _(WalletError code from operator)_ | Operator's `/win` endpoint returned a permanent error; row stays `WIN_FAILED` |
| 409 | `TRANSITION_FAILED` | Operator credited the player but `bet_log` row could not transition to `SETTLED` — data-integrity event; the player IS credited |
| 500 | `INTERNAL` | Unexpected server-side error |

> The Phase-4-only auth errors (`INVALID_ADMIN_TOKEN`, `ADMIN_DISABLED`) are replaced by
> the JWT-flow errors when Task 5.2 ships. All other error codes in this table are stable
> across Phase 4 and Phase 5.

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

### 9.4 Notes (shipped Phase-8.1)

**Run-status lifecycle.** Internally a run starts in `RUNNING` (transient — persisted briefly while the diff is in-flight so a crash leaves an observable row). On completion the row is updated to one of the three externally-visible terminal states:

- `OK` — checked > 0 (or = 0), no mismatches found.
- `MISMATCHES` — at least one mismatch row was written.
- `FAILED` — the operator-ledger source threw; the run resolves with this status rather than rethrowing, so a single bad operator feed cannot abort the daily sweep.

`RUNNING` is **not** part of the public enum and is filtered out of both `GET /reconciliation/runs` and `GET /reconciliation/runs/:id` (RUNNING rows return 404 as if not present).

**Mismatch kinds.** Each mismatch row has a `kind` and a `details` object whose shape depends on the kind:

| `kind`                 | When                                              | `details` shape                                            |
|------------------------|---------------------------------------------------|------------------------------------------------------------|
| `missing_on_operator`  | We recorded the txn; operator did not.            | `{ "ourAmountMinor": <int>, "operatorRecord": null }`      |
| `missing_on_game`      | Operator recorded the txn; we did not.            | `{ "theirAmountMinor": <int>, "ourRecord": null }`         |
| `amount_mismatch`      | Both sides have the txn; amounts differ.          | `{ "ours": <int>, "theirs": <int> }`                       |
| `status_mismatch`      | Both sides have the txn, amounts equal, status differs (`OK` vs `FAILED`). | `{ "ours": "OK"|"FAILED", "theirs": "OK"|"FAILED" }` |

`checkedCount` is the size of the distinct-txnId union (ours ∪ theirs); `mismatchCount` is the number of mismatch rows persisted.

**Half-open windows.** Both the reconciliation `[windowStart, windowEnd)` window and the `from`/`to` filter on `/reconciliation/runs` are half-open per §2.2 (`from` inclusive, `to` exclusive). The daily scheduler sweeps `[T − 86400, T)`.

**Synchronous v1, returns 202.** POST runs the diff synchronously in v1 (acceptable for low operator counts and the data volumes shipped) but still returns `202 Accepted` so the contract is forward-compatible with a future background-job implementation. The response body is `{ id, status, mismatchCount }`.

**Operator-ledger source = injected dependency.** The Reconciler does not embed any per-operator HTTP contract — it takes an `OperatorLedgerSource: (operatorId, windowStart, windowEnd) => Promise<OperatorLedgerTxn[]>` at construction. Wiring each operator's real reconciliation feed is Phase-future. Absent a configured source the server logs a one-shot warning at startup and wires a default that returns `[]`, so runs surface every one of our txns as `missing_on_operator` (non-fabricated honest default).

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

### 12.0 Schema

The `admin_audit` table stores an immutable record of every admin action.

| Column | Type | Notes |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Monotonically increasing row id |
| `actor` | `TEXT NOT NULL` | Who performed the action (Phase 4: `"admin-token"`; Phase 5.2+: JWT subject) |
| `action` | `TEXT NOT NULL` | Action name, e.g. `"force_credit"`, `"operator.create"`, `"operator.regen-signing-key"` |
| `target` | `TEXT NOT NULL` | Resource identifier, e.g. a `betId` or `"operator:acme"` |
| `payload_json` | `TEXT` | Nullable; JSON-serialised action payload (decoded to object in API responses) |
| `at` | `INTEGER NOT NULL` | Unix seconds timestamp |

Audit is **append-only**; there is no delete or update endpoint.

### 12.1 `GET /admin/v1/audit`
Roles: `admin`
Filters (query params): `?actor=`, `?action=`, `?target=`, `?from=` (unix s), `?to=` (unix s), `?cursor=`, `?limit=` (default 50, max 200).

Response:
```json
{
  "items": [
    { "id": 1234, "actor": "alice", "action": "operator.regen-signing-key",
      "target": "operator:acme", "payload": { "rotatedAt": 1716000000 },
      "at": 1716000000 }
  ],
  "nextCursor": null
}
```

### 12.2 Force-credit payload shapes

`admin_audit` rows written by `POST /admin/v1/bet-log/:betId/force-credit` have
`action = "force_credit"` and `target = <betId>`. The `payload` object varies by branch:

**Successful settlement (`result: "settled"`):**
```json
{ "reason": "<human note>", "result": "settled", "operatorTxnId": "<op-ref>", "balanceMinor": 1234500 }
```

**Operator refused credit (`result: "failed"`):**
```json
{ "reason": "<human note>", "result": "failed", "error": "<WalletError code>" }
```

**Data-integrity guard (`result: "not_reconstructible"`):**
```json
{ "reason": "<human note>", "result": "not_reconstructible", "missingFields": ["winTxnId", "winAmountMinor", "multiplier"] }
```
`missingFields` is an array containing only the field names that were NULL on the row
(one, two, or all three of `winTxnId`, `winAmountMinor`, `multiplier`).

**Bet not found (`result: "not_found"`):**
```json
{ "reason": "<human note>", "result": "not_found" }
```

**Wrong state (`result: "rejected_state"`):**
```json
{ "reason": "<human note>", "result": "rejected_state", "state": "<actual BetState>" }
```

**Operator client missing (`result: "operator_unavailable"`):**
```json
{ "reason": "<human note>", "result": "operator_unavailable", "operatorId": "<id>" }
```

**Transition error after operator credited (`result: "transition_error"`):**
```json
{ "reason": "<human note>", "result": "transition_error", "operatorTxnId": "<op-ref>" }
```
This is a data-integrity event: the player IS credited on the operator side but the
`bet_log` row did not move to `SETTLED`. The `operatorTxnId` confirms what was issued.

**Unexpected server error (`result: "internal_error"`):**
```json
{ "result": "internal_error" }
```
`reason` is absent on this branch (the error occurred before or outside the normal
action flow); check server logs for `[admin] force_credit: unexpected error:`.

> The 400 `INVALID_REQUEST` path does **not** write an audit row (pre-validation; see
> §6.3 for the full note).

---

## 13. OpenAPI

A machine-readable OpenAPI 3.1 document MUST be served at `GET /admin/v1/openapi.json` (public — no auth needed; reveals only endpoint shapes, not data). Hand-write or generate; either is fine.

---

## 14. Versioning

`/admin/v1/...` is stable. Breaking changes ship as `/admin/v2/...` and run in parallel for ≥ 6 months.
