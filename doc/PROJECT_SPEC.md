# Project Goal: Build an Aviator-Style Crash Game

You are an autonomous engineering agent. Your job is to build a complete, end-to-end, production-quality **crash game** in the style of Spribe's *Aviator* and *JetX*: a red/stylized airplane takes off, a multiplier rises along a curve, and the player must cash out before the plane "flies away" (crashes). The build must be **fully working**, **visually polished**, and **testable**.

You may install/use any open-source library, framework, or pre-built skill (e.g., a "design engineer" persona, Tailwind, Phaser, Pixi.js, Framer Motion, GSAP, Howler, etc.) you judge will help you hit the bar. Use your best judgment — but the constraints in this document are non-negotiable.

---

## 1. Hard constraints (read first)

1. **Do NOT scrape, download, decompile, or reuse assets (sprites, sounds, fonts, UI elements) from Spribe Aviator, JetX, or any other proprietary crash game.** Those assets are copyrighted and using them creates real legal exposure. Instead, generate or source original / openly-licensed equivalents (see §5).
2. **No real-money wagering, no payments, no KYC integration.** This is a *play-money* simulation. The player gets a virtual balance (e.g., 10,000 credits) that resets on demand. Do not integrate Stripe, crypto, or any payment rails.
3. **The RNG must be provably fair and the RTP must be a single configurable number** in a config file (see §3).
4. **It must actually run.** A reviewer should be able to clone the repo, run two commands, and play it in a browser. If it doesn't run end-to-end, the job isn't done.

---

## 2. Functional requirements

### 2.1 Core game loop
- Rounds run continuously on a server-authoritative loop:
  1. **Betting phase** (~5 seconds): players place a bet and optionally set an auto-cashout multiplier.
  2. **Flight phase**: the plane takes off, the multiplier starts at `1.00x` and grows along a curve until the round's predetermined crash point.
  3. **Crash**: the plane flies off, the multiplier freezes at the crash value, anyone who didn't cash out loses their stake.
  4. **Result phase** (~3 seconds): show winners, round hash, history strip updates.
- The crash point for each round is decided **at round-start** by the RNG (see §3) and committed via a hash *before* the round begins. The seed is revealed after.

### 2.2 Player actions
- Place bet (any integer amount up to current balance).
- Cash out manually at any time during flight → payout = `stake * current_multiplier`.
- Set auto-cashout target (e.g., `2.00x`) — server cashes out automatically when reached.
- View round history (last 20–50 crash multipliers, color-coded: pink for `<2x`, purple `2x–10x`, gold for `≥10x`).
- See live "other players" list (simulate 10–30 bot players per round with plausible bet sizes and cashout behaviors).

### 2.3 UI/UX surfaces
- **Main game canvas**: dark gradient background (deep navy → purple), grid lines that scroll, the plane sprite, an animated multiplier curve, and a huge centered multiplier readout that scales and reddens as it climbs.
- **Bet panel** (left or bottom): stake input, ±/½/2× buttons, bet button, auto-cashout toggle, auto-bet toggle.
- **Player list** (right): live bets and cashouts streaming in.
- **History strip** (top): pill-shaped chips of recent crash points.
- **Provably-fair drawer**: shows current round hash, previous round seed + verification steps.

---

## 3. RNG engine (the part that must be correct)

### 3.1 Configurable RTP
A single value in `config/game.config.ts` (or equivalent):

```ts
export const GAME_CONFIG = {
  rtp: 0.97,           // 97% — must be the ONLY knob needed to change house edge
  houseEdge: 0.03,     // derived: 1 - rtp
  maxMultiplier: 10000,
  minMultiplier: 1.00,
  bettingPhaseMs: 5000,
  resultPhaseMs: 3000,
};
```

Changing `rtp` (e.g., to `0.95` or `0.99`) must produce a correspondingly different long-run return with **no other code changes**.

### 3.2 Crash-point distribution
A working reference implementation is provided alongside this spec at `rng-reference/`. It is fully tested (18 passing tests, including the RTP-knob simulation) and drop-in ready for `server/src/rng/`. **Use it.** Don't re-derive — it's easy to get the math subtly wrong (the author of this spec did, twice, before the tests caught it).

The core formula is:

```
1. u = uniform float in [0, 1) from HMAC-SHA256(serverSeed, roundNumber).
2. raw = (100 * rtp) / (1 - u)
3. crashPoint = max(1.0, floor(raw) / 100), clamped to maxMultiplier.
```

The house edge emerges automatically from the floor-quantization: rounds where `raw < 2.00` collapse to `1.00x`. No special branch needed. See `rng-reference/README.md` for the derivation.

This yields:
- `P(crashPoint ≥ m) = rtp / m` for every cashout target `m > 1` — this is the property that makes RTP genuinely configurable with a single knob.
- Median crash ≈ `2x`, P(crash ≥ 10x) ≈ `rtp/10` ≈ 9.7%, rare rounds reach `100x+`.

### 3.3 Provably-fair scheme
- Server generates a random `serverSeed` (32 bytes) and publishes `SHA256(serverSeed)` as the commit *before* the round opens.
- Each round's crash uses `HMAC-SHA256(serverSeed, roundNumber)` → take first 13 hex chars → convert to float in `[0, 1)` → apply the formula above.
- After the round, `serverSeed` is revealed so anyone can verify.
- Expose a verification page/endpoint where a user pastes a seed and round number and gets back the crash multiplier.

### 3.4 Tests (mandatory, must pass in CI)
The reference implementation under `rng-reference/tests/rng.test.ts` already includes all of these and passes. The server's RNG test suite must keep them green:

1. **Determinism**: same seed + round number → same crash multiplier.
2. **RTP knob (the critical one)**: simulate ≥250k rounds using a fixed-cashout strategy (`payout = m if crashPoint ≥ m, else 0`, averaged across several `m`). Assert measured RTP is within ±0.01 of the configured value, for `rtp ∈ {0.90, 0.97, 0.99}`. **This is the test that proves the RTP knob actually works.**
3. **Distribution shape**: `P(crashPoint ≥ m)` is within ±8% of `rtp/m` for `m ∈ {1.5, 2, 3, 5}` and within ±20% for `m ∈ {10, 50}` (rare tail = noisier).
4. **Provably-fair**: commit/reveal round-trips for 100+ rounds; tampering with the crash point or seed is detected.
5. **Bounds**: every crash point is in `[1.00, maxMultiplier]` and quantized to 0.01.

Note: do *not* test "mean of crashPoint equals RTP" — that's a different (and incorrect) quantity. The mean of `crashPoint` itself is large and dominated by tail outliers. RTP is `E[payout]/E[stake]` under a cashout strategy. The reference tests get this right.

---

## 4. Architecture

### 4.1 Stack (suggested — substitute equivalents only if you justify it in the README)
- **Backend**: Node.js + TypeScript, Express or Fastify, WebSocket (`ws` or Socket.IO) for the live round broadcast.
- **Frontend**: React + TypeScript + Vite. Tailwind for styling.
- **Game rendering**: Pixi.js OR HTML5 Canvas with `requestAnimationFrame`. (Three.js is overkill — this is 2D.)
- **State**: Zustand or Redux Toolkit on the client. The server is the source of truth for round state.
- **Tests**: Vitest. Coverage on the RNG module especially.
- **Persistence**: SQLite or just in-memory for round history (this is play-money; no real persistence required, but `better-sqlite3` is fine if you want it).

### 4.2 Repo layout
```
crash-game/
├── README.md                 # how to run, how to verify, screenshots
├── package.json              # workspaces: client, server, shared
├── config/
│   └── game.config.ts        # RTP and timing knobs (the one place to change behavior)
├── server/
│   ├── src/
│   │   ├── rng/              # crash-point generator + provably-fair
│   │   ├── round/            # round loop / state machine
│   │   ├── ws/               # websocket handlers
│   │   └── bots/             # fake-player simulation
│   └── tests/
├── client/
│   ├── src/
│   │   ├── scenes/           # game canvas
│   │   ├── components/       # bet panel, history, player list
│   │   ├── store/            # zustand
│   │   └── assets/           # original sprites/sounds
│   └── public/
└── shared/
    └── types.ts              # round/bet/event types shared by client and server
```

### 4.3 Round state machine
```
IDLE → BETTING (5s) → FLYING → CRASHED → RESULT (3s) → BETTING ...
```
Each transition is broadcast as a WebSocket event with `{phase, roundId, serverTime, crashPoint?, hashCommit}`. The client must reconcile against `serverTime` so latecomers see the correct multiplier on join.

### 4.4 Multiplier curve (client-side, purely visual)
The crash point is set by the server. The client draws the curve as:
```
multiplier(t) = 1.0024^(t * 1000)   // ~e^(0.06 * t_seconds)
```
where `t` is seconds since flight start. The client renders frame-by-frame using server time, and freezes the moment the server's `crash` event arrives. **Never compute the crash point on the client.**

---

## 5. Visual & asset requirements

Match the *feel* of Aviator/JetX without copying their assets:

- **Plane sprite**: an original red propeller plane in 3/4 perspective. Generate via SVG or commission an AI image (transparent PNG, ~512×512). Animate the propeller with a fast spin and add a subtle bob.
- **Trail**: a glowing red/orange line traces the multiplier curve as the plane flies. The line should have a soft bloom and dashed segments behind it.
- **Background**: dark blue-purple radial gradient, animated grid/stars scrolling diagonally to imply forward motion.
- **Multiplier readout**: huge sans-serif (Inter, Sora, or similar), 96–160px, glowing white that shifts to amber/red as it crosses thresholds (2x, 5x, 10x, 50x).
- **Crash animation**: plane tilts up, accelerates off-screen top-right, the curve breaks at the crash point, multiplier turns red, screen flashes briefly.
- **Sound**: original or CC0 SFX only. Sources: [freesound.org](https://freesound.org) (filter CC0), [Pixabay sound effects](https://pixabay.com/sound-effects/). Need: engine loop, takeoff whoosh, cash-out chime, crash explosion, UI ticks.

**Acceptable asset sources**: open-game-art.org, Kenney.nl (CC0 game assets), itch.io free-tier with permissive licenses, AI-generated (DALL·E / SDXL / Midjourney with appropriate license), or hand-drawn in SVG. Document every asset's source and license in `client/src/assets/CREDITS.md`.

---

## 6. Acceptance criteria — the build is "done" when all of these are true

- [ ] `npm install && npm run dev` from repo root starts the server and client; the game is playable at `http://localhost:5173` (or stated URL).
- [ ] A round completes end-to-end: bet → flight → cashout (or crash) → balance updates correctly.
- [ ] Auto-cashout fires server-side and credits the player even if their tab is in the background.
- [ ] `npm test` passes. RNG tests in §3.4 all green.
- [ ] Changing `rtp` in the config file and re-running tests shows the new mean payout, with no other code changes.
- [ ] Provably-fair: a user can copy the revealed seed + round number into the verification tool and reproduce the crash multiplier.
- [ ] Visual polish is at the level of a launched product — animations smooth at 60fps, no jank during the multiplier climb, history chips animate in, bet button has satisfying feedback.
- [ ] Bots populate the player list with plausible activity (varied stakes, varied cashout times, occasional big wins).
- [ ] README has: setup instructions, RTP configuration guide, provably-fair explanation, screenshots/GIF, and credits for all assets.
- [ ] No proprietary assets from Spribe / JetX / any commercial crash game are present in the repo.

---

## 7. Suggested execution order

1. Scaffold the monorepo, get a TS server + Vite client talking over WebSocket with a stub round.
2. Build the RNG module **first** and write its tests. Get those green before touching UI. The whole game depends on this being right.
3. Build the round state machine on the server.
4. Build the client game canvas: static plane, curve drawing from server multiplier events.
5. Wire the bet panel and balance.
6. Add manual + auto cashout.
7. Add bots, history strip, player list.
8. Polish: animations, sounds, easing, microcopy, mobile responsiveness.
9. README + screenshots. Verify all acceptance-criteria boxes.

---

## 8. Non-goals (explicitly out of scope)

- Real money, real payments, KYC, geo-blocking, responsible-gambling tooling. (This is a tech demo — but **add a clear disclaimer** in the UI footer: *"This is a simulation for entertainment / demo purposes. No real money is involved."*)
- Multi-server scaling, Redis, Kubernetes. Single-node is fine.
- Mobile native apps. Web only, but the web UI should be responsive down to 375px.
- Skinning/theming system. One good-looking theme is the goal.

---

## 9. If you get stuck

- For RNG formulas, the canonical reference is the public Bustabit "provably fair crash" methodology. Re-derive it; don't copy code that may be under an incompatible license.
- For visual reference, you may *look at* Aviator/JetX gameplay videos for layout and pacing inspiration — just don't reproduce their assets.
- If a chosen library doesn't work out, swap it and note the swap in the README. Don't get stuck on tooling.

Begin.
