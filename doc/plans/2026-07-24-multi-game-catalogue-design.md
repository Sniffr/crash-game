# Multi-Game Catalogue — Design

**Date:** 2026-07-24 · **Status:** Approved design, pre-plan · **Depends on:** the shipped B2B seamless-wallet platform ([2026-05-18 plan](2026-05-18-b2b-seamless-wallet-platform.md))

**Goal:** Turn the single hard-coded game (`gameId: 'galaxy-crash'`) into a catalogue of customisable games. Each theme built in the Creator becomes a first-class game with its own `gameId`, RTP, and launch URL. Operators enable a subset; a launch picks the game; every bet/win and audit row carries the real `gameId`.

**Why:** The platform sells "a game" to casinos but the product is actually a skinnable engine with two game types (`sprite`, `gif` — the Creator toggle at `packages/creator/src/theme.ts:108`). Today you can skin the game but can't sell two skins as two games to one operator. `gameId` is a literal at `public.ts:260`, `operator.ts:756`, `admin.ts:433`; per-operator game enable/disable is a documented stub (`admin.ts:637` echoes `enabled` without storing it). This closes both gaps.

**Out of scope:** Creator UI redesign (only a Publish button is added), new game types beyond sprite/gif, per-operator theme overrides (a game's theme is global; an operator picks from the catalogue but does not restyle it).

---

## 1. Game catalogue — SQLite table + admin API

New table in the existing better-sqlite3 db, behind a `GamesRepo` repository interface (same pattern as `operator-registry.ts` / `bet-log.ts`, so a Postgres swap later is one file):

```sql
CREATE TABLE games (
  game_id     TEXT PRIMARY KEY,        -- 'galaxy-crash', 'cosmic-jet'
  name        TEXT    NOT NULL,
  game_type   TEXT    NOT NULL,        -- 'sprite' | 'gif'
  rtp         REAL    NOT NULL,        -- fraction in (0,1], e.g. 0.97
  theme_json  TEXT    NOT NULL,        -- the Creator's exported `Theme` object, JSON
  status      TEXT    NOT NULL DEFAULT 'active',   -- 'active' | 'archived'
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK (game_type IN ('sprite','gif')),
  CHECK (rtp > 0 AND rtp <= 1),
  CHECK (status IN ('active','archived'))
);
```

`theme_json` stores the Creator's `Theme` interface verbatim (`packages/creator/src/theme.ts:138`, including `gameType` and `gifs`). `game_type` and `rtp` are denormalised out of the theme for cheap catalogue queries and validation; on write, `game_type` MUST equal `theme_json.gameType`.

**Endpoints** (studio JWT, `requireRole('admin')`, mirroring operator CRUD in `admin.ts`; each mutation writes an `admin_audit` row):

| Method | Path | Notes |
|---|---|---|
| POST | `/admin/v1/games` | Body: `{ gameId, name, gameType, rtp, theme }`. 409 on duplicate `gameId`. Validates `rtp∈(0,1]`, `gameType∈{sprite,gif}`, `gameType===theme.gameType`. |
| PATCH | `/admin/v1/games/:gameId` | Partial: `name`, `rtp`, `theme`, `status`. Re-runs the same validation on changed fields. |
| GET | `/admin/v1/games` | List all, incl. archived. |
| GET | `/admin/v1/games/:gameId` | Single, or 404. |

**Public:**

| Method | Path | Notes |
|---|---|---|
| GET | `/api/games` | Active games only. Returns `{ gameId, name, gameType }[]` for lobbies and the Creator. No `theme_json` (that ships at launch). |

**Creator Publish:** a "Publish" button in the Creator app POSTs/PATCHes the `Theme` it already builds to `/admin/v1/games`. First save is POST; re-save of an existing `gameId` is PATCH. (Creator holds a studio JWT — same auth the rest of `/admin/v1` uses; no new auth path.)

---

## 2. Operator ↔ game join — replaces the `admin.ts:637` stub

```sql
CREATE TABLE operator_games (
  operator_id  TEXT    NOT NULL,
  game_id      TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,       -- 0 | 1
  rtp_override REAL,                              -- NULL = inherit games.rtp
  PRIMARY KEY (operator_id, game_id),
  CHECK (rtp_override IS NULL OR (rtp_override > 0 AND rtp_override <= 1))
);
```

`PATCH /operators/:id/games/:gameId` (existing route, currently a stub) now writes here instead of echoing. Body `{ enabled?, rtpOverride? }`. 404 if the operator or game does not exist. Still `requireRole('admin')`, still audited.

**Effective RTP** for a launched game = `operator_games.rtp_override ?? games.rtp`. Resolved once at launch and carried on the session so every round in that session uses a stable value.

**Units, explicit (avoids a real bug at the seam):** `games.rtp` and `operator_games.rtp_override` are **fractions in (0,1]** (`0.97`), because that is what `crashPointFor` consumes (`packages/shared/src/rng.ts`). The pre-existing `operators.rtp_variant` column is a **percentage** (`97.0`, per wallet spec §6.2). The effective-RTP resolver returns a fraction; if the legacy `rtp_variant` is ever read as a fallback it MUST be divided by 100 first. Admin/operator API responses keep exposing percentages for continuity — convert at the API boundary, store/compute fractions.

**Enable semantics:** a game is playable by an operator only if a row exists with `enabled = 1`. No row ⇒ not enabled (default-deny). The old `rtpVariant` column on the operator row is superseded by this table; it stays for back-compat but is no longer read for game RTP.

---

## 3. Launch & theme by game

`/launch` gains one optional param: `&game=<gameId>`. Omitted ⇒ `galaxy-crash` (back-compat; existing operator links keep working).

Launch flow additions (in `public.ts`):
1. Resolve `game` against `games` (must be `status='active'`) → 404-style error page if missing.
2. Check `operator_games` for `(operator, game, enabled=1)` → error page "game not enabled for this operator" if absent.
3. Resolve effective RTP (§2), store `{ gameId, rtp }` on the session alongside the existing operator/currency fields.
4. Serve that game's `theme_json` to the iframe **instead of** the single `config/active-theme.json`. (`config/active-theme.json` remains the fallback only when no game is resolved, e.g. legacy single-tenant dev.)

The hard-coded `gameId: 'galaxy-crash'` literals at `public.ts:260`, `operator.ts:756`, `admin.ts:433` are replaced by the session's / request's real `gameId`.

---

## 4. Per-game RTP on one shared round loop

One global round timer and one server seed stay exactly as today. Per-game divergence comes from **domain-separating the HMAC message**, not from post-scaling a shared multiplier:

```ts
// today:   crashPointFor(serverSeed, roundNumber, { rtp })
// catalogue: message includes the gameId
crashPointFor(serverSeed, `${roundNumber}:${gameId}`, { rtp: effectiveRtp })
```

`crashPointFor` is already pure and takes the message as a string-able value (`packages/shared/src/rng.ts`), so this is a call-site change, not an RNG rewrite. Each game gets an **independent** uniform `u` for the same round → genuinely independent crash points and a truthful per-game RTP distribution.

**Consequence (accepted):** two games in the same round crash at different multipliers. A player with Galaxy-Crash open in one tab and Cosmic-Jet in another sees different outcomes at the same wall-clock moment. This is intended — it is the price of honest per-game RTP.

**Provably-fair verifier stays honest:** the reveal/verify path recomputes `crashPointFor(serverSeed, message, rtp)`. The verifier page and any published proof simply include `gameId` and the game's `rtp` in the recomputed message. Same commit/reveal, one extra public input.

**Schema:** `bet_log` and the rounds table gain a `game_id TEXT` column (nullable for pre-migration rows; new rows always set it). Reconciliation, admin reads, and financial rollups group by `game_id` where it aids per-game reporting but are otherwise unchanged.

---

## 5. Migration & back-compat

- New tables (`games`, `operator_games`) and the `game_id` columns are additive; existing rows unaffected.
- Seed `games` with one row for the current product: `game_id='galaxy-crash'`, `game_type` and `theme` from the current `config/active-theme.json`, `rtp` from current config. Back-fill `bet_log.game_id='galaxy-crash'` for existing rows.
- `/launch` without `&game=` and existing operator links resolve to `galaxy-crash` → no operator action required to keep running.
- `operator_games`: seed one enabled row per existing operator for `galaxy-crash` so current integrations stay live.

---

## 6. Testing

- `GamesRepo`: CRUD, duplicate-id, validation (rtp range, gameType↔theme consistency), archive. (`packages/wallet/src/games-repo.test.ts`)
- `operator_games`: enable/disable, rtp_override, effective-RTP resolution incl. NULL inheritance.
- Admin API: auth (401 without JWT / wrong role), 409 duplicate, 404 unknown, audit rows written. (`packages/server/src/http/admin-games.test.ts`)
- Launch: `&game=` resolution, default to `galaxy-crash`, not-enabled rejection, correct theme served, effective RTP on session.
- RNG: `crashPointFor` with two different `gameId`s on the same `(serverSeed, roundNumber)` yields independent values; each game's long-run RTP matches its configured `rtp` (extend the existing distribution property test in `rng.test.ts`).
- Reconciliation/financials: unchanged totals, correctly grouped by `game_id`.

---

## 7. Definition of done

- Publish a second game from the Creator; it appears in `GET /api/games`.
- Enable it for an operator; a launch with `&game=<id>` loads its theme at its RTP.
- Disable it; the launch is rejected.
- Two games launched in the same round show different, independently-verifiable crash points, each matching its own RTP over many rounds.
- Every bet/win/audit/reconciliation row carries the real `game_id`.
