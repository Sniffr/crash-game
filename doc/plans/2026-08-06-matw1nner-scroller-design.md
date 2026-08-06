# Matw1nner side-scroller render mode

**Date:** 2026-08-06
**Status:** design, pending implementation

Turn the three Matw1nner gameplay animations into a live-rendered game scene
instead of shipping the MP4s to players.

## Problem

`Matw1nner Gameplay Loop Animation/` holds three exported clips — Launch (5 s),
Play Loop (8.33 s), Crash (2.77 s), 14 MB total at 1920×1080/30 fps. The client
can already play them: `gameType: 'gif'` (`packages/client/src/theme/types.ts`)
drives per-phase `<video>` elements with canvas text overlaid
(`GameCanvas.tsx`, the `pickGif` / `GifVideo` path).

That is playback, not a game. Three problems follow from it:

1. **The loop cannot respond.** It runs 8.33 s at one fixed speed. A round runs
   as long as the crash point says — often much longer — so the bus drives at
   exactly the same pace at 1.01x and at 50x. The acceleration that makes a
   crash game feel like a crash game is impossible.
2. **14 MB per player**, on a product whose audience is largely on mobile data.
3. **Every pixel is baked**, including the "READY?" / "GO!" / "FAILED!" text, so
   none of it can carry the real countdown, multiplier, or a second language.

The After Effects project is not available, so the layers cannot be re-exported.

## What the source clips actually contain

Measured, not assumed (`tools/scroller-assets/`, see Verification):

| Property | Value |
|---|---|
| Source resolution | 1920×1080, 30 fps |
| Play Loop length | 250 frames = 8.333 s |
| Horizontal pan | **30.00 px/frame, uniform across every horizontal band** |
| Parallax | **None.** Sky, skyline, buildings, trees and road all pan at the same rate |
| Vertical motion | None |
| Implied tile width | 250 × 30 = **7500 px**, and the loop closes |

The absence of parallax is the useful finding: the city is a single flat
7500×1080 strip, so there are no layers to separate. It also means the pan is
integer and periodic, which makes reconstruction exact rather than approximate.

## Asset reconstruction

Because the pan is exactly 30 px/frame, world column `x + 30·i` **is** screen
column `x` of frame `i`. Sampling a fixed 30-px-wide window that the bus never
covers (x = 1700) across all 250 frames yields the entire strip with no
interpolation, no stitching artefacts, and no inpainting behind the bus.

The bus is the only thing static in screen space, so **per-pixel temporal
standard deviation** separates it from the city: low variance = bus, high
variance = background. The separation is strongly bimodal (median 2.7,
90th percentile 53.4), so the threshold is not delicate — sweeping it from 10 to
24 changes the kept area by only 3 %.

That matte also, for free, rejects the two things that *should* be separate
animated sprites: the spinning wheels and the dancing rider in the doorway.

### Outputs

| Asset | Size | Payload (WebP q78) |
|---|---|---|
| `city.webp` | 7500×1080, tiles horizontally | 394 KB |
| `bus.webp` | ~900×380, body only | 55 KB |
| `wheel.webp` | one wheel, hub centred | ~5 KB |
| `rider.webp` | sprite sheet; frame count measured, not assumed | ~30 KB |
| **Total** | | **< 600 KB** |

Roughly 24× smaller than the MP4s, at full resolution.

### Pipeline

`tools/scroller-assets/extract.py` — checked in, not a one-off, so the artist can
ship a revised animation and the assets regenerate. Takes the loop MP4, emits the
four WebPs plus a `scroller.json` fragment carrying everything it measured —
wheel hub positions and radius, rider position and frame count — so none of
those numbers are hand-transcribed into the theme.

The script **fails loudly** rather than emitting subtly wrong art. It asserts:

- pan is integer and constant (σ of per-frame shift ≈ 0)
- reconstruction error in the bus-free region < 3/255
- wrap seam < 5/255, and at least 5× lower than an unrelated column pair

Assets are served as **static URLs**, not data URLs. The theme JSON is cached in
`localStorage` (`theme/loader.ts`), which is size-limited and would be wasted on
400 KB of inlined image; plain URLs also let the browser cache them across
rounds. Both `<img>` and `<video>` paths in `GameCanvas` already accept plain
URLs, so nothing in the loader changes.

## Runtime

### Mode

A third `gameType`, `'scroller'`, handled as an early-return branch in the
`GameCanvas` draw loop — structurally identical to the existing `'gif'` branch.
`'sprite'` and `'gif'` are not touched, so there is no regression surface. The
drawing lives in a new `packages/client/src/components/ScrollerScene.ts`.

This is deliberately *not* built by extending the `'sprite'` renderer. That path
draws a trajectory curve, a trail, and exhaust particles along an elliptic arc —
none of which apply to a vehicle pinned to a road, and all of which would keep
running behind a `'pinned'` trajectory flag.

### State

The entire scene is one scalar plus its derivative:

```
worldX      accumulated scroll distance in px
wheelAngle  worldX / wheelRadius
```

Deriving `wheelAngle` from `worldX` rather than integrating it separately means
wheel spin can never drift out of sync with ground speed, at any frame rate or
after a tab-switch stall. `worldX` advances per frame from a clamped `dt`, the
same guard `bgScrollRef` already uses.

### Speed

```
speed(m) = 900 × (0.6 + 0.4·m)   px/s,  clamped to 3600
```

900 px/s at 1.0x is exactly the source clip's pace, so the scene opens at the
speed the animation was authored for. The 4× ceiling is reached at 8.5x. Chosen
over a more aggressive curve because past roughly 4× the city reads as a blur and
the billboards stop being legible — the multiplier readout, not the motion, has
to carry the high end.

Exposed in the theme (`base`, `perMultiplier`, `max`) because it is a feel
parameter that will need tuning against real rounds.

### Phases

| Phase | Behaviour |
|---|---|
| `BETTING` | `worldX` frozen, bus parked, wheels still. Live countdown ring — reuse `drawGifOverlayBetting`. |
| `FLYING` | `worldX += dt · speed(m)`. Wheels spin. Rider sprite cycles. Live multiplier — reuse `drawGifOverlayFlying`. |
| `CRASHED` | Speed decays to 0 over ~400 ms; screen darkens toward `colors.crash`; bus pitches about its rear axle and drops; smoke via the particle system already in `GameCanvas.tsx`. Live crash multiplier. |
| `RESULT` | Hold the crashed frame. |

All text is drawn live, so "READY?" becomes the real countdown and "FAILED!"
carries the real crash point.

### Fit

The strip is 1080 tall and the canvas is not. Everything scales by `H / 1080` —
city, bus, and wheels together — so the bus stays planted on the road at any
canvas aspect. Horizontal tiling repeats the strip as needed, which the existing
`drawBackgroundImage` already demonstrates.

## Theme schema

```ts
export type GameType = 'sprite' | 'gif' | 'scroller';

export interface ThemeScroller {
  city: string;                              // seamless horizontal strip
  bus: string;                               // pinned vehicle body
  busAt?: { x: number; y: number };           // canvas fraction, default { x: 0.42, y: 0.78 }
  wheel?: string;                            // one wheel, hub centred
  wheelRadius?: number;                      // px, in bus-image space
  wheels?: Array<{ x: number; y: number }>;   // hub offsets from bus top-left
  rider?: string;                            // sprite sheet
  riderFrames?: number;
  riderAt?: { x: number; y: number };         // offset from bus top-left
  speed?: { base: number; perMultiplier: number; max: number };
}
```

Mirrored into `packages/creator/src/theme.ts`, which the existing comment in
`types.ts` already requires to stay in sync.

Per-game: the server serves a theme per catalogue game
(`/api/theme?game=<id>`), and each game runs its own engine, so Matw1nner gets
`gameType: 'scroller'` without affecting any other game in the catalogue.

## Verification

Two pure functions carry all the non-trivial logic, and both get an
assert-based test alongside `money.test.ts` and `GameCanvas.fit.test.ts`:

- `scrollSpeed(m, cfg)` — value at 1.0x equals the source pace; clamps at `max`;
  monotonic in `m`.
- `advance(state, dt, cfg)` — `wheelAngle · wheelRadius === worldX` after an
  arbitrary sequence of irregular `dt`s, including one long enough to trip the
  `dt` clamp.

The extraction script's assertions above are the test for the asset pipeline;
they run every time it is invoked.

Visual check: run the client with the Matw1nner theme, confirm the city tiles
without a visible seam over a full 7500 px cycle, and that the bus does not slide
relative to the road as speed changes.

## Out of scope

- **Billboards.** The reconstructed strip contains blank white billboard faces —
  usable later as brand or ad slots at known `worldX` offsets. Do not paint over
  them; nothing is built for them now.
- **Night/dusk variant.** The Launch clip transitions night → day. The betting
  phase will use the daylight city with a code-side tint instead. Add a real
  night strip only if the tint reads badly.
- **Audio.** `ThemeSounds` already exists and is unchanged.
- **The MP4s.** They stay in the repo as extraction source. They are never
  served to players, and `gameType: 'gif'` is left in place for other games.
