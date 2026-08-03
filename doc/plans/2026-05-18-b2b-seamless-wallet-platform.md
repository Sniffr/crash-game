# B2B Seamless Wallet Platform — Implementation Plan

**Goal:** Convert Galaxy Crash from a single-tenant B2C demo into a multi-tenant B2B game provider that integrates into casino operators via iframe + seamless-wallet callbacks, with REST-only backoffice APIs for both the studio (us) and per-operator views.

**Architecture:** A new `@crash/wallet` package owns operator config, signed HTTP client, transaction log, and round state machine. The game server stops owning balances and instead round-trips every bet/win through the configured operator's wallet API. Two new HTTP surfaces — `/admin/*` (studio scope) and `/op/*` (operator scope) — are added to the existing Express server, each with its own auth. A new `@crash/adapters` package contains protocol shims so external aggregators (SoftSwiss first) can call our generic wallet API in their own dialect.

**Tech stack (unchanged where possible):** Node 20, TypeScript, Express, ws, RocksDB (existing) for hot session state, **new: SQLite via better-sqlite3** for the bet log / operator registry / audit (single-file, no infra, easy to back up; replaceable with Postgres later behind the same repository interface).

**Out of scope:** UI for either backoffice (REST only per user instruction), real money / payment rails (operator's domain), KYC/AML (operator's domain), license acquisition (legal track, parallel).

**Reference spec:** [`doc/specs/seamless-wallet-v1.md`](../specs/seamless-wallet-v1.md) — the public wallet contract this plan implements.

---

## How this plan is structured

Per user direction, tasks do **not** contain TDD code-per-step. Each task lists:
- **Files to add** (new path + one-line responsibility)
- **Files / specs to change** (existing path + surface area touched)
- **Verification** (what passing looks like — manual or automated)
- **Definition of done** (binary checklist)

Phases ship independently and produce working software. After Phase 4 you can run an end-to-end demo against the bundled operator stub. After Phase 7 you can hand the spec + sandbox URL to a real operator. After Phase 8 you can take production traffic.

---

## File inventory (the whole platform, before tasks)

### New packages

```
packages/
  wallet/                    ← NEW. Wallet client, signing, txn log, round state.
    src/
      types.ts               Public wallet types (Operator, BetTxn, WalletReceipt, error codes).
      operator-registry.ts   Load/CRUD operator records from SQLite.
      signing.ts             HMAC-SHA256 sign + verify per §4.2 of the spec.
      client.ts              Outbound HTTP client (timeouts, retries, idempotency, signed).
      bet-log.ts             Append-only persistence + state-machine transitions.
      state-machine.ts       Pure functions: legal transitions + invariants.
      reconciler.ts           Daily diff job (Phase 8).
      errors.ts              Typed error classes matching spec §7 codes.
    package.json
    tsconfig.json

  adapters/                  ← NEW. Aggregator dialect shims.
    src/
      types.ts               Adapter interface (canonical ⇄ dialect mapping).
      softswiss.ts           SoftSwiss/Hub88 dialect (Phase 7).
      registry.ts            operator.adapter = "softswiss" | "native" | …
    package.json
    tsconfig.json
```

### New top-level files

```
config/
  operators/                 ← NEW. Per-operator JSON config (signing key stored here OR env).
    EXAMPLE.json             Template + comments. Real operator files NOT checked in.

data/
  galaxy-crash.db            ← NEW. SQLite file (created at runtime; gitignored).

doc/
  specs/
    seamless-wallet-v1.md    ← already written
    studio-backoffice-v1.md  ← Phase 5 — REST API spec
    operator-backoffice-v1.md ← Phase 6 — REST API spec
  ops/
    runbooks/
      stuck-bet.md           ← Phase 4 — what to do when /win exhausts retries
      reconciliation-drift.md ← Phase 8

tools/
  operator-stub/             ← Phase 0. Local stub of the operator wallet API for dev.
    src/index.ts
    README.md
  wallet-conformance/        ← Phase 7. Test harness operators run against their staging.
    src/index.ts
    suite/*.yaml
    README.md
```

### Existing files modified

```
packages/server/src/
  index.ts                   Phase 1, 3, 4, 5, 6 — big surgery (split below).
  store.ts                   Phase 1 — balance-mutation functions become a cache layer.
  bots.ts                    No change (bots still self-settle).

packages/shared/src/
  types.ts                   Phase 1 — Bet gets `operatorId`, `txnId`, `currencyMinor`.
  config.ts                  Phase 1 — STARTING_BALANCE becomes per-operator default, not constant.

packages/client/src/
  App.tsx                    Phase 3 — launch flow reads query params, no localStorage balance.
  components/Header.tsx      Phase 3 — currency display, RG limits banner.
  components/BetControls.tsx Phase 4 — bet ID + txnId surfaced for support.

Dockerfile                   Phase 8 — multi-instance friendly, healthcheck.
README.md                    Each phase — append "Operator integration" section.
package.json (root)          Phase 0 — add @crash/wallet, @crash/adapters to workspaces.
```

### Splitting `packages/server/src/index.ts`

Currently 672 lines and growing. As part of Phase 1 it gets split:

```
packages/server/src/
  index.ts                   Bootstrap, env, app wiring (≤ 100 lines).
  http/
    public.ts                /api/health, /api/session, /launch, SPA fallback.
    admin.ts                 /admin/* studio backoffice (Phase 5).
    operator.ts              /op/* operator backoffice (Phase 6).
  game/
    round.ts                 Round loop, multiplier curve, crash scheduling.
    bets.ts                  Place-bet / cashout, calls into wallet package.
    history.ts               Round history ring buffer.
  ws/
    hub.ts                   WS connection mgmt, sessionSockets map.
    handlers.ts              Per-message-type handlers (hello, bet, cashout).
  theme/
    loader.ts                File watch + autoload (existing logic, extracted).
```

This split is one task inside Phase 1. Every later phase references the post-split paths.

---

# Phase 0 — Foundations

Lays plumbing without changing game behavior. Ships: a working operator stub + the wallet package skeleton.

## Task 0.1: Add `@crash/wallet` and `@crash/adapters` workspaces

**Files to add:**
- `packages/wallet/package.json` — name `@crash/wallet`, exports `./*` from `dist/`, deps on `better-sqlite3`, `nanoid`, `@crash/shared`.
- `packages/wallet/tsconfig.json` — extends root tsconfig.
- `packages/wallet/src/index.ts` — barrel export (empty for now).
- `packages/adapters/package.json` — name `@crash/adapters`, dep on `@crash/wallet`.
- `packages/adapters/tsconfig.json`
- `packages/adapters/src/index.ts`

**Files to modify:**
- `package.json` (root): `workspaces` array gains `packages/wallet`, `packages/adapters`.
- `packages/server/package.json`: add `@crash/wallet` and `@crash/adapters` to `dependencies`.
- `Dockerfile`: nothing changes structurally; `npm install` picks up new workspaces automatically.

**Verification:**
- `npm install` at root succeeds.
- `npx tsc -b` at root resolves both new packages.
- `npm run --workspace=packages/server build` still passes.

**Definition of done:** Both packages exist, build clean, are visible to the server package via `import '@crash/wallet'`.

---

## Task 0.2: Operator registry — schema + storage

**Files to add:**
- `packages/wallet/src/operator-registry.ts` — CRUD over the operator table.
- `packages/wallet/src/types.ts` — `Operator`, `OperatorCreate`, `OperatorUpdate` types.
- `data/.gitignore` (one-liner: `*`, keep dir).

**SQLite schema (created in `operator-registry.ts` on first connect):**

```sql
CREATE TABLE IF NOT EXISTS operators (
  operator_id      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  wallet_base_url  TEXT NOT NULL,
  api_key          TEXT NOT NULL UNIQUE,
  signing_key_b64  TEXT NOT NULL,            -- 32-byte secret base64
  adapter          TEXT NOT NULL DEFAULT 'native',  -- 'native' | 'softswiss' | ...
  currencies_json  TEXT NOT NULL,            -- JSON array
  min_bet_minor    INTEGER NOT NULL DEFAULT 10,
  max_bet_minor    INTEGER NOT NULL DEFAULT 500000,
  rtp_variant      REAL    NOT NULL DEFAULT 97.0,
  jurisdictions_json TEXT NOT NULL DEFAULT '[]',
  status           TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'sandbox'
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operators_api_key ON operators(api_key);
```

**Files to modify:**
- `packages/wallet/src/index.ts` — re-export the registry public API.

**Verification:**
- Unit tests in `packages/wallet/src/operator-registry.test.ts` (vitest): create / get / list / update / delete; api_key uniqueness raises typed error.
- Tests use an in-memory sqlite (`:memory:`) — no fixtures on disk.

**Definition of done:** Five test cases (create, get-by-id, get-by-api-key, list, update-status) pass.

---

## Task 0.3: Operator stub server

**Files to add:**
- `tools/operator-stub/package.json` — standalone Node app, port 4000.
- `tools/operator-stub/src/index.ts` — implements all six endpoints from spec §5 against an in-memory player ledger.
- `tools/operator-stub/README.md` — "how to run + what tokens it accepts".

**Behavior of the stub (documented in its README):**
- Pre-seeded with three players: `pid-1` (EUR 1000), `pid-2` (USD 1000), `pid-3` (BTC 0.01).
- Launch tokens `tok-pid-1` / `tok-pid-2` / `tok-pid-3` resolve to those players.
- Validates `X-Signature` against a hardcoded test key (printed at startup).
- Idempotency table in memory, keyed `(operatorId, txnId)`.
- A flag `STUB_FAIL_NEXT_WIN=1` env var to test retry behavior.

**Verification:**
- `node tools/operator-stub` starts; logs the test signing key.
- `curl -X POST localhost:4000/authenticate -H ... -d '{"token":"tok-pid-1"}'` returns a player.

**Definition of done:** Stub answers all six spec endpoints with happy-path responses and one configurable failure mode.

---

# Phase 1 — Wallet plumbing inside the game server

Replaces the in-game balance ledger with operator callbacks. After this phase the game can run end-to-end against the stub. Spec change: `Bet`, `Session`, history entries gain operator/transaction fields.

## Task 1.1: Signing primitive

**Files to add:**
- `packages/wallet/src/signing.ts` — `sign(method, path, ts, nonce, bodyBytes, key)` and `verify(...)` per spec §4.2.
- `packages/wallet/src/signing.test.ts` — known-vector tests (deterministic input → exact hex output, swapped chars fail, +301s timestamp fails, reused nonce fails when nonce-cache passed in).

**Verification:** Vitest suite passes. Cross-check one signature against a Python HMAC reference (manual smoke).

**Definition of done:** 6 test cases pass: happy, wrong-key, body-tamper, ts-skew, nonce-reuse, missing-header.

---

## Task 1.2: Bet log + state machine

**Files to add:**
- `packages/wallet/src/state-machine.ts` — pure enum + `nextState(current, event) → next | error`. States and transitions from spec §10.
- `packages/wallet/src/bet-log.ts` — SQLite-backed append-only log.

**SQLite schema:**

```sql
CREATE TABLE IF NOT EXISTS bet_log (
  bet_id        TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  round_id      TEXT NOT NULL,
  currency      TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  state         TEXT NOT NULL,             -- per §10
  bet_txn_id    TEXT NOT NULL UNIQUE,
  win_txn_id    TEXT,
  rollback_txn_id TEXT,
  bet_op_txn_id TEXT,                       -- operator's id, returned from /bet
  win_op_txn_id TEXT,
  win_amount_minor INTEGER,
  multiplier    REAL,
  error_code    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_betlog_round   ON bet_log(round_id);
CREATE INDEX IF NOT EXISTS idx_betlog_state   ON bet_log(state);
CREATE INDEX IF NOT EXISTS idx_betlog_player  ON bet_log(operator_id, player_id, created_at);

CREATE TABLE IF NOT EXISTS txn_idempotency (
  txn_id        TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- 'bet' | 'win' | 'rollback'
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

**Verification:**
- `packages/wallet/src/state-machine.test.ts`: every legal transition allowed; every illegal one throws.
- `packages/wallet/src/bet-log.test.ts`: insert PENDING → transition to ARMED → SETTLING → SETTLED; double-insert of bet_id rejected; query-by-state returns stragglers.

**Definition of done:** Both test files green; transitions match spec §10 exactly.

---

## Task 1.3: Wallet client — outbound HTTP with retries

**Files to add:**
- `packages/wallet/src/client.ts` — class `WalletClient(operator)` with methods `authenticate`, `balance`, `bet`, `win`, `rollback`, `roundEnd`. Uses `signing.ts`. Honors per-endpoint timeout/retry table from spec §8.
- `packages/wallet/src/errors.ts` — typed errors mapping spec §7 error codes.
- `packages/wallet/src/client.test.ts` — uses `msw` (mock service worker, node) to assert: signed headers present, retries on 5xx happen N times with backoff, idempotency means same txnId on retry sends same body, network-timeout produces retry, 409 INSUFFICIENT_FUNDS surfaces typed error and does NOT retry.

**Files to modify:**
- `packages/wallet/package.json`: add `msw` to devDependencies.

**Verification:** Test suite passes; backoff timings asserted (use vitest fake timers).

**Definition of done:** 8 test cases pass — happy, 5xx-retry-then-ok, 5xx-retry-exhaust, 409-no-retry, timeout-retry, signature-included, idempotency-on-retry, wrong-signature-from-operator-fails.

---

## Task 1.4: Split `packages/server/src/index.ts` into the layout from §"Splitting" above

**Files to add:**
- `packages/server/src/http/public.ts`
- `packages/server/src/game/round.ts`
- `packages/server/src/game/bets.ts`
- `packages/server/src/game/history.ts`
- `packages/server/src/ws/hub.ts`
- `packages/server/src/ws/handlers.ts`
- `packages/server/src/theme/loader.ts`

**Files to modify:**
- `packages/server/src/index.ts` — shrinks to bootstrap (env, app wiring, server.listen). ≤ 100 lines.
- `packages/server/src/store.ts` — `setBalance`/`adjustBalance` removed (balance now lives at operator); `recordBet`/`recordWin`/`recordLoss` retained only for **session-scoped stats display**, not for money.

**Verification:**
- `npm run build` clean.
- Smoke: start server, place a bet via WS against in-memory mock — round still works (no wallet wiring yet, mocked at the boundary).

**Definition of done:** All existing tests pass; no file in `packages/server/src/` exceeds 200 lines except generated/extracted ones.

---

## Task 1.5: Shared types gain operator/currency fields

**Files to modify:**
- `packages/shared/src/types.ts`:
  - `Bet` adds: `operatorId: string`, `betId: string`, `betTxnId: string`, `winTxnId?: string`, `currency: string`, `amountMinor: number`. The legacy `amount` (decimal) is retained as a derived getter for now but marked `@deprecated`.
  - `Session` adds: `operatorId: string`, `playerId: string`, `currency: string`, `balanceMinor: number`. The legacy `balance: number` becomes a derived view.
  - New: `RoundContext` carries `roundId: string`, `operatorId: string` for handlers.
- `packages/shared/src/config.ts`: `STARTING_BALANCE` constant deleted. Per-currency defaults now live in operator config.

**Verification:** Typecheck across all packages passes.

**Definition of done:** No reference to `STARTING_BALANCE` survives in the repo; grep is clean.

---

## Task 1.6: Wire `bets.ts` to call the wallet client

**Files to modify:**
- `packages/server/src/game/bets.ts`:
  - `placeBet(session, amountMinor, autoCashout)` now: (1) writes `bet_log` row PENDING → (2) calls `walletClient.bet(...)` → (3) on 200 transitions to ARMED → (4) on error rejects and surfaces the typed error to the WS client.
  - `cashOut(session, bet, multiplier)` now: SETTLING → `walletClient.win(...)` → SETTLED on success, with the spec's retry policy. On exhaustion, mark `WIN_FAILED` and emit an alert (Phase 8 hooks this to monitoring).
  - When the round crashes, all `ARMED` bets transition to `LOST` (no operator call — operator already debited).

**Files to add:**
- `packages/server/src/game/bets.test.ts` — integration test with the operator stub (Phase 0.3) running on a random port. Happy path + insufficient funds + win-retry-then-success.

**Verification:**
- Start operator stub on `localhost:4000`; configure a test operator; run vitest. All scenarios pass.

**Definition of done:** End-to-end bet → win + bet → crash works against the stub with operator's balance updated correctly.

---

## Task 1.7: Crash-recovery worker

**Files to add:**
- `packages/wallet/src/recovery.ts` — on server startup, scans `bet_log` for `PENDING | SETTLING | ROLLBACK_PENDING` rows and re-drives them through the appropriate wallet call.

**Files to modify:**
- `packages/server/src/index.ts` — invoke recovery before `server.listen`.

**Verification:**
- Manual: place a bet, `kill -9` the server mid-flight, restart, observe the bet either settles or rolls back. Document the test procedure in `doc/ops/runbooks/stuck-bet.md`.

**Definition of done:** No bet stays in a non-terminal state across a restart.

---

# Phase 2 — Operator authentication & idempotency

Hardens what Phase 1 wired up. After this phase, signatures and idempotency are enforced both directions; nothing else changes behaviorally.

## Task 2.1: Inbound signature verification middleware

**Files to add:**
- `packages/server/src/http/middleware/verify-operator-signature.ts` — Express middleware. Looks up operator by `X-API-Key`, verifies HMAC over the request, rejects 401 on failure. Mounted on `/op/*` (Phase 6) and `/launch` (Phase 3).

**Files to modify:**
- `packages/wallet/src/signing.ts` — exports a `NonceCache` LRU keyed by `(operatorId, nonce)` with 10-min TTL.

**Verification:**
- Unit tests around the middleware: missing header → 401; bad signature → 401; replayed nonce → 401; ok request → `req.operator` populated.

**Definition of done:** Middleware test suite green; mounted route can only be hit with a valid signature.

---

## Task 2.2: Outbound idempotency persistence

**Files to modify:**
- `packages/wallet/src/client.ts`: before issuing `bet`/`win`/`rollback`, insert `txn_idempotency` row with `request_hash`; on retry, re-use the same row (and same body). On terminal failure, persist response.

**Verification:**
- Test in `client.test.ts`: kill mid-retry, restart, retry re-uses same `txnId` and body.

**Definition of done:** Idempotency table never has divergent bodies for the same `txnId`.

---

# Phase 3 — Launch flow & iframe surface

After this phase, an operator can paste the launch URL into an iframe and a real player session boots against their wallet.

## Task 3.1: `/launch` endpoint

**Files to modify:**
- `packages/server/src/http/public.ts` — adds `GET /launch`:
  1. Extract `operator`, `token`, `currency`, `lang`, `lobby_url`, `return_url`, `jurisdiction`, `mode` from query.
  2. Look up operator; reject 404 if unknown or `status != 'active'`.
  3. Call `walletClient.authenticate({ token, ip, userAgent, gameId: 'galaxy-crash' })`.
  4. On success: mint a short-lived (TTL 8h) **iframe session token** keyed to `{ operatorId, playerId, currency, balanceMinor, displayName, rgLimits }`; redirect to `/?session=<iframe-token>&lobby=<lobby_url>&return=<return_url>`.
  5. On failure: render `views/launch-error.html` (also added) with the operator's lobby URL.
- `packages/server/src/store.ts` — `createSession` no longer takes `STARTING_BALANCE`; takes the authenticate response and stores it under the iframe token.

**Files to add:**
- `packages/server/src/views/launch-error.html` — static HTML, parameterized via simple `{{}}` replace.

**Verification:**
- Curl test: `/launch?operator=stub&token=tok-pid-1&currency=EUR` → 302 to `/?session=...`.
- Bad token → renders error page.

**Definition of done:** Launch flow works end-to-end against the stub; iframe boots showing operator-provided balance.

---

## Task 3.2: Client reads launch params, drops localStorage balance

**Files to modify:**
- `packages/client/src/App.tsx`:
  - On boot, read `session` from query string only (existing URL-token flow is reused).
  - Remove any `localStorage` reading of balance; balance is solely from server state.
  - Read `lobby` and `return` query params; expose as `lobbyUrl` / `returnUrl` props.
- `packages/client/src/components/Header.tsx`: show currency symbol + balance in operator-supplied currency; add "Lobby" button (if `lobbyUrl`) that calls `window.parent.postMessage({ type: 'lobby' }, '*')` AND falls back to `window.top.location = lobbyUrl`.
- `packages/client/src/components/BetControls.tsx`: enforce per-operator `min/maxBetMinor` (from session payload) on the UI.

**Verification:**
- Open `/launch?...` in a real iframe (inside a tiny dev parent page added to `tools/operator-stub/public/parent.html` — a 30-line embed harness). Bet, cash out, watch operator stub balance change.

**Definition of done:** Manual iframe smoke passes; no localStorage write of balance anywhere (grep clean).

---

## Task 3.3: Session terminate endpoint

**Files to modify:**
- `packages/server/src/http/operator.ts` (created in Phase 6 but the route lives here) — `POST /op/v1/sessions/:sessionId/terminate` per spec §6.3.

For Phase 3, mount a stub of this endpoint (signature-verified) that closes the WS and voids any in-flight bet. The full operator backoffice lands in Phase 6.

**Verification:** Operator stub POSTs terminate → iframe shows "Session closed by operator" and WS disconnects.

**Definition of done:** Self-exclusion path works.

---

# Phase 4 — Round settlement hardening

After this phase, the dangerous paths (`/win` failures, rollback, force-credit) are handled and runbooked.

## Task 4.1: Win-retry queue + alerting hook

**Files to modify:**
- `packages/wallet/src/client.ts` — when `/win` exhausts retries, mark `WIN_FAILED` and emit an event to a pluggable `Alerter` interface (default: structured log to stderr).

**Files to add:**
- `packages/wallet/src/alerter.ts` — `Alerter` interface + `ConsoleAlerter` default. Phase 8 swaps in Sentry/PagerDuty.

**Verification:**
- Force the stub to fail `/win` indefinitely; bet stays `WIN_FAILED`; an alert event fires.

**Definition of done:** WIN_FAILED is detectable and observable.

---

## Task 4.2: Force-credit admin operation

**Files to modify:**
- `packages/server/src/http/admin.ts` (Phase 5 file, stub in this phase) — `POST /admin/v1/bet-log/:betId/force-credit` body `{ reason: string }`. Calls `/win` once more with the original txnId; if it succeeds, marks SETTLED; otherwise records the operator response and stays WIN_FAILED. Writes a row to a new `admin_audit` table.

**SQLite schema:**

```sql
CREATE TABLE IF NOT EXISTS admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  payload_json TEXT,
  at           INTEGER NOT NULL
);
```

**Verification:** Integration test: force-fail `/win`; call force-credit while stub is now happy; bet ends SETTLED; audit row exists.

**Definition of done:** A stuck bet can be unstuck without DB surgery, and there's an audit trail.

---

## Task 4.3: Runbook docs

**Files to add:**
- `doc/ops/runbooks/stuck-bet.md` — symptoms, diagnosis, `force-credit` walk-through, when to escalate.
- `doc/ops/runbooks/reconciliation-drift.md` — placeholder; filled in Phase 8.

**Verification:** Linkcheck (manual).

**Definition of done:** Ops can resolve a stuck bet by reading the runbook.

---

# Phase 5 — Studio backoffice REST API

The "overall" backoffice. **REST only**, per user instruction.

## Task 5.1: Write the studio backoffice spec

**File to add:** `doc/specs/studio-backoffice-v1.md` — full OpenAPI-style spec covering every endpoint below. Auth: bearer JWT issued by a single internal `POST /admin/v1/auth/login` against a hashed-password store (bcrypt). Roles: `admin`, `finance`, `support`, `viewer`. Each endpoint declares required roles.

**Endpoint inventory (REST, prefix `/admin/v1`):**

| Method | Path | Purpose | Roles |
|---|---|---|---|
| POST | `/auth/login` | Issue JWT | (public) |
| POST | `/auth/logout` | Revoke | any |
| GET | `/me` | Current admin profile | any |
| GET | `/operators` | List operators | any |
| POST | `/operators` | Create operator | admin |
| GET | `/operators/:id` | Fetch one | any |
| PATCH | `/operators/:id` | Update name, urls, limits, currencies, status | admin |
| POST | `/operators/:id/regen-signing-key` | Rotate signing key | admin |
| POST | `/operators/:id/pause` | Kill switch | admin |
| POST | `/operators/:id/resume` | Re-enable | admin |
| GET | `/operators/:id/credentials` | Show api_key + signing key once (post-creation) | admin |
| GET | `/rounds` | List rounds with filters: `operatorId`, `from`, `to`, `cursor`, `minMultiplier`, `maxMultiplier` | any |
| GET | `/rounds/:roundId` | Full round detail incl. seeds, bets, settlements | any |
| GET | `/bets` | List bets, filterable by `operatorId`, `playerId`, `state`, `from`, `to` | any |
| GET | `/bets/:betId` | Single bet incl. full state-machine timeline + operator receipts | any |
| POST | `/bets/:betId/force-credit` | Phase 4.2 | admin |
| POST | `/bets/:betId/manual-rollback` | Operator absent, void the bet locally + alert | admin |
| GET | `/transactions` | List wallet txns (debit/credit/rollback) | finance, admin |
| GET | `/financial/ggr` | GGR/NGR by operator/currency/day | finance, admin |
| GET | `/financial/settlement` | Generate settlement summary for a period | finance, admin |
| POST | `/financial/settlement/:id/invoice` | Generate invoice JSON for export | finance, admin |
| GET | `/reconciliation/runs` | List reconciliation runs (Phase 8) | any |
| GET | `/reconciliation/runs/:id` | Mismatch detail | any |
| POST | `/reconciliation/runs` | Trigger run on demand | admin |
| GET | `/health/summary` | Per-operator latency + error rate (last 1h/24h) | any |
| GET | `/audit` | Page admin_audit | admin |
| GET | `/games` | List games + RTP variants | any |
| PATCH | `/operators/:id/games/:gameId` | Enable/disable game per operator, set RTP variant | admin |

**Verification:** Spec doc passes a manual self-review; every endpoint has request/response/error shapes documented; auth role required is stated; pagination convention documented (`?cursor=…&limit=…`, response `{ items, nextCursor }`).

**Definition of done:** Spec doc complete, linked from README, reviewed (self).

---

## Task 5.2: Implement auth, operator CRUD, credentials

**Files to add:**
- `packages/server/src/http/admin.ts` — the router. Already created stub in Phase 4.2; this task fleshes it.
- `packages/server/src/http/middleware/admin-auth.ts` — JWT verify + role guard.
- `packages/server/src/admin/admin-store.ts` — admin user table.

**SQLite schema:**

```sql
CREATE TABLE IF NOT EXISTS admins (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  roles_json    TEXT NOT NULL,    -- JSON array of role strings
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
```

Bootstrap admin via env `ADMIN_BOOTSTRAP_USER=user:pass:admin` on first start.

**Verification:** Postman/curl: login, create operator, fetch credentials, pause, list. Audit rows written.

**Definition of done:** All ten "operator" endpoints from Task 5.1 work.

---

## Task 5.3: Implement rounds/bets/transactions read API

**Files to modify:**
- `packages/server/src/http/admin.ts` — add the read endpoints from Task 5.1.
- `packages/wallet/src/bet-log.ts` — add cursor-paginated query helpers.

**Verification:** Generate 100 fake bets via stub harness; paginate, filter by state, by operator. Result shapes match spec.

**Definition of done:** Filters and pagination work as specified; queries use indexes (verify with `EXPLAIN QUERY PLAN`).

---

## Task 5.4: Financial endpoints

**Files to modify:**
- `packages/server/src/http/admin.ts` — `/financial/ggr`, `/financial/settlement`, settlement invoice.
- `packages/wallet/src/bet-log.ts` — aggregation helpers (`sumBetsByOperatorCurrencyDay`, etc.).

**Verification:** GGR formula `sum(bets) − sum(wins)` over a known fixture matches expected; NGR subtracts bonuses (placeholder, zero for now). Multi-currency settlements list each currency separately.

**Definition of done:** Finance role can pull a JSON suitable for invoicing.

---

# Phase 6 — Operator backoffice REST API

What we expose to each casino. Scoped to that operator only.

## Task 6.1: Write the operator backoffice spec

**File to add:** `doc/specs/operator-backoffice-v1.md`. Auth: same signature scheme as wallet calls (§4.2 of wallet spec) — operators reuse the same credentials. Tenant scope enforced by `req.operator.operatorId`.

**Endpoint inventory (prefix `/op/v1`):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Public; spec §6.1 |
| GET | `/games` | Spec §6.2 |
| GET | `/rounds/:roundId` | Spec §6.4 (scoped: 404 if not this operator) |
| GET | `/transactions` | Spec §6.5 |
| POST | `/sessions/:sessionId/terminate` | Spec §6.3 |
| GET | `/players/:playerId/sessions` | List a player's sessions in our system |
| GET | `/players/:playerId/bets` | This player's bets, paginated |
| GET | `/financial/summary?from=…&to=…` | Operator's own GGR/NGR/round count |
| GET | `/operator-tx?from=…&to=…` | Operator queries our records for reconciliation |
| POST | `/limits` | Update min/maxBet per currency (within studio-allowed bounds) |

**Verification:** Spec written; cross-references between wallet spec §6 endpoints and these are correct.

**Definition of done:** Operator-facing doc explains every endpoint, including the auth scheme (linking to wallet spec §4.2), with request/response/error examples.

---

## Task 6.2: Implement `/op/*` router + tenant guard

**Files to add:**
- `packages/server/src/http/operator.ts` — the router.
- `packages/server/src/http/middleware/tenant-scope.ts` — asserts every query/path filter is constrained by `req.operator.operatorId`; refuses if missing.

**Files to modify:**
- `packages/server/src/index.ts` — mount the router with `verifyOperatorSignature` then `tenantScope`.

**Verification:** Authenticate as operator A; try to fetch operator B's round → 404. List bets → only operator A's appear.

**Definition of done:** Cross-tenant access is impossible by construction.

---

## Task 6.3: Read endpoints

**Files to modify:**
- `packages/server/src/http/operator.ts` — implement `/rounds`, `/transactions`, `/players/*`, `/financial/summary`, `/operator-tx`.

**Verification:** Curl-driven smoke. `/operator-tx` returns the same fields the spec §12 of wallet spec promises for reconciliation.

**Definition of done:** Operator can run a daily reconciliation diff against `/operator-tx`.

---

## Task 6.4: Mutating endpoints (`limits`, `terminate`)

**Files to modify:**
- `packages/server/src/http/operator.ts`:
  - `POST /limits` — patches operator's min/maxBet, bounded by studio-set ceilings (in operator config).
  - `POST /sessions/:sessionId/terminate` — moves the in-flight bet (if any) to ROLLBACK_PENDING, closes WS, posts a `session_terminated` event.

**Durable terminate requirement (owns the Phase 3.3 stub gap):** The Phase 3.3 stub closes the WS and voids in-flight bets but does NOT invalidate the session in the store, so a self-excluded player can refresh and reconnect with the same `?session=` token. Task 6.4 MUST fix this durably: `terminate` must delete or mark the session as `terminated` in the session store so that any subsequent WS `hello` or HTTP session lookup returns `session_invalid`. This makes RG self-exclusion durable across refresh/reconnect — closing the socket alone is insufficient (refresh-defeatable).

**Verification:** Self-exclusion smoke; limit change reflected on next bet attempt; after terminate, player refreshes with same `?session=` → WS `hello` returns `session_invalid` frame and no reconnect is possible.

**Definition of done:** Operator can enforce RG actions in real time. Terminate invalidates the session in the store (delete or mark `terminated`) so a reconnect/refresh with the same `?session=` is rejected (server `hello` returns `session_invalid`); closing the socket alone is insufficient (Phase 3.3 stub was refresh-defeatable — this task makes RG self-exclusion durable).

---

# Phase 7 — Aggregator adapter (SoftSwiss)

Most casinos run on aggregators. One adapter unlocks dozens of casinos.

## Task 7.1: Adapter interface

**Files to add:**
- `packages/adapters/src/types.ts` — `interface WalletAdapter` with method-for-method mappings from our canonical `WalletClient` calls into the foreign protocol; takes the canonical request/response in our shape, emits its own.
- `packages/adapters/src/registry.ts` — picks adapter by `operator.adapter`.

**Files to modify:**
- `packages/wallet/src/client.ts` — when `operator.adapter !== 'native'`, route through the adapter registry instead of calling our spec directly.

**Verification:** Unit test with a fake adapter that uppercases keys — confirms wiring.

**Definition of done:** Adapter layer exists, optional, default `native`.

---

## Task 7.2: SoftSwiss adapter

**Files to add:**
- `packages/adapters/src/softswiss.ts` — implements `WalletAdapter` for SoftSwiss's protocol (their `/bet`/`/win`/`/rollback` shapes; their signature scheme — typically `Signature` header over JSON body with SHA-1 + key).
- `packages/adapters/src/softswiss.test.ts` — vector tests against published SoftSwiss examples.
- `doc/integrations/softswiss.md` — operator-facing setup guide.

**Verification:** Conformance harness (Task 7.3) passes with `adapter: 'softswiss'` against a SoftSwiss-format stub.

**Definition of done:** A SoftSwiss-using operator could be onboarded by setting `adapter: 'softswiss'` in their operator record.

---

## Task 7.3: Wallet conformance harness

**Files to add:**
- `tools/wallet-conformance/package.json`
- `tools/wallet-conformance/src/index.ts` — runs the suite against any base URL + signing key.
- `tools/wallet-conformance/suite/*.yaml` — declarative test cases: name, request, expected response, expected side-effects.
- `tools/wallet-conformance/README.md`

**Verification:** Run against operator stub → all pass. Run against operator stub with `STUB_FAIL_NEXT_WIN=1` → win-retry case asserts the retry happened.

**Definition of done:** A new operator can hand-prove integration correctness in one command.

---

# Phase 8 — Reconciliation, observability, prod hardening

The "would I bet a customer relationship on this?" pass.

## Task 8.1: Reconciliation worker

**Files to add:**
- `packages/wallet/src/reconciler.ts` — for each active operator, fetch their `/operator-tx?from=T-24h&to=T`, diff against our `bet_log`, write rows to `reconciliation_runs` and `reconciliation_mismatches`. Scheduled at 00:15 UTC; also exposed via `POST /admin/v1/reconciliation/runs` (Task 5.1).

**SQLite schema:**

```sql
CREATE TABLE reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  checked_count INTEGER NOT NULL,
  mismatch_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE reconciliation_mismatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES reconciliation_runs(id),
  txn_id TEXT NOT NULL,
  kind TEXT NOT NULL,  -- missing_on_operator | missing_on_game | amount_mismatch | status_mismatch
  details_json TEXT NOT NULL
);
```

**Verification:** Seed an intentional mismatch (delete a row on the stub); run reconciler; mismatch row created and visible via `/admin/v1/reconciliation/runs/:id`.

**Definition of done:** Drift is detectable within 24h.

---

## Task 8.2: Metrics + structured logging

**Files to add:**
- `packages/server/src/observability/metrics.ts` — counters & histograms for: wallet calls per operator per endpoint, latency p50/p95/p99, error codes, bets/sec, rounds/sec.
- `packages/server/src/observability/logger.ts` — pino-based structured JSON logger.

**Files to modify:**
- Every wallet call site → wraps with `metrics.observe('wallet.bet', ...)`.
- Replace `console.log` with `logger` (lint rule added).

**Verification:** Scrape `/admin/v1/metrics` (Prometheus exposition format); confirm counters increment under load.

**Definition of done:** Metrics surface exists and increments on traffic; runbooks reference specific metric names.

---

## Task 8.3: Production-readiness in the Dockerfile

**Files to modify:**
- `Dockerfile` — add `HEALTHCHECK CMD curl -fsS http://localhost:3001/api/health || exit 1`. Bump base image hashes. Add `LABEL` for org.opencontainers.
- `README.md` — "Production deployment" section (env vars: `ADMIN_BOOTSTRAP_USER`, `DB_PATH`, `JWT_SECRET`, `LOG_LEVEL`; reverse-proxy notes for WS sticky sessions; backup commands for the SQLite db).

**Verification:** `docker build` clean; `docker run` → `/api/health` returns 200; `docker inspect` shows healthcheck.

**Definition of done:** Image is shippable to Fly/Render/Railway as-is.

---

# Cross-cutting: tests, CI, security review

These run continuously, not as a single phase.

- Every new module ships a `*.test.ts` in vitest.
- Conformance harness runs in CI against the bundled stub on every PR.
- Secret scanning: pre-commit hook rejecting any base64 that decodes to 32 bytes (likely a signing key) outside `config/operators/EXAMPLE.json`.
- Manual security review of: signing implementation, idempotency keying, tenant-scope middleware, JWT verification path. Add `doc/security/review-checklist.md` (Phase 5 deliverable bonus).

---

# Self-review

**1. Spec coverage:**
- Spec §3 (Launch) → Task 3.1 ✓
- §4 (Auth/signing) → Tasks 1.1, 2.1 ✓
- §5.1–5.6 (Wallet endpoints) → Tasks 1.3, 1.6 ✓
- §6 (Game-exposed endpoints) → Tasks 6.1–6.4 ✓
- §7 (Errors) → Task 1.3 (errors.ts) ✓
- §8 (Retry policy) → Task 1.3 ✓
- §9 (Idempotency) → Tasks 1.2, 2.2 ✓
- §10 (State machine) → Tasks 1.2, 1.6 ✓
- §11 (Currencies) → Tasks 1.5, 6.4 ✓
- §12 (Reconciliation) → Task 8.1 ✓
- §13 (Sandbox + conformance) → Tasks 0.3, 7.3 ✓
- §14 (Versioning) → Captured in REST path prefix `/v1`; documented in operator-backoffice spec (Task 6.1) ✓

**2. Placeholder scan:** No TBDs in task bodies. Verification clauses are concrete (specific test names, specific commands, specific endpoints). Phase boundaries each end in shippable state.

**3. Type consistency:**
- `betTxnId` / `winTxnId` / `rollbackTxnId` names consistent across types.ts (Task 1.5), bet_log schema (Task 1.2), wallet spec §5.
- `operatorId` (snake-case in SQL, camelCase in TS) — convention consistent.
- `amountMinor` is integer everywhere — never `amount` (decimal) on the money path.
- `RTP variants` declared in spec §6.2 and surfaced via Task 5.1 endpoint `/operators/:id/games/:gameId` (PATCH).

**4. Independent ship points:**
- After Phase 1.6 you can demo bet → win against the bundled stub.
- After Phase 4 you can survive an operator outage cleanly.
- After Phase 5 you can run a back-office team via curl/Postman.
- After Phase 6 a casino can self-serve their reconciliation.
- After Phase 7 you can sign your first aggregator deal.
- After Phase 8 you can take production traffic.

---

# Suggested execution order vs. parallelism

- Phase 0 must complete first (foundations).
- Phase 1 is serial inside itself, but tasks 1.1, 1.2, 1.3 can run in parallel (no inter-dependencies).
- Phase 2 depends on 1.3 only.
- Phase 3 depends on 1.6.
- Phase 4 depends on 1.6 + 1.7.
- Phase 5 depends on 1.5 (types) and 1.6 (bet log populated).
- Phase 6 depends on 2.1 (signature middleware) and 1.6.
- Phase 7 can start once 1.3 is done — runs alongside Phases 4–6.
- Phase 8 needs 5.1 (admin endpoints) for triggering recon, 6.3 (`/operator-tx`) for fetching operator data.

A team of three could compress this to ~12 weeks: one on game/wallet (Phases 0–4), one on backoffice (Phases 5–6), one on adapters + observability (Phases 7–8).
