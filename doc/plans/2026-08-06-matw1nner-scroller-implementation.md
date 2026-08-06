# Matw1nner Side-Scroller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Matw1nner gameplay scene live from reconstructed sprite assets — a tiling city strip behind a pinned bus whose scroll speed tracks the multiplier — instead of serving 14 MB of MP4.

**Architecture:** A Python script reconstructs `city.webp`, `bus.webp` and `wheel.webp` from the exported loop MP4 (the After Effects project is unavailable). A third `gameType: 'scroller'` renders them as an early-return branch in the `GameCanvas` draw loop, structurally identical to the existing `'gif'` branch. The whole scene is one scalar, `worldX`; wheel rotation is derived from it rather than integrated separately, so spin can never drift out of sync with ground speed.

**Tech Stack:** Python 3 + numpy + Pillow (extraction, dev-time only); TypeScript, React 18, Canvas 2D, Vitest (runtime).

**Design doc:** `doc/plans/2026-08-06-matw1nner-scroller-design.md`

## Global Constraints

- **Do not modify the `'sprite'` or `'gif'` render paths.** The scroller is purely additive; `'gif'` stays in place for other games.
- **No server changes.** `/api/theme` returns the stored theme verbatim (`packages/server/src/http/public.ts:143` — `res.json(g.theme)`), so a new theme field needs no route work.
- **`packages/client/src/theme/types.ts` and `packages/creator/src/theme.ts` must stay in sync.** Both files already carry a comment saying so. Every schema change touches both.
- **Assets are plain URLs, never data URLs.** The theme JSON is cached in `localStorage` (`theme/loader.ts`), which is size-limited.
- Source clip constants, measured — do not re-derive: **1920×1080, 30 fps, 250 frames, pan exactly 30 px/frame, tile width 7500 px.**
- Speed curve: **`900 × (0.6 + 0.4·m)` px/s, clamped to 3600.**
- Vitest resolves in `packages/client` from the hoisted root `node_modules`. Run client tests with `cd packages/client && npx vitest run`.
- Commit messages: no Claude/Anthropic attribution, no co-author trailers.

---

### Task 1: Asset extraction script

Reconstructs the sprite assets from the loop MP4 and writes them where the client serves static files.

**Files:**
- Create: `tools/scroller-assets/extract.py`
- Create: `tools/scroller-assets/README.md`
- Output (committed): `packages/client/public/matw1nner/{city,bus,wheel}.webp`, `packages/client/public/matw1nner/scroller.json`
- Output (not committed): `packages/client/public/matw1nner/_debug-mask.png`

**Interfaces:**
- Consumes: nothing.
- Produces: `scroller.json` with this exact shape, consumed by Task 6's theme preset:
  ```json
  {
    "tileWidth": 7500,
    "sourceHeight": 1080,
    "busY": 660,
    "busXFraction": 0.26,
    "wheelRadius": 33.5,
    "wheels": [{ "x": 173, "y": 343 }, { "x": 284, "y": 343 }, { "x": 726, "y": 341 }]
  }
  ```
  `busY` is the bus image's top edge in source pixels. `wheels[].x/y` are hub offsets from the bus image's top-left, in source pixels. Exact values are whatever the script measures; the ones above are from the validation run and should come out within a pixel or two.

- [ ] **Step 1: Write the extraction script**

Create `tools/scroller-assets/extract.py`:

```python
#!/usr/bin/env python3
"""Reconstruct scroller sprite assets from the Matw1nner loop clip.

The clip pans a uniform 30 px/frame over 250 frames, so world column
(x + 30*i) IS screen column x of frame i. Sampling a fixed 30-px window the
bus never covers rebuilds the whole city with no interpolation and nothing to
inpaint. The bus is the only thing static in screen space, so per-pixel
temporal variance separates it from the city -- and rejects the spinning
wheels for free, which is exactly what we want them to be.

Usage:
    python3 tools/scroller-assets/extract.py \
        "Matw1nner Gameplay Loop Animation/files/Matw1nner Play Loop Animation OPT.mp4"
"""
import json
import subprocess
import sys
import tempfile
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

SHIFT = 30            # px/frame, measured
SAMPLE_X = 1700       # sample column: clear of the bus at every height
STD_THRESHOLD = 18    # temporal std below this == static == bus
BOX = (430, 1450, 640, 1080)   # x0, x1, y0, y1 -- generous bus search region
OUT = Path("packages/client/public/matw1nner")


def load_frames(mp4: Path) -> np.ndarray:
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(mp4), "-vsync", "0",
             f"{td}/f%04d.png"],
            check=True)
        paths = sorted(Path(td).glob("f*.png"))
        return np.stack([np.asarray(Image.open(p).convert("RGB"), np.uint8)
                         for p in paths])


def measure_shift(frames: np.ndarray) -> float:
    """Per-frame horizontal pan, via 1-D FFT cross-correlation on a sky band."""
    def sig(f):
        s = f[:300].mean(axis=(0, 2)).astype(np.float64)
        return (s - s.mean()) * np.hanning(len(s))

    shifts = []
    for i in range(len(frames) - 1):
        a, b = sig(frames[i]), sig(frames[i + 1])
        c = np.fft.irfft(np.fft.rfft(a) * np.conj(np.fft.rfft(b)), n=len(a))
        k = int(np.argmax(c))
        shifts.append(k if k <= len(a) // 2 else k - len(a))
    shifts = np.array(shifts)
    assert shifts.std() < 0.5, \
        f"pan is not constant (std={shifts.std():.2f}); the scroller model does not apply"
    return float(shifts.mean())


def build_panorama(frames: np.ndarray) -> np.ndarray:
    n, h, _, _ = frames.shape
    pano = np.zeros((h, n * SHIFT, 3), np.uint8)
    for i, f in enumerate(frames):
        pano[:, SHIFT * i: SHIFT * (i + 1)] = f[:, SAMPLE_X: SAMPLE_X + SHIFT]
    seam = np.abs(pano[:, 0].astype(np.int16) - pano[:, -1].astype(np.int16)).mean()
    ref = np.abs(pano[:, 0].astype(np.int16)
                 - pano[:, pano.shape[1] // 2].astype(np.int16)).mean()
    assert seam < 5 and seam * 5 < ref, \
        f"strip does not tile: wrap seam {seam:.2f} vs unrelated {ref:.2f}"
    print(f"  panorama {pano.shape[1]}x{pano.shape[0]}, wrap seam {seam:.2f} "
          f"(unrelated cols {ref:.2f})")
    return pano


def label(mask: np.ndarray):
    """4-connected components. Returns (labels, [(size, y0, y1, x0, x1), ...])."""
    lab = np.zeros(mask.shape, np.int32)
    stats = []
    nxt = 0
    for sy in range(mask.shape[0]):
        for sx in range(mask.shape[1]):
            if not mask[sy, sx] or lab[sy, sx]:
                continue
            nxt += 1
            q = deque([(sy, sx)])
            lab[sy, sx] = nxt
            n, y0, y1, x0, x1 = 0, sy, sy, sx, sx
            while q:
                y, x = q.popleft()
                n += 1
                y0, y1, x0, x1 = min(y0, y), max(y1, y), min(x0, x), max(x1, x)
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if (0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1]
                            and mask[ny, nx] and not lab[ny, nx]):
                        lab[ny, nx] = nxt
                        q.append((ny, nx))
            stats.append((n, y0, y1, x0, x1, nxt))
    return lab, stats


def main(mp4: Path):
    print(f"loading {mp4.name}")
    frames = load_frames(mp4)
    n, H, W, _ = frames.shape
    print(f"  {n} frames, {W}x{H}")

    shift = measure_shift(frames)
    assert abs(shift - SHIFT) < 0.5, f"expected {SHIFT} px/frame, measured {shift:.2f}"
    print(f"  pan {shift:.2f} px/frame -> tile {n * SHIFT} px")

    pano = build_panorama(frames)

    # ── bus: temporal variance inside the search box ──────────────────────
    x0b, x1b, y0b, y1b = BOX
    crop = frames[:, y0b:y1b, x0b:x1b].astype(np.float32)
    std = crop.std(axis=0).mean(axis=2)
    static = std < STD_THRESHOLD
    ch, cw = static.shape

    # Holes = moving regions fully enclosed by the bus (wheels, rider, lights).
    # The city touches the box border, so border-touching components are not holes.
    lab, stats = label(~static)
    filled = static.copy()
    holes = []
    for size, y0, y1, x0, x1, idx in stats:
        if y0 == 0 or x0 == 0 or y1 == ch - 1 or x1 == cw - 1 or size < 400:
            continue
        holes.append((size, y0, y1, x0, x1))
        filled |= lab == idx

    # Trim the road: it is static tarmac, so it survives the variance test, but
    # it spans the full crop width whereas the bus bottom is only three wheels.
    keep_rows = filled.mean(axis=1) < 0.9
    filled &= keep_rows[:, None]
    # Trim columns/rows that hold too little to be bus.
    cols = np.where(filled.sum(axis=0) > 60)[0]
    rows = np.where(filled.sum(axis=1) > 60)[0]
    by0, by1, bx0, bx1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    print(f"  bus bbox in source coords: x{x0b + bx0}-{x0b + bx1} y{y0b + by0}-{y0b + by1}")

    # ── wheels: circular holes low in the bus, sharing a common axle height ──
    cands = [h for h in holes
             if 0.85 < (h[4] - h[3] + 1) / (h[2] - h[1] + 1) < 1.18
             and (h[1] + h[2]) / 2 > by0 + (by1 - by0) * 0.6]
    assert len(cands) >= 2, f"expected >=2 wheels, found {len(cands)}"
    radius = float(np.mean([(h[4] - h[3] + 1 + h[2] - h[1] + 1) / 4 for h in cands]))
    wheels = sorted(({"x": int((h[3] + h[4]) / 2) - bx0,
                      "y": int((h[1] + h[2]) / 2) - by0} for h in cands),
                    key=lambda w: w["x"])
    print(f"  {len(wheels)} wheels, radius {radius:.1f}, hubs {wheels}")

    # ── write assets ──────────────────────────────────────────────────────
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pano).save(OUT / "city.webp", "WEBP", quality=78, method=6)

    ref = frames[120]  # any frame: the bus is identical in all of them
    rgb = ref[y0b + by0: y0b + by1, x0b + bx0: x0b + bx1]
    alpha = (filled[by0:by1, bx0:bx1] * 255).astype(np.uint8)
    Image.fromarray(np.dstack([rgb, alpha])).save(
        OUT / "bus.webp", "WEBP", quality=90, method=6)
    Image.fromarray(alpha).save(OUT / "_debug-mask.png")

    # One wheel, hub centred, circular alpha.
    r = int(round(radius))
    wx, wy = wheels[0]["x"] + bx0 + x0b, wheels[0]["y"] + by0 + y0b
    wrgb = ref[wy - r: wy + r, wx - r: wx + r]
    yy, xx = np.mgrid[-r:r, -r:r]
    walpha = ((yy ** 2 + xx ** 2 <= r * r) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([wrgb, walpha])).save(
        OUT / "wheel.webp", "WEBP", quality=90, method=6)

    (OUT / "scroller.json").write_text(json.dumps({
        "tileWidth": pano.shape[1],
        "sourceHeight": H,
        "busY": int(y0b + by0),
        "busXFraction": round((x0b + bx0) / W, 4),
        "wheelRadius": round(radius, 1),
        "wheels": wheels,
    }, indent=2) + "\n")

    for f in sorted(OUT.iterdir()):
        print(f"  wrote {f.name}  {f.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
```

- [ ] **Step 2: Write the README**

Create `tools/scroller-assets/README.md`:

```markdown
# Scroller asset extraction

Rebuilds the `gameType: 'scroller'` sprite assets from an exported gameplay
loop clip. Run it whenever the artist ships a revised animation — the assets in
`packages/client/public/matw1nner/` are generated, not hand-made.

    pip3 install numpy pillow      # ffmpeg must also be on PATH
    python3 tools/scroller-assets/extract.py \
        "Matw1nner Gameplay Loop Animation/files/Matw1nner Play Loop Animation OPT.mp4"

## What it assumes

The clip must be a seamless loop of a **uniform horizontal pan** with the
vehicle pinned in screen space. The script asserts this rather than trusting
it, and fails loudly if a new clip breaks the model:

- pan is constant (std of per-frame shift < 0.5 px)
- pan matches the expected 30 px/frame
- the rebuilt strip tiles (wrap seam < 5/255, and 5× lower than an unrelated
  column pair)
- at least two wheels are found

## After running

Look at `_debug-mask.png`. It is the bus alpha channel. The silhouette should
be a clean bus with circular holes where the wheels are. If the road has
smeared into the bottom or a chunk of city has leaked in, adjust `STD_THRESHOLD`
or `BOX` at the top of the script. This one glance is worth more than any
further heuristic — do not skip it.

`_debug-mask.png` is a working file and is not committed.
```

- [ ] **Step 3: Run the extraction**

Run from the repo root:

```bash
pip3 install numpy pillow
python3 tools/scroller-assets/extract.py \
    "Matw1nner Gameplay Loop Animation/files/Matw1nner Play Loop Animation OPT.mp4"
```

Expected output — every assertion passes and it prints roughly:

```
  250 frames, 1920x1080
  pan 30.00 px/frame -> tile 7500 px
  panorama 7500x1080, wrap seam 2.48 (unrelated cols 35.50)
  bus bbox in source coords: x490-1390 y660-1040
  3 wheels, radius 33.5, hubs [{'x': 173, 'y': 343}, ...]
  wrote bus.webp  55 KB
  wrote city.webp  394 KB
  wrote wheel.webp  5 KB
```

If any assertion fires, stop and fix the script — do not weaken the assertion to make it pass.

- [ ] **Step 4: Eyeball the mask**

Open `packages/client/public/matw1nner/_debug-mask.png`. It must show a clean white bus silhouette with circular black holes at the three wheels. A grey bar along the bottom means the road-trim rule failed; leaked city means `STD_THRESHOLD` is too high.

Also open `city.webp` and confirm it is a continuous cityscape with no vertical seam or ghosting, and `bus.webp` has fully transparent surroundings.

- [ ] **Step 5: Ignore the debug file and commit**

```bash
echo "packages/client/public/matw1nner/_debug-mask.png" >> .gitignore
git add tools/scroller-assets .gitignore packages/client/public/matw1nner
git commit -m "feat(scroller): reconstruct Matw1nner sprite assets from the loop clip

The After Effects project is unavailable, so the city strip and bus sprite are
rebuilt from the exported MP4. The clip pans a uniform 30px/frame over 250
frames, which makes world column (x+30i) exactly screen column x of frame i --
so the 7500px strip comes out pixel-exact and seamless rather than stitched.
The bus falls out of per-pixel temporal variance, which also isolates the
wheels as separate sprites. ~600KB replaces 14MB of video."
```

---

### Task 2: Theme schema and the speed curve

**Files:**
- Modify: `packages/client/src/theme/types.ts` (`GameType` at line 69, add `ThemeScroller`, add `Theme.scroller`)
- Modify: `packages/creator/src/theme.ts` (`GameType` at line 108, mirror the same additions)
- Modify: `packages/client/package.json` (add a `test` script)
- Create: `packages/client/src/components/ScrollerScene.test.ts`
- Create: `packages/client/src/components/ScrollerScene.ts`

**Interfaces:**
- Consumes: `scroller.json` field names from Task 1.
- Produces:
  - `type GameType = 'sprite' | 'gif' | 'scroller'`
  - `interface ScrollerSpeed { base: number; perMultiplier: number; max: number }`
  - `interface ThemeScroller { city, bus, wheel?, busY, busXFraction?, wheelRadius?, wheels?, speed? }`
  - `Theme.scroller?: ThemeScroller`
  - `DEFAULT_SCROLLER_SPEED: ScrollerSpeed`
  - `scrollSpeed(m: number, cfg?: ScrollerSpeed): number`

- [ ] **Step 1: Add the `test` script to the client package**

In `packages/client/package.json`, add to `"scripts"`:

```json
    "test": "vitest run",
```

Vitest resolves from the hoisted root `node_modules` — no new dependency is needed.

- [ ] **Step 2: Write the failing test**

Create `packages/client/src/components/ScrollerScene.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scrollSpeed, DEFAULT_SCROLLER_SPEED } from './ScrollerScene';

describe('scrollSpeed', () => {
  it('matches the source clip pace at 1.00x', () => {
    // The loop animation pans 30px/frame at 30fps = 900px/s. The scene must
    // open at exactly the speed the artwork was authored for.
    expect(scrollSpeed(1)).toBe(900);
  });

  it('accelerates with the multiplier', () => {
    expect(scrollSpeed(2)).toBeCloseTo(1260, 5);
    expect(scrollSpeed(5)).toBeCloseTo(2340, 5);
  });

  it('clamps at the ceiling so the city never becomes a strobe', () => {
    expect(scrollSpeed(10)).toBe(3600);
    expect(scrollSpeed(1000)).toBe(3600);
  });

  it('is monotonic up to the clamp', () => {
    let prev = 0;
    for (let m = 1; m <= 8.5; m += 0.25) {
      const v = scrollSpeed(m);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('treats a sub-1 multiplier as 1 (never scrolls backwards)', () => {
    expect(scrollSpeed(0)).toBe(900);
    expect(scrollSpeed(-5)).toBe(900);
  });

  it('honours a custom curve from the theme', () => {
    const cfg = { base: 100, perMultiplier: 1, max: 1e9 };
    expect(scrollSpeed(3, cfg)).toBeCloseTo(300, 5);
  });

  it('exposes the design defaults', () => {
    expect(DEFAULT_SCROLLER_SPEED).toEqual({ base: 900, perMultiplier: 0.4, max: 3600 });
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd packages/client && npx vitest run ScrollerScene`
Expected: FAIL — `Failed to resolve import "./ScrollerScene"`.

- [ ] **Step 4: Add the theme types**

In `packages/client/src/theme/types.ts`, replace the `GameType` line (line 69):

```ts
/** Three crash-game rendering modes: procedural sprite-on-curve, full-screen
 *  clips, or a live-rendered side-scroller (tiling strip + pinned vehicle). */
export type GameType = 'sprite' | 'gif' | 'scroller';
```

Then add below `ThemeGifs`:

```ts
/** How world scroll speed responds to the multiplier: base·(1−k+k·m), capped. */
export interface ScrollerSpeed {
  base: number;          // px/s at 1.00x — match the source clip's pace
  perMultiplier: number; // k: 0 = constant, 1 = fully proportional
  max: number;           // px/s ceiling
}

/**
 * Assets and geometry for gameType === 'scroller'.
 *
 * All geometry is in SOURCE pixels (the resolution the artwork was authored
 * at), not canvas pixels. The strip is cover-fit to the canvas height, and
 * everything else scales by the same factor, which is what keeps the vehicle
 * planted on the road at any canvas aspect ratio.
 */
export interface ThemeScroller {
  city: string;                              // seamless horizontal strip
  bus: string;                               // pinned vehicle body
  wheel?: string | null;                     // one wheel, hub centred
  busY: number;                              // vehicle top edge, source px
  busXFraction?: number;                     // horizontal position, 0–1 of canvas
  wheelRadius?: number;                      // source px
  wheels?: Array<{ x: number; y: number }>;  // hub offsets from the bus top-left
  speed?: ScrollerSpeed;
}
```

And add to the `Theme` interface, after `gifs`:

```ts
  /** Scroller assets + geometry, used only when gameType === 'scroller'. */
  scroller?: ThemeScroller;
```

- [ ] **Step 5: Mirror into the creator**

Apply the identical three edits to `packages/creator/src/theme.ts`: widen `GameType` (line 108) to include `'scroller'`, add `ScrollerSpeed` and `ThemeScroller` after `ThemeGifs`, and add `scroller?: ThemeScroller;` to `Theme` after `gifs`. Also extend the mode comment block above `GameType` with:

```
//   • 'scroller' — live-rendered side-scroller: a seamless city strip tiles
//     behind a vehicle pinned in screen space, scroll speed tracking the
//     multiplier. Assets are reconstructed by tools/scroller-assets/.
```

- [ ] **Step 6: Write the minimal implementation**

Create `packages/client/src/components/ScrollerScene.ts`:

```ts
import type { ScrollerSpeed } from '../theme/types';

/**
 * Matches the source animation: it pans 30px/frame at 30fps = 900px/s, so the
 * scene opens at exactly the pace the artwork was drawn for. The 4× ceiling is
 * reached at 8.5x — past roughly that the city reads as a blur and the
 * multiplier readout, not the motion, has to carry the high end.
 */
export const DEFAULT_SCROLLER_SPEED: ScrollerSpeed = {
  base: 900,
  perMultiplier: 0.4,
  max: 3600,
};

/** World scroll speed in px/s at multiplier `m`. */
export function scrollSpeed(m: number, cfg: ScrollerSpeed = DEFAULT_SCROLLER_SPEED): number {
  const k = cfg.perMultiplier;
  const safe = Math.max(1, m);
  return Math.min(cfg.max, cfg.base * (1 - k + k * safe));
}
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/client && npx vitest run`
Expected: PASS — 7 new tests plus the 12 existing ones (`money.test.ts`, `GameCanvas.fit.test.ts`) = 19 passing.

- [ ] **Step 8: Typecheck and commit**

```bash
cd packages/client && npx tsc --noEmit
cd ../creator && npx tsc --noEmit
```
Expected: no errors.

```bash
git add packages/client/src/theme/types.ts packages/creator/src/theme.ts \
        packages/client/package.json packages/client/src/components/ScrollerScene.ts \
        packages/client/src/components/ScrollerScene.test.ts
git commit -m "feat(scroller): add the scroller game type and speed curve

900px/s at 1.00x matches the source animation's pace exactly, so the scene
opens at the speed the artwork was authored for, and caps at 4x (reached at
8.5x) to keep the city legible at the high end."
```

---

### Task 3: World state — `advance` and derived wheel rotation

**Files:**
- Modify: `packages/client/src/components/ScrollerScene.ts`
- Modify: `packages/client/src/components/ScrollerScene.test.ts`

**Interfaces:**
- Consumes: `scrollSpeed` from Task 2.
- Produces:
  - `interface ScrollerState { worldX: number; lastFrameMs: number }`
  - `createScrollerState(): ScrollerState`
  - `advance(state: ScrollerState, nowMs: number, speedPxPerSec: number): void`
  - `wheelAngle(worldX: number, wheelRadius: number): number`
  - `MAX_FRAME_DT = 0.1`

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/components/ScrollerScene.test.ts`, **extend the existing import** (do not add a second import from the same module):

```ts
import {
  scrollSpeed, DEFAULT_SCROLLER_SPEED,
  advance, createScrollerState, wheelAngle, MAX_FRAME_DT,
} from './ScrollerScene';
```

Then append:

```ts
describe('advance', () => {
  it('does not jump on the first frame (no origin time yet)', () => {
    const s = createScrollerState();
    advance(s, 5_000_000, 900);
    expect(s.worldX).toBe(0);
  });

  it('accumulates distance across frames', () => {
    const s = createScrollerState();
    advance(s, 1000, 900);   // establishes the clock
    advance(s, 1100, 900);   // 100ms at 900px/s
    expect(s.worldX).toBeCloseTo(90, 5);
    advance(s, 1200, 900);
    expect(s.worldX).toBeCloseTo(180, 5);
  });

  it('clamps a long stall so a backgrounded tab does not teleport the city', () => {
    const s = createScrollerState();
    advance(s, 1000, 900);
    advance(s, 31_000, 900); // 30s stall
    expect(s.worldX).toBeCloseTo(MAX_FRAME_DT * 900, 5); // 90px, not 27000px
  });

  it('never moves backwards if the clock goes non-monotonic', () => {
    const s = createScrollerState();
    advance(s, 1000, 900);
    advance(s, 900, 900);
    expect(s.worldX).toBe(0);
  });

  it('is still at zero speed', () => {
    const s = createScrollerState();
    advance(s, 1000, 0);
    advance(s, 1100, 0);
    expect(s.worldX).toBe(0);
  });
});

describe('wheelAngle', () => {
  it('completes one rotation per circumference travelled', () => {
    const r = 33.5;
    expect(wheelAngle(2 * Math.PI * r, r)).toBeCloseTo(2 * Math.PI, 5);
  });

  it('stays exactly in lockstep with worldX after irregular frames', () => {
    // Derived, never integrated — this is the property that makes wheel spin
    // impossible to desync from ground speed. Guard it against a future
    // "optimisation" into a separate accumulator.
    const s = createScrollerState();
    const r = 33.5;
    let t = 1000;
    advance(s, t, 900);
    for (const dt of [16, 33, 8, 250, 16, 4, 120]) {
      t += dt;
      advance(s, t, scrollSpeed(1 + t / 5000));
      expect(wheelAngle(s.worldX, r) * r).toBeCloseTo(s.worldX, 9);
    }
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd packages/client && npx vitest run ScrollerScene`
Expected: FAIL — `advance`, `createScrollerState`, `wheelAngle`, `MAX_FRAME_DT` are not exported.

- [ ] **Step 3: Implement**

Append to `packages/client/src/components/ScrollerScene.ts`:

```ts
/** The whole scene is one scalar. Wheel rotation is derived from it. */
export interface ScrollerState {
  worldX: number;      // accumulated scroll distance, source px
  lastFrameMs: number; // 0 until the first frame establishes the clock
}

export function createScrollerState(): ScrollerState {
  return { worldX: 0, lastFrameMs: 0 };
}

/** Cap on a single frame's delta — a backgrounded tab must not teleport the
 *  city on resume. Same guard the background scroller already uses. */
export const MAX_FRAME_DT = 0.1; // seconds

export function advance(state: ScrollerState, nowMs: number, speedPxPerSec: number): void {
  const last = state.lastFrameMs || nowMs;
  const dt = Math.min(MAX_FRAME_DT, Math.max(0, (nowMs - last) / 1000));
  state.lastFrameMs = nowMs;
  state.worldX += dt * speedPxPerSec;
}

/**
 * Wheel rotation in radians. Derived from worldX rather than integrated
 * separately, so spin cannot drift out of sync with ground speed at any frame
 * rate or after a stall. Do not turn this into an accumulator.
 */
export function wheelAngle(worldX: number, wheelRadius: number): number {
  return worldX / Math.max(1, wheelRadius);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/client && npx vitest run`
Expected: PASS — 26 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/ScrollerScene.ts \
        packages/client/src/components/ScrollerScene.test.ts
git commit -m "feat(scroller): world state with derived wheel rotation

Wheel angle is computed from worldX rather than integrated alongside it, so
spin cannot desync from ground speed at any frame rate. Frame delta is clamped
so a backgrounded tab does not teleport the city on resume."
```

---

### Task 4: Draw the scene and wire up BETTING + FLYING

At the end of this task the game visibly runs: the city tiles and scrolls, the bus sits on the road, the wheels spin at ground speed.

**Files:**
- Modify: `packages/client/src/components/ScrollerScene.ts`
- Modify: `packages/client/src/components/GameCanvas.tsx` (image refs at line 229, draw loop after the `'gif'` branch at line 286)

**Interfaces:**
- Consumes: `ScrollerState`, `advance`, `wheelAngle`, `scrollSpeed` from Tasks 2–3; `ThemeScroller` from Task 2.
- Produces:
  - `interface ScrollerImages { city, bus, wheel: HTMLImageElement | null }`
  - `drawScrollerWorld(ctx, W, H, state, images, cfg: ThemeScroller, tiltRad?, dropPx?): boolean` — returns `false` if the city image is not ready yet, so the caller can skip the frame.

- [ ] **Step 1: Implement the draw function**

In `packages/client/src/components/ScrollerScene.ts`, **extend the existing type import** at the top of the file:

```ts
import type { ScrollerSpeed, ThemeScroller } from '../theme/types';
```

Then append:

```ts
export interface ScrollerImages {
  city: HTMLImageElement | null;
  bus: HTMLImageElement | null;
  wheel: HTMLImageElement | null;
}

function ready(img: HTMLImageElement | null): HTMLImageElement | null {
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/**
 * Draw the world: tiling city strip, then the pinned vehicle with rotating
 * wheels. Returns false when the city image is not loaded yet.
 *
 * Everything scales by H / sourceHeight, so the vehicle stays planted on the
 * road whatever the canvas aspect. `tiltRad` and `dropPx` are the crash
 * animation's pitch (about the rear axle) and fall; both zero in flight.
 */
export function drawScrollerWorld(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  state: ScrollerState,
  images: ScrollerImages,
  cfg: ThemeScroller,
  tiltRad = 0,
  dropPx = 0,
): boolean {
  const city = ready(images.city);
  if (!city) return false;

  const scale = H / city.naturalHeight;
  const tileW = city.naturalWidth * scale;

  // ── city: tile horizontally from the scroll offset ──────────────────────
  let x = -((state.worldX * scale) % tileW);
  if (x > 0) x -= tileW;
  for (; x < W; x += tileW) ctx.drawImage(city, x, 0, tileW, H);

  // ── vehicle ─────────────────────────────────────────────────────────────
  const bus = ready(images.bus);
  if (!bus) return true;

  const busW = bus.naturalWidth * scale;
  const busH = bus.naturalHeight * scale;
  const busX = W * (cfg.busXFraction ?? 0.26);
  const busY = cfg.busY * scale + dropPx;

  const radius = (cfg.wheelRadius ?? 34) * scale;
  const hubs = cfg.wheels ?? [];
  // Pitch about the rear axle (leftmost hub) so the nose lifts, as a vehicle does.
  const pivotX = busX + (hubs.length ? hubs[0].x * scale : busW * 0.2);
  const pivotY = busY + (hubs.length ? hubs[0].y * scale : busH);

  ctx.save();
  if (tiltRad !== 0) {
    ctx.translate(pivotX, pivotY);
    ctx.rotate(tiltRad);
    ctx.translate(-pivotX, -pivotY);
  }
  ctx.drawImage(bus, busX, busY, busW, busH);

  const wheel = ready(images.wheel);
  if (wheel) {
    const ang = wheelAngle(state.worldX, cfg.wheelRadius ?? 34);
    for (const hub of hubs) {
      ctx.save();
      ctx.translate(busX + hub.x * scale, busY + hub.y * scale);
      ctx.rotate(ang);
      ctx.drawImage(wheel, -radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }
  ctx.restore();
  return true;
}
```

- [ ] **Step 2: Load the scroller images in GameCanvas**

In `packages/client/src/components/GameCanvas.tsx`, extend the `useImageRefs` call (line 229) with three keys:

```ts
  const spriteRefs = useImageRefs({
    legacy:  theme?.assets?.sprite ?? null,
    ground:  theme?.assets?.spriteGround ?? null,
    flying:  theme?.assets?.spriteFlying ?? null,
    crashed: theme?.assets?.spriteCrashed ?? null,
    bg:      theme?.assets?.background ?? null,
    city:    theme?.scroller?.city ?? null,
    bus:     theme?.scroller?.bus ?? null,
    wheel:   theme?.scroller?.wheel ?? null,
  });
```

- [ ] **Step 3: Add the scroller state ref**

Below `bgScrollRef` (line 224) add:

```ts
  const scrollerRef = useRef<ScrollerState>(createScrollerState());
```

And extend the existing import block at the top of the file:

```ts
import {
  createScrollerState, advance, scrollSpeed, drawScrollerWorld,
  type ScrollerState,
} from './ScrollerScene';
```

- [ ] **Step 4: Add the draw branch**

In the `draw` function, immediately after the closing brace of the `'gif'` branch (line 286) and before `const bgImg = spriteRefs.bg.current;`, insert:

```ts
      // ── Scroller mode: live-rendered side-scroller ────────────────────
      if (theme?.gameType === 'scroller' && theme.scroller) {
        const cfg = theme.scroller;
        // Interpolate locally so speed is smooth between the 50ms WS ticks.
        const m = phase === 'FLYING'
          ? liveMultiplier(flightStartTime, serverClockOffsetMs, currentMultiplier, crashPoint)
          : currentMultiplier;
        // Only FLYING moves the world. BETTING parks the bus; CRASHED is
        // handled in Task 5.
        const speed = phase === 'FLYING' ? scrollSpeed(m, cfg.speed) : 0;
        advance(scrollerRef.current, Date.now(), speed);

        const images = {
          city:  spriteRefs.city.current,
          bus:   spriteRefs.bus.current,
          wheel: spriteRefs.wheel.current,
        };
        if (drawScrollerWorld(ctx, W, H, scrollerRef.current, images, cfg)) {
          if (phase === 'BETTING') drawGifOverlayBetting(ctx, W, H, dpr, countdownMs);
          else if (phase === 'FLYING') drawGifOverlayFlying(ctx, W, H, dpr, m, getMultiplierColor(m));
          else drawGifOverlayCrashed(ctx, W, H, dpr, crashPoint ?? currentMultiplier, theme.colors.crash);
        }
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }
```

Note the overlay helpers are the ones the `'gif'` mode already uses (`GameCanvas.tsx:464`, `:488`, `:514`) — reused unchanged, so the countdown, multiplier and crash readouts are live text over the rendered scene.

- [ ] **Step 5: Typecheck**

Run: `cd packages/client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the existing tests**

Run: `cd packages/client && npx vitest run`
Expected: PASS — 26 tests, unchanged. (`drawScrollerWorld` needs a canvas and is verified visually in Task 6, not unit-tested.)

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/ScrollerScene.ts \
        packages/client/src/components/GameCanvas.tsx
git commit -m "feat(scroller): draw the tiling city and pinned bus

Added as an early-return branch alongside the existing gif branch, so the
sprite and gif paths are untouched. Geometry is in source pixels scaled by
H/sourceHeight, which keeps the bus planted on the road at any canvas aspect."
```

---

### Task 5: Crash and result phases

**Files:**
- Modify: `packages/client/src/components/ScrollerScene.ts`
- Modify: `packages/client/src/components/ScrollerScene.test.ts`
- Modify: `packages/client/src/components/GameCanvas.tsx` (the branch added in Task 4)

**Interfaces:**
- Consumes: `drawScrollerWorld` from Task 4; `crashAnimRef` already present in `GameCanvas.tsx:223`.
- Produces: `crashPose(elapsedMs: number): { tiltRad: number; dropPx: number; darken: number; speedScale: number }`

- [ ] **Step 1: Write the failing test**

In `packages/client/src/components/ScrollerScene.test.ts`, add `crashPose` to the existing import, then append:

```ts
describe('crashPose', () => {
  it('starts undisturbed at the moment of the crash', () => {
    const p = crashPose(0);
    expect(p.tiltRad).toBe(0);
    expect(p.dropPx).toBe(0);
    expect(p.darken).toBe(0);
    expect(p.speedScale).toBe(1);
  });

  it('coasts to a stop rather than stopping dead', () => {
    expect(crashPose(200).speedScale).toBeGreaterThan(0);
    expect(crashPose(200).speedScale).toBeLessThan(1);
    expect(crashPose(400).speedScale).toBe(0);
    expect(crashPose(5000).speedScale).toBe(0);
  });

  it('pitches the nose up and settles back', () => {
    const mid = crashPose(450).tiltRad;
    expect(mid).toBeLessThan(0);           // negative == nose up in canvas coords
    expect(Math.abs(mid)).toBeGreaterThan(Math.abs(crashPose(880).tiltRad));
  });

  it('darkens toward the crash screen and holds', () => {
    expect(crashPose(450).darken).toBeGreaterThan(0);
    expect(crashPose(900).darken).toBeCloseTo(0.82, 2);
    expect(crashPose(9000).darken).toBeCloseTo(0.82, 2);
  });

  it('never overshoots its bounds however long the result phase runs', () => {
    for (const t of [0, 100, 900, 5000, 60_000]) {
      const p = crashPose(t);
      expect(p.darken).toBeGreaterThanOrEqual(0);
      expect(p.darken).toBeLessThanOrEqual(0.82);
      expect(p.speedScale).toBeGreaterThanOrEqual(0);
      expect(p.dropPx).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd packages/client && npx vitest run ScrollerScene`
Expected: FAIL — `crashPose` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/client/src/components/ScrollerScene.ts`:

```ts
const CRASH_COAST_MS = 400;  // world decelerates to a stop over this
const CRASH_ANIM_MS  = 900;  // pitch + drop + darkening settle by here
const CRASH_DARKEN   = 0.82; // final overlay opacity

/** Crash animation pose at `elapsedMs` after the crash. Pure — see tests. */
export function crashPose(elapsedMs: number): {
  tiltRad: number; dropPx: number; darken: number; speedScale: number;
} {
  const t = Math.max(0, elapsedMs);
  const coast = Math.max(0, 1 - t / CRASH_COAST_MS);
  const k = Math.min(1, t / CRASH_ANIM_MS);
  return {
    // Nose lifts then settles: one half-sine over the animation window.
    tiltRad: -0.26 * Math.sin(Math.PI * k),
    dropPx: 26 * k * k,
    darken: CRASH_DARKEN * k,
    speedScale: coast,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/client && npx vitest run`
Expected: PASS — 31 tests.

- [ ] **Step 5: Wire the crash into the draw branch**

In `GameCanvas.tsx`, replace the speed line and the draw call inside the scroller branch with:

```ts
        const crashElapsed = crashAnimRef.current && (phase === 'CRASHED' || phase === 'RESULT')
          ? Date.now() - crashAnimRef.current.startTime
          : -1;
        const pose = crashElapsed >= 0 ? crashPose(crashElapsed) : null;

        const speed = phase === 'FLYING'
          ? scrollSpeed(m, cfg.speed)
          : pose
            ? scrollSpeed(crashPoint ?? currentMultiplier, cfg.speed) * pose.speedScale
            : 0;
        advance(scrollerRef.current, Date.now(), speed);

        const images = {
          city:  spriteRefs.city.current,
          bus:   spriteRefs.bus.current,
          wheel: spriteRefs.wheel.current,
        };
        const drawn = drawScrollerWorld(
          ctx, W, H, scrollerRef.current, images, cfg,
          pose?.tiltRad ?? 0, pose?.dropPx ?? 0,
        );
        if (drawn) {
          if (pose) {
            ctx.fillStyle = `rgba(26, 4, 4, ${pose.darken})`;
            ctx.fillRect(0, 0, W, H);
          }
          if (phase === 'BETTING') drawGifOverlayBetting(ctx, W, H, dpr, countdownMs);
          else if (phase === 'FLYING') drawGifOverlayFlying(ctx, W, H, dpr, m, getMultiplierColor(m));
          else drawGifOverlayCrashed(ctx, W, H, dpr, crashPoint ?? currentMultiplier, theme.colors.crash);
        }
```

Add `crashPose` to the `./ScrollerScene` import.

The bus coasts from its crash-point speed to a standstill over 400 ms rather than stopping dead, so the crash reads as an impact rather than a dropped frame.

- [ ] **Step 6: Typecheck and commit**

Run: `cd packages/client && npx tsc --noEmit`
Expected: no errors.

```bash
git add packages/client/src/components/ScrollerScene.ts \
        packages/client/src/components/ScrollerScene.test.ts \
        packages/client/src/components/GameCanvas.tsx
git commit -m "feat(scroller): crash pose — coast, pitch, drop and darken

The world decelerates from its crash-point speed over 400ms instead of
stopping dead, so the crash reads as an impact rather than a dropped frame."
```

---

### Task 6: Matw1nner theme preset and end-to-end verification

**Files:**
- Modify: `packages/creator/src/theme.ts` (add to `PRESETS`)
- Read: `packages/client/public/matw1nner/scroller.json` (produced by Task 1)

**Interfaces:**
- Consumes: everything above.
- Produces: a `matw1nner` entry in `PRESETS`, loadable from the Creator UI.

- [ ] **Step 1: Add the preset**

Read `packages/client/public/matw1nner/scroller.json` and copy its measured values into a new entry in the `PRESETS` record in `packages/creator/src/theme.ts`. Use the values from the file, not the illustrative ones here:

```ts
  matw1nner: {
    brandName: 'Matw1nner',
    brandTagline: 'Ride the multiplier',
    sprite: 'rocket',        // unused in scroller mode
    background: 'sunset',    // unused in scroller mode
    colors: {
      bgFrom: '#1a0404',
      bgTo:   '#0d0202',
      accent: '#f5b301',
      accent2:'#e63946',
      win:    '#34d399',
      crash:  '#e63946',
      gold:   '#f5b301',
      text:   '#f5f0e6',
    },
    rtp: 0.97,
    growthRate: 0.06,
    bettingMs: 5000,
    maxMultiplier: 10000,
    gameType: 'scroller',
    scroller: {
      city:  '/matw1nner/city.webp',
      bus:   '/matw1nner/bus.webp',
      wheel: '/matw1nner/wheel.webp',
      busY: 660,
      busXFraction: 0.26,
      wheelRadius: 33.5,
      wheels: [{ x: 173, y: 343 }, { x: 284, y: 343 }, { x: 726, y: 341 }],
      speed: { base: 900, perMultiplier: 0.4, max: 3600 },
    },
  },
```

- [ ] **Step 2: Typecheck both packages**

```bash
cd packages/client && npx tsc --noEmit
cd ../creator && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Run the app**

```bash
npm run dev
```

Open the client, then load the Matw1nner theme through the Creator UI (or set it as the active theme) so `gameType: 'scroller'` is applied.

- [ ] **Step 4: Verify each phase by eye**

Check all of these — this is the real test for the rendering, which unit tests cannot reach:

1. **BETTING** — city is stationary, bus parked on the road, wheels still, countdown ring and "PLACE YOUR BET" legible over the scene.
2. **FLYING at ~1.0x** — city scrolls left at roughly the pace of the original clip. Compare side by side with `Matw1nner Gameplay Loop Animation/demo/loop-720p.mp4`; they should look about the same speed.
3. **FLYING as the multiplier climbs** — city visibly accelerates, wheels speed up in step with the ground. Watch the wheel contact point: it must not appear to slip or spin backwards.
4. **Tiling** — let a round run past ~9 seconds (one full 7500 px cycle at base speed) and confirm no vertical seam or jump as the strip wraps.
5. **CRASHED** — bus coasts to a stop over ~0.4 s, nose pitches up and settles, screen darkens to the maroon, crash multiplier legible.
6. **RESULT** — the darkened crashed frame holds steady.
7. **Resize** the window tall and narrow, then short and wide. The bus must stay on the road in both — it must not float above it or sink below.
8. **Background the tab for 30 s**, then return. The city must not teleport forward.

- [ ] **Step 5: Confirm the other render modes still work**

Load a `gameType: 'sprite'` preset (e.g. `galaxy`) and a `gameType: 'gif'` game, and confirm both still render exactly as before. The scroller branch must not have disturbed them.

- [ ] **Step 6: Commit**

```bash
git add packages/creator/src/theme.ts
git commit -m "feat(scroller): add the Matw1nner preset

Geometry copied from the measurements the extraction script emits, so the bus
sits exactly where it did in the source animation."
```

---

## Self-Review

**Spec coverage:**

| Design section | Task |
|---|---|
| Asset reconstruction (panorama, variance matte) | 1 |
| Pipeline is a checked-in script with assertions | 1 |
| Assets as static URLs, not data URLs | 1 (output path), 6 (preset URLs) |
| `'scroller'` game type, schema mirrored to creator | 2 |
| Speed curve `900×(0.6+0.4m)` capped at 3600 | 2 |
| `worldX` single scalar, derived wheel angle | 3 |
| Early-return branch, sprite/gif untouched | 4 |
| Cover-fit by `H/1080`, bus planted on the road | 4, verified 6 §7 |
| BETTING / FLYING phases, live text overlays | 4 |
| CRASHED / RESULT: coast, pitch, drop, darken | 5 |
| Per-game theme, no server change | 6 (preset), Global Constraints |
| Verification: `scrollSpeed`, `advance` lockstep | 2, 3 |
| Visual checks: seam, bus/road registration | 6 |

**Out of scope per the design, deliberately absent from every task:** billboard ad slots, the night/dusk sky variant, audio, and the dancing-rider sprite sheet (the rider stays baked into `bus.webp` as a static figure — the wheels are the only part that must move independently).

**Known gap accepted:** `drawScrollerWorld` and the `GameCanvas` branch have no unit tests. Both need a real canvas, and the behaviour that matters (registration, seam, speed feel) is visual. The pure logic underneath them — `scrollSpeed`, `advance`, `wheelAngle`, `crashPose` — is fully tested, and Task 6 §4 gates the rest by eye.
