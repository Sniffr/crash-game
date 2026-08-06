import { useEffect, useRef } from 'react';
import type { SceneManifest, ThemeColors } from '../theme/types';
import {
  liveMultiplier,
  drawGifOverlayBetting,
  drawGifOverlayFlying,
  drawGifOverlayCrashed,
} from './GameCanvas';

interface ParallaxSceneProps {
  phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';
  flightStartTime: number | null;
  serverClockOffsetMs: number;
  currentMultiplier: number;
  crashPoint?: number;
  countdownMs?: number;
  getMultiplierColor: (m: number) => string;
  scene: SceneManifest;
  colors: ThemeColors;
}

// The scene is authored in the source clip's 1280×720 space; every draw coord
// below is in that space and cover-fitted to the real canvas each frame.
const CW = 1280;
const CH = 720;

/** Scroll speed grows with the multiplier but saturates (from the asset demo). */
function speedFactor(m: number): number {
  return Math.min(0.55 + 0.45 * Math.log2(1 + m), 3.2);
}

/**
 * Layered Canvas-2D renderer for a parallax asset pack (sprite mode). Replaces
 * the heavy per-round MP4 with ~2.9 MB of WebP loaded once: three tiling
 * parallax strips, a composited bus (body + patched passenger sheet + rotating
 * wheels) and a crash sprite-atlas. Motion, phase and text are driven by the
 * real round — not the clip — so the city accelerates with the multiplier.
 */
export default function ParallaxScene(props: ParallaxSceneProps) {
  // Read live inputs through stateRef in the rAF loop; only `scene` is needed
  // directly (image loading + effect deps).
  const { scene } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep the latest render inputs in a ref so the rAF loop (started once) always
  // reads current values without restarting on every prop change.
  const stateRef = useRef(props);
  stateRef.current = props;

  // ── Load images once per asset pack ─────────────────────────────────────────
  const imgsRef = useRef<Record<string, HTMLImageElement>>({});
  const readyRef = useRef(false);
  useEffect(() => {
    const base = scene.baseUrl.replace(/\/$/, '');
    const url = (f: string) => `${base}/${f}`;
    const pick = (o: { webp?: string; src?: string }) => url(o.webp ?? o.src ?? '');
    const jobs: Record<string, string> = {
      sky: pick(scene.layers.sky),
      city: pick(scene.layers.city),
      road: pick(scene.layers.road),
      body: url(scene.bus.body),
      wheel: url(scene.bus.wheel),
      pFly: pick(scene.bus.passenger_fly),
      pIdle: pick(scene.bus.passenger_idle),
      crash: pick(scene.crash),
    };
    readyRef.current = false;
    const imgs: Record<string, HTMLImageElement> = {};
    let loaded = 0;
    const keys = Object.keys(jobs);
    for (const k of keys) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { if (++loaded === keys.length) readyRef.current = true; };
      img.src = jobs[k];
      imgs[k] = img;
    }
    imgsRef.current = imgs;
  }, [scene]);

  // ── One rAF loop for the lifetime of the mount ───────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let scroll = 0;
    let wheelAngle = 0;
    let last = 0;
    let crashStart = 0;      // ms timestamp when CRASHED first seen
    let prevPhase = props.phase;
    let vWorldPrev = 0;      // carried into CRASHED for deceleration

    const tile = (ctx: CanvasRenderingContext2D, img: HTMLImageElement, off: number, dy: number) => {
      const w = img.width;
      if (!w) return;
      let x = -(((off % w) + w) % w);
      while (x < CW) { ctx.drawImage(img, Math.round(x), dy); x += w; }
    };

    const drawBus = (ctx: CanvasRenderingContext2D, t: number, idle: boolean) => {
      const I = imgsRef.current;
      const [ox, oy] = scene.bus.origin;
      ctx.drawImage(I.body, ox, oy);
      // passenger patch fills the punched hole in the body
      const [px, py, pw, ph] = scene.bus.passenger_rect;
      const cfg = idle ? scene.bus.passenger_idle : scene.bus.passenger_fly;
      const sheet = idle ? I.pIdle : I.pFly;
      const f = Math.floor(t * cfg.fps) % cfg.frames;
      const sx = (f % cfg.cols) * pw;
      const sy = Math.floor(f / cfg.cols) * ph;
      ctx.drawImage(sheet, sx, sy, pw, ph, ox + px, oy + py, pw, ph);
      // wheels — rolling speed derived from the road layer velocity
      const S = scene.bus.wheel_src_size, HS = S / 2;
      for (const [wx, wy] of scene.bus.wheels) {
        ctx.save();
        ctx.translate(ox + wx, oy + wy);
        ctx.rotate(wheelAngle);
        ctx.drawImage(I.wheel, -HS, -HS, S, S);
        ctx.restore();
      }
    };

    const drawCrash = (ctx: CanvasRenderingContext2D, tSec: number): boolean => {
      const frames = scene.crash.frames;
      const i = Math.min(frames.length - 1, Math.floor(tSec * scene.crash.fps));
      if (i < 0) return false;
      const fr = frames[i];
      ctx.drawImage(imgsRef.current.crash, fr.a[0], fr.a[1], fr.a[2], fr.a[3], fr.d[0], fr.d[1], fr.a[2], fr.a[3]);
      return Math.floor(tSec * scene.crash.fps) < frames.length;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const W = canvas.width, H = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!readyRef.current) return;

      const s = stateRef.current;
      const now = performance.now();
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;

      if (s.phase !== prevPhase) {
        if (s.phase === 'CRASHED') crashStart = now;
        prevPhase = s.phase;
      }

      // ── phase → grade + world velocity ──
      const g = scene.grade;
      const rampSec = g.launch_ramp_frames / 30;
      let grade = 1;
      let vWorld = 0;
      const m = liveMultiplier(s.flightStartTime, s.serverClockOffsetMs, s.currentMultiplier, s.crashPoint);
      if (s.phase === 'BETTING') {
        grade = g.idle_multiply;
      } else if (s.phase === 'FLYING') {
        const elapsed = s.flightStartTime ? Math.max(0, Date.now() + s.serverClockOffsetMs - s.flightStartTime) / 1000 : 0;
        grade = Math.min(1, g.idle_multiply + (elapsed / rampSec) * (1 - g.idle_multiply));
        vWorld = scene.world.scroll_px_per_sec * speedFactor(m);
        vWorldPrev = vWorld;
      } else if (s.phase === 'CRASHED') {
        const tCrash = (now - crashStart) / 1000;
        vWorld = vWorldPrev * Math.max(0, 1 - tCrash * 2.2);
      } // RESULT: frozen, grade 1

      scroll += vWorld * dt;
      const vRoad = vWorld * scene.layers.road.parallax;
      wheelAngle += (vRoad / scene.bus.wheel_radius) * dt;

      // ── cover-fit 1280×720 into the device canvas ──
      const cover = Math.max(W / CW, H / CH);
      const ox = (W - CW * cover) / 2, oy = (H - CH * cover) / 2;
      ctx.setTransform(cover, 0, 0, cover, ox, oy);

      const I = imgsRef.current;
      tile(ctx, I.sky, scroll * scene.layers.sky.parallax, scene.layers.sky.y);
      tile(ctx, I.city, scroll * scene.layers.city.parallax, scene.layers.city.y);
      tile(ctx, I.road, scroll * scene.layers.road.parallax, scene.layers.road.y);

      // pre-round dusk = flat multiply on the background layers only
      if (grade < 0.999) {
        ctx.fillStyle = `rgba(0,0,0,${(1 - grade).toFixed(3)})`;
        ctx.fillRect(0, 0, CW, CH);
      }

      // actors
      const tPhaseSec = s.phase === 'CRASHED' ? (now - crashStart) / 1000 : now / 1000;
      const busGone = (s.phase === 'CRASHED' && tPhaseSec > 0.1) || s.phase === 'RESULT';
      if (!busGone) drawBus(ctx, tPhaseSec, s.phase === 'BETTING');
      if (s.phase === 'CRASHED') drawCrash(ctx, tPhaseSec);

      // ── our house text overlays (device space) ──
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const tier = s.getMultiplierColor(m);
      if (s.phase === 'BETTING') drawGifOverlayBetting(ctx, W, H, dpr, s.countdownMs);
      else if (s.phase === 'FLYING') drawGifOverlayFlying(ctx, W, H, dpr, m, tier);
      else drawGifOverlayCrashed(ctx, W, H, dpr, s.crashPoint ?? s.currentMultiplier, s.colors.crash);
    };

    raf = requestAnimationFrame(draw);
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />;
}
