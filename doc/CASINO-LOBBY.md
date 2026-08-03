# Casino Lobby — How it works & how to run it

A plain-English guide to the personal casino lobby (Wave A). For the full technical
design see [`plans/2026-08-03-casino-lobby-postgres-s3-design.md`](plans/2026-08-03-casino-lobby-postgres-s3-design.md).

---

## The big picture

There are **two completely separate ways** a game gets played. They share only the
list of games — never any money code.

```
        ┌─────────────── Postgres  "casino" DB ───────────────┐
        │  games · game_assets · players · wallet_ledger      │
        └───────▲──────────────────────────────▲──────────────┘
                │                               │
   YOUR LOBBY (personal)              B2B  (someone else's casino)
   you own the players + money        they own the players + money
                │                               │
   /            → lobby (pick a game)   /launch?operator=…&game=…&token=…
   /play?game=X&mode=demo|real         → runs in their iframe, every bet/win
     demo → play money                   round-trips to THEIR wallet over
     real → your Postgres wallet         signed HTTP (unchanged, "seamless wallet")
```

- **Your lobby** is for your own players. Money lives in *your* Postgres wallet.
- **B2B** is for casinos that integrate you. Money lives in *their* wallet; you just
  send them debit/credit requests. This half is untouched and works exactly as before.

Both read one **games catalogue** in Postgres, so a game you publish once shows up in
your lobby *and* is available to B2B operators.

---

## Where things are stored

| What | Where | Notes |
|---|---|---|
| Game definitions (name, type, RTP, theme) | Postgres `games` table | one row per game |
| Game art (gifs, sprites, backgrounds, sounds) | **Contabo S3** bucket `crash` | stored as public URLs; the theme JSON just holds the URL |
| Your players (login) | Postgres `players` | username + bcrypt password hash |
| Your players' money | Postgres `wallet_ledger` | append-only; balance = sum of the rows |
| Live session state (who's in a round) | RocksDB (on disk) | fast, throwaway cache — not money |
| B2B ledger (operators, bets, idempotency) | SQLite (unchanged) | moves to Postgres in Wave B |

**Why a ledger, not a balance column?** Every deposit, bet, and win is a row
(`+`credit / `-`debit). Your balance is the sum. Nothing is ever overwritten, so you
always have a full, auditable money history. Bets take a Postgres advisory lock so two
simultaneous bets can never overdraw.

---

## Setup (one time)

1. **Credentials** live in a git-ignored `.env` at the repo root. Copy the template:
   ```bash
   cp .env.example .env      # then fill in the real values
   ```
   Keys: `DATABASE_URL` (the casino Postgres), and `S3_*` (Contabo endpoint, bucket,
   access/secret key, and the public base URL).

2. **Database + bucket already exist**: a dedicated `casino` Postgres database owned by
   a dedicated `casino` user, and the public `crash` S3 bucket. The server creates its
   tables automatically on first boot (nothing to run by hand).

> **Security:** never commit `.env`. If a key was ever pasted somewhere public, rotate it.

---

## Running it

```bash
npm run dev          # game server (:3001) + game/lobby client (:5173)
npm run dev:creator  # the Creator studio (:5174) — optional, for making games
```

Open:

| URL | What you get |
|---|---|
| http://localhost:5173/ | **The lobby** — grid of your games, Demo/Real buttons, login, balance, deposit |
| http://localhost:5173/play?game=galaxy-crash&mode=demo | Play a game directly (demo) |
| http://localhost:5174/ | **Creator** — design a game and **Publish** it to the catalogue |

Admin login for Creator's *Publish* (dev bootstrap): set
`ADMIN_BOOTSTRAP_USER=admin:pw123:admin` when starting, then use `admin` / `pw123`.

---

## The three things you can do

### 1. Make a game (Creator → Publish)
Design a theme in the Creator (colors, sprite or GIF, RTP, upload art). Hit **Publish**.
The Creator uploads every image/sound to S3, then saves the game (with the S3 URLs) to
Postgres. It now appears at `GET /api/games` and in the lobby.

### 2. Play for fun (Demo)
Lobby → a game's **Demo** button → `/play?game=…&mode=demo`. A throwaway balance,
nothing saved. Good for trying a game.

### 3. Play for real (Real)
Lobby → **Real** → log in or register → the game opens bound to your player account.
Every bet **debits** your Postgres wallet; every cashout **credits** it. Refresh and your
balance is still there. Deposits are a **top-up button** for now (no card/crypto yet).

**Proven flow** (from a live run):
`$100 → bet $20 (→ $80) → cash out at 1.2x (+$24) → $104`, and the Postgres ledger
reads `$104`. 

---

## API quick reference (personal lobby)

| Method | Path | Auth | Does |
|---|---|---|---|
| GET | `/api/games` | none | list active games |
| POST | `/api/lobby/register` | none | create a player → returns a player token |
| POST | `/api/lobby/login` | none | log in → player token |
| GET | `/api/lobby/me` | player token | your username + balance |
| POST | `/api/lobby/deposit` | player token | top up (stub) |
| POST | `/api/lobby/play/start` | player token | start a real-money game session |
| POST | `/api/assets/upload` | admin token | upload one asset to S3 (used by Creator) |
| POST/PATCH/GET | `/admin/v1/games` | admin token | manage the catalogue |

B2B stays where it was: `/launch`, `/op/v1/*`, `/admin/v1/*`.

---

## What's next (Wave B)

The B2B money ledger (operators, bet log, idempotency, reconciliation, admin) still runs
on SQLite. Wave B ports those to the same Postgres database, one piece at a time, without
changing how they behave. Nothing in this guide changes when that happens.
