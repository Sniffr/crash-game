# Crash Game — Aviator-Style Crash Game

A fully working, production-quality crash game in the style of Spribe's *Aviator* and *JetX*. A red airplane takes off, a multiplier rises along a curve, and you must cash out before the plane "flies away."

**Features:** Provably-fair RNG, animated canvas, bot simulation, real-time WebSocket, configurable RTP, and a complete UI with history, player list, and verification tools.

## Quick Start

```bash
cd crash-game
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

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
│   │   │   ├── rng.ts              # Provably-fair crash-point generator
│   │   │   ├── rng.test.ts         # 19 tests (RTP, distribution, bounds)
│   │   │   ├── types.ts            # TypeScript interfaces
│   │   │   └── config.ts           # RTP and timing knobs
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

Edit `packages/shared/src/config.ts`:

```ts
export const GAME_CONFIG = {
  rtp: 0.97,           // 97% — change this single value!
  maxMultiplier: 10000,
  bettingPhaseMs: 5000,
  resultPhaseMs: 3000,
};
```

The RTP knob is the **only** configuration needed to change the house edge. Changing from 0.97 to 0.95 immediately increases the house edge from 3% to 5%.

## Tests

```bash
npm test
```

19 tests covering:
- **Determinism**: Same seed + round → same crash point
- **RTP knob**: 250k simulated rounds verify RTP within ±0.01
- **Distribution shape**: P(crash ≥ m) ≈ RTP/m
- **Provably-fair**: Commit/reveal round-trips, tamper detection
- **Bounds**: All crash points in [1.00, maxMultiplier], quantized to 0.01

## Asset Credits

All assets are original or CC0-licensed. See [`client/src/assets/CREDITS.md`](packages/client/src/assets/CREDITS.md) for full details.

## Disclaimer

This is a simulation for entertainment / demo purposes. No real money is involved.
