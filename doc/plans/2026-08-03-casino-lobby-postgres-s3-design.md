# Casino Lobby + Postgres + Contabo S3 — Design

**Date:** 2026-08-03 · **Status:** Approved, Wave A in progress · **Builds on:** the multi-game catalogue ([2026-07-24](2026-07-24-multi-game-catalogue-design.md))

**Goal:** A personal casino lobby where I can see my games, launch them in **demo** or **real money**, with game definitions + assets stored durably (Postgres + Contabo S3) and published from the Creator studio. This runs **alongside** the existing B2B seamless-wallet path, which stays independent.

---

## 1. Two surfaces, one catalogue

```
                 ┌──────────── Postgres  (db "casino", user "casino") ───────────┐
                 │  games · game_assets · players · wallet_ledger                │
                 │  (Wave B adds: operators · bet_log · idempotency · admin …)   │
                 └───────▲──────────────────────────────────────▲────────────────┘
                         │                                       │
  PERSONAL LOBBY         │            one games catalogue        │   B2B SEAMLESS WALLET
  (our players/wallet)   │            both surfaces read         │   (operator's players/wallet)
                         │                                       │
  /            lobby grid                                        /launch?operator&game&token
  /play?game=X&mode=demo|real ─┐                          iframe → operator wallet callbacks
       demo → ephemeral        │                          debits operator over signed HTTP
       real → crash wallet ────┘                          (UNCHANGED from today)
```

The two launch paths **never share money code**. `/play` debits our Postgres `wallet_ledger`; `/launch` debits the operator's wallet exactly as today. They share only the **games catalogue**.

## 2. Data store — dedicated Postgres

- Dedicated database `casino` owned by a dedicated role `casino` (isolated from the shared `odibets_tokens` in the same server). Default `public` schema.
- Connection: `DATABASE_URL=postgresql://casino:<pw>@62.171.137.101:5432/casino`, read from a git-ignored `.env`.
- Access via a single `pg.Pool`. Schema bootstrapped idempotently (`CREATE TABLE IF NOT EXISTS`) on boot — same "no migration framework" stance the SQLite code already uses.

**Sync → async:** `better-sqlite3` is synchronous; `pg` is async. Repos become `async`, and the round loop (a synchronous hot timer) reads an **in-memory games snapshot** refreshed from Postgres, so the tick never awaits.

### Wave A tables (`public` schema)

```sql
games (
  game_id text primary key, name text not null, game_type text not null,   -- 'sprite'|'gif'
  rtp real not null,                          -- fraction (0,1]
  theme_json jsonb not null,                  -- Creator theme WITHOUT heavy binaries (URLs instead)
  status text not null default 'active',      -- 'active'|'archived'
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
)
game_assets (                                 -- one row per uploaded binary, S3-backed
  game_id text not null references games(game_id) on delete cascade,
  asset_key text not null,                    -- 'gif.loading','sprite.flying','sound.crash',…
  url text not null,                          -- public Contabo URL
  content_type text, bytes int, updated_at timestamptz not null default now(),
  primary key (game_id, asset_key)
)
players (
  player_id uuid primary key default gen_random_uuid(),
  username text unique not null, password_hash text not null,
  created_at timestamptz not null default now()
)
wallet_ledger (                               -- append-only; balance = sum(amount_minor)
  id bigserial primary key,
  player_id uuid not null references players(player_id),
  currency text not null default 'USD',
  amount_minor bigint not null,               -- +credit / -debit
  kind text not null,                         -- 'deposit'|'bet'|'win'|'adjust'
  ref text,                                   -- round/bet reference
  created_at timestamptz not null default now()
)
```

Real-money balance is `sum(amount_minor)` per player/currency; a bet inserts a negative row, a win a positive row, all in one transaction. Demo mode never touches this table.

## 3. Assets — Contabo S3

- Bucket `crash` at endpoint `https://eu2.contabostorage.com`; public read enabled.
- Public URL base: `https://eu2.contabostorage.com/b418dbb4d7c942e5b311c172a41d1db8:crash/<key>`.
- Creator **Publish** extracts each heavy asset (gif/sprite/background/logo/audio) from the theme, uploads to `games/<gameId>/<assetKey>` via `@aws-sdk/client-s3`, and stores the resulting public URL in `game_assets` + the theme JSON keeps only URLs. The browser fetches assets straight from Contabo (no server bandwidth).
- Keys/creds (access key, secret) live in `.env`; docs use placeholders.

## 4. Lobby + player wallet

- `/` = **lobby**: grid from `GET /api/games` (thumbnail, name, RTP, type). Each card has **Demo** and **Real**.
- **Demo** → `/play?game=X&mode=demo`: ephemeral balance (today's demo session), nothing persisted.
- **Real** → requires player login (`crash.players`, username+password, bcrypt). Balance from `wallet_ledger`. Bets debit/credit for keeps in one transaction. Deposits = a self/admin **top-up stub** (no payment provider yet).
- `/play` = today's game client, parameterised by `game` + `mode`.
- Lobby + player endpoints live in a **new** `packages/server/src/http/lobby.ts` router (keeps them off the B2B admin/operator routers).

## 5. Sessions

Hot player session state stays in **RocksDB** (ephemeral cache, not money) for Wave A. Moving it to Postgres is deferred — revisit in Wave B if needed.

## 6. Phasing

- **Wave A (done, live):** `games`+`game_assets`+`players`+`wallet_ledger` on Postgres; Creator uploads assets to S3; lobby + demo/real launch; games catalogue migrated SQLite→PG (async + snapshot).
- **Wave B (done):** ported `bet_log`, `operators`, `admin`, `idempotency`, `reconciliation` SQLite→Postgres. The entire platform now runs on the `casino` Postgres DB; SQLite is gone (RocksDB kept only for hot session cache).

### Wave B progress

- **pt1 (done, wired, live):** `PgOperatorRegistry` — Postgres-backed with an in-memory read cache (sync reads on hot paths, async writes + refresh). Wired into prod (`index.ts`, admin, operator, signature middleware, `WalletClientCache` via the `OperatorReader` interface). Live-verified: create operator → Postgres → served from cache. Reusable PG test harness added (`pg-test-support.ts` → isolated schema per test file on a local `crash-test-pg` docker container).
- **pt2 (done, tested — NOT yet wired to prod):** `PgBetLog` (full async port of the 1179-line ledger incl. FOR-UPDATE state-machine transition, idempotency, keyset lists, GGR/NGR report), `PgAdminAudit`/`PgAdminUsers`, `PgOperatorAudit`. 30 integration tests against real Postgres.
- **pt3 (done):** the prod cut-over — the whole B2B ledger now runs on Postgres and `better-sqlite3` is gone.
  - **pt3a:** swapped `index.ts` to the Pg repos + `PgReconciler`; every `betLog`/`adminUsers`/`reconciler` call site converted to `await`, driven exhaustively by the TypeScript compiler (retyping consumers to the async repos made tsc flag every un-awaited call — a Promise misused as a value — so no missing `await` can hide on a result-using path). Fire-and-forget writes (idempotency, OPERATOR_PAUSED transitions) awaited explicitly. Live-verified against the real casino DB.
  - **pt3b:** converted all 17 money-path test files from SQLite doubles to real Postgres via `makeTestDb()` (per-test isolated schema), so the async wiring is genuinely test-validated. Deleted the SQLite repo classes (BetLog, OperatorRegistry, GamesRepo, Reconciler, AdminAudit, AdminUsers, OperatorAudit) — keeping their shared types/errors — and removed `better-sqlite3` from both package.json files + the lockfile.

**Safety gate (how pt3 was made safe):** the SQLite-double unit tests could not catch a missing `await` on the async `PgBetLog` (await on a sync value still runs). So the cut-over relied on two things instead: (1) the TypeScript compiler flagging every un-awaited result-using call once consumers were retyped to the async repos, and (2) converting the money-path tests to real Postgres so the async path is exercised for real. RocksDB remains the only on-disk store (hot session cache — not money).

## 7. Definition of done (Wave A)

- Server boots against the `casino` DB; `games`/`game_assets`/`players`/`wallet_ledger` created.
- Creator Publish uploads assets to S3 and creates a game whose assets are public URLs.
- Lobby lists games; **Demo** launches ephemeral play; **Real** requires login and debits/credits `wallet_ledger`.
- The existing single-game + B2B `/launch` paths still work (games catalogue now Postgres-backed).
- Security: no credentials in git; `.env` only; docs use placeholders.
