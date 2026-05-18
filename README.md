# Galaxy Crash

A fully working, production-quality crash game set in deep space. A retro rocket lifts off, a multiplier climbs along an exponential curve, and you must cash out before the rocket flies away into the void.

**Features:** Provably-fair RNG, animated canvas, bot simulation, real-time WebSocket, configurable RTP, and a complete UI with history, player list, and verification tools.

## Quick Start

```bash
cd crash-game
npm install                       # also builds RocksDB native bindings (one-time, ~30s)
npm run dev                       # launches Galaxy Crash (game) at http://localhost:5173
npm run dev:creator               # launches the Crash Game Creator at http://localhost:5174
npm run dev:all                   # runs game + creator side by side
```

- **Game** → http://localhost:5173 — play Galaxy Crash. Sessions persist in embedded **RocksDB**.
- **Creator** → http://localhost:5174 — visual studio for skinning the game.
- **Session store** → embedded RocksDB at `./data/rocksdb/` (created on first run). Override with `ROCKSDB_PATH=/some/where npm run dev:server`.

No external services needed — RocksDB runs in-process. Stop the server and your data is still on disk; restart and pick up where you left off.

## Sessions

Every player has a server-side session stored in Dragonfly with balance, stats, and a full bet/cashout audit log. The session id lives in the URL.

- Visit `http://localhost:5173/` with no `?session=` → the server creates a fresh anonymous session, gives you a friendly display name (e.g. *Lucky Falcon*), starting balance, and rewrites the URL to `?session=<id>`.
- Share that URL to "resume" the same session in another tab / browser / device.
- Sessions expire after 24h of inactivity; bets and cashouts refresh the TTL.

### Session API

| Endpoint | Description |
|---|---|
| `POST /api/session` | Create a new anonymous session. Body `{ displayName?, balance? }` optional. Returns `{ sessionId, displayName, balance, createdAt, expiresAt }`. |
| `GET /api/sessions/:id` | Fetch session + stats `{ session, stats }`. |
| `GET /api/sessions/:id/history?limit=50` | Full audit log: every bet, cashout, and crash this session saw. |
| `GET /api/health` | Reports `storeOnline` so you can health-check Dragonfly via the API. |

### What's tracked per session
- **Balance** (atomic via `HINCRBYFLOAT`, quantized to 2 decimals)
- **Stats**: bets, wins/losses, total wagered, total won, net profit, biggest cashout multiplier, biggest single win, current and best win streak
- **History** (last 500 events): bet placed, cashed out, crashed — each entry has the round number, amount, and (for crashes) the revealed server seed for verification

### Anti-spam / safety
- **Rate limit**: max 40 bets per minute per session (in-memory token bucket; resets per-minute and on restart)
- **Max stake**: `MAX_STAKE` in `packages/shared/src/config.ts` (default 1000)
- **Server-side balance check**: bets that would overdraw are rejected
- **Atomic balance**: per-session async lock chain serializes read-modify-write so concurrent updates never lose increments. RocksDB is single-process by design — only one Node instance can hold the lock at a time.

## Shipping your game (Docker)

The repo ships a production-ready Dockerfile that bundles the server, the
built client, and the RocksDB binding into a single image. The Creator app
is **not** included in the image — it stays a dev-time tool on your machine.
Player-facing theme upload UI is **automatically hidden** in production
(`import.meta.env.PROD`), so the only theme players can see is the one you
serve from `config/active-theme.json`.

### 1. Design your theme

```bash
npm run dev:creator                  # design at http://localhost:5174
# click "Export theme" → saves <slug>-theme.json
cp <slug>-theme.json config/active-theme.json
```

The file in `config/active-theme.json` is what players will see.

### 2. Build the image

```bash
docker build -t galaxy-crash .
```

First build compiles the RocksDB native binding (~4 min on a typical
machine). Subsequent builds are fast (~30 s) because the layers cache.

### 3. Run it

```bash
docker run -d \
  --name galaxy-crash \
  -p 80:3001 \
  -v $(pwd)/config:/app/config:ro \
  -v galaxy-crash-data:/app/data \
  galaxy-crash
```

- `-p 80:3001` — exposes the game at http://localhost (or your server's IP)
- `-v $(pwd)/config:/app/config:ro` — mounts your theme as read-only; the
  file watcher inside the container picks up live edits without restart
- `-v galaxy-crash-data:/app/data` — named volume for the RocksDB session
  store. Sessions, balances, and round history persist across restarts.

### 4. Updating the theme live

Edit `config/active-theme.json` on the host — the running container's
file-watcher reloads it within ~250 ms and new players see the change on
their next page load. No rebuild, no redeploy.

If you need to apply it RIGHT NOW to existing players, just refresh their
tab (the theme is fetched on every page load).

### Hosting destinations

The same image runs anywhere Docker does:

| Platform | One-liner |
|---|---|
| **Fly.io** | `flyctl launch --image galaxy-crash` (then `flyctl volumes create galaxy-crash-data` and add the mount in `fly.toml`) |
| **Railway** | Push the repo, point the service at the Dockerfile, attach a volume at `/app/data` |
| **Render** | New Web Service → Docker → set health check to `/api/health` → attach a disk at `/app/data` |
| **DigitalOcean / Hetzner VPS** | `docker run` from above, then put nginx + certbot in front for HTTPS |
| **Cloud Run / Fargate** | Pre-built RocksDB native binaries deploy fine; mount EFS/Filestore for `/app/data` if you need persistence (or accept that sessions reset on container restart) |

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Server listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `ROCKSDB_PATH` | `/app/data/rocksdb` | Where to store the session DB |
| `NODE_ENV` | `production` | Set by the Dockerfile, used by libs |

### Production lockdown — what changes vs dev

| | Dev (`npm run dev`) | Production (Docker image) |
|---|---|---|
| Theme controls in header (🎨 / ↻) | Visible | **Hidden** |
| User upload writes to localStorage | Yes | **No** (gated by `import.meta.env.PROD`) |
| Theme source | localStorage > server > default | Server only (no override possible) |
| Creator app available | Yes (port 5174) | **Not in image** |
| Hot reload | Yes | No |
| RocksDB path | `./data/rocksdb` | `/app/data/rocksdb` (named volume) |

### Inspecting the database

RocksDB is a flat directory of SST files at `./data/rocksdb/`. To browse contents without a binary client, use the bundled inspector script:

```bash
node packages/server/scripts/dump.mjs                       # list all keys
node packages/server/scripts/dump.mjs session:<id>          # one key
```

Or wipe and start fresh:

```bash
rm -rf data/rocksdb && npm run dev
```

## Theming workflow

### Build a theme in the Creator
1. Open the Creator (http://localhost:5174).
2. Pick a preset or start from scratch.
3. Adjust colors, brand text, procedural sprite/background, game tuning.
4. **Custom sprites** — upload per-state sprites:
   - **Ground sprite** — shown during BETTING + early flight (the plane sitting on the runway)
   - **Flying sprite** — shown after the multiplier crosses the **transition threshold** (default 1.5x, configurable 1–5x)
   - **Crashed sprite** — shown during the crash explosion animation
   - **Single sprite** — legacy fallback, used for any of the above not explicitly set
5. **Custom background** — upload an image, then choose:
   - **Motion direction**: none, left, right, up, or down
   - **Motion speed**: slow / medium / fast — the image tiles seamlessly in that direction during flight
6. **Custom sounds** — five SFX slots (takeoff / cashout / crash / bet / tick) + a looping music track
7. **Custom logo** — replaces the header rocket
8. Click **Export theme** → downloads `<your-brand>-theme.json` (all assets embedded as base64).

### Load a theme into the game

There are two ways:

**Manual load (per browser)** — click the 🎨 **Theme** button in the game header, pick the JSON. The theme persists in your browser via localStorage and survives refreshes. Click **↻ Reset** to drop your override and fall back to the server theme (or the built-in default).

**Server-side autoload (for everyone)** — drop the JSON at `config/active-theme.json` at the repo root. The server reads it on boot and serves it to every client at `GET /api/theme`. Edits to the file are picked up automatically by the file watcher (no restart). This is the "operator theme" — what every new player sees by default.

Precedence: **user manual upload** > **server config** > **built-in Galaxy Crash default**.

## How to Play

1. **Place a bet** during the betting phase (5-second countdown)
2. **Watch the multiplier climb** as the plane takes off
3. **Cash out** before the plane crashes to win `stake × multiplier`
4. Toggle **auto-cashout** to set a target (e.g., 2.00x) for automatic payout

## Architecture

```
crash-game/
├── package.json                    # Workspace root
├── packages/
│   ├── shared/                     # Shared types, RNG, config
│   │   ├── src/
│   │   │   ├── rng.ts              # Provably-fair crash-point generator (drop-in reference)
│   │   │   ├── rng.test.ts         # 18 tests (RTP, distribution, provably-fair, bounds)
│   │   │   ├── types.ts            # TypeScript interfaces
│   │   │   └── config.ts           # RTP and timing knobs (THE single source of truth)
│   │   └── vitest.config.ts
│   ├── server/                     # Express + WebSocket server
│   │   ├── src/
│   │   │   ├── index.ts            # Round state machine, API, WS
│   │   │   └── bots.ts             # Bot player simulation (10-30/bot)
│   │   └── tsconfig.json
│   └── client/                     # React + Vite + Tailwind UI
│       ├── src/
│       │   ├── App.tsx             # Main app, WebSocket client
│       │   ├── components/
│       │   │   ├── GameCanvas.tsx  # Animated canvas (stars, grid, plane, curve)
│       │   │   ├── BetPanel.tsx    # Bet controls, auto-cashout toggle
│       │   │   ├── PlayerList.tsx  # Real player + bot leaderboard
│       │   │   ├── HistoryStrip.tsx # Color-coded crash history chips
│       │   │   └── ProvablyFairDrawer.tsx # Verification UI
│       │   ├── index.css           # Tailwind + custom styles
│       │   └── main.tsx
│       ├── vite.config.ts
│       └── tailwind.config.js
└── README.md
```

## RNG & Provably Fair

### The Formula

```
u = HMAC-SHA256(serverSeed, roundNumber) → first 13 hex chars → float in [0, 1)
raw = (100 × RTP) / (1 - u)
crashPoint = max(1.0, floor(raw) / 100), clamped to maxMultiplier
```

This yields **P(crashPoint ≥ m) = RTP / m** for every cashout target m > 1. A player who always cashes out at m has expected payout `m × (RTP/m) = RTP` per unit staked, **regardless of m**.

### Provably-Fair Scheme

1. **Before** each round: server publishes `SHA256(serverSeed)` as a hash commit
2. **During** the round: crash point is computed server-side using HMAC-SHA256
3. **After** the round: server reveals the seed, anyone can verify

### Verification

Use the **Provably Fair** drawer in the game UI, or call the API:

```bash
curl "http://localhost:3001/api/verify?seed=<SEED>&roundNumber=<ROUND>"
```

Or POST for verification:

```bash
curl -X POST http://localhost:3001/api/verify \
  -H "Content-Type: application/json" \
  -d '{"seed": "<SEED>", "roundNumber": <ROUND>}'
```

## RTP Configuration

The RTP is genuinely configurable from a single value. Edit `packages/shared/src/config.ts`:

```ts
export const GAME_CONFIG: GameConfig = {
  rtp: 0.97,           // 97% — the ONLY knob you need to change house edge
  houseEdge: 0.03,     // derived: 1 - rtp
  maxMultiplier: 10000,
  minMultiplier: 1.0,
  bettingPhaseMs: 5000,
  resultPhaseMs: 3000,
};
```

Setting `rtp` to `0.90`, `0.97`, or `0.99` and re-running tests produces a measured RTP within ±0.01 of the configured value across 250 000 simulated rounds. No other code changes required.

## Tests

```bash
npm test
```

All **18** RNG tests pass (from the reference implementation in `doc/rng.test.ts`):

| Group | What it proves |
|---|---|
| determinism (3) | Same `(seed, roundNumber)` always returns the same crash point; different seeds/rounds produce different sequences |
| RTP knob (4) | `rtp ∈ {0.90, 0.97, 0.99}` each measured to within ±0.01 across 250k rounds; raising `rtp` raises measured RTP monotonically |
| distribution shape (4) | `P(crash = 1.00x) ≈ 1 - rtp/1.01`; `P(crash ≥ m) ≈ rtp/m` for m ∈ {1.5, 2, 3, 5, 10, 50}; outputs always in `[1.00, maxMultiplier]` and quantized to 0.01 |
| provably-fair (5) | SHA-256 commit/reveal round-trips for 100+ rounds; tampered crash points and mismatched seeds are caught by `verifyRound` |
| input validation (2) | `rtp ≤ 0` and `rtp > 1` throw; `DEFAULT_CONFIG` is used when none supplied |

## Asset Credits

All assets are original or CC0-licensed. See [`client/src/assets/CREDITS.md`](packages/client/src/assets/CREDITS.md) for full details.

## Disclaimer

This is a simulation for entertainment / demo purposes. No real money is involved.
