import { useEffect, useMemo, useRef } from 'react';
import type { BackgroundMotion, FlightAnimation, FlightTrajectory, Theme } from '../theme/types';
import { DEFAULT_FLIGHT_ANIMATION, DEFAULT_FLIGHT_TRAJECTORY, effectiveBgSpeed } from '../theme/types';

interface GameCanvasProps {
  phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';
  flightStartTime: number | null;
  serverClockOffsetMs: number;
  currentMultiplier: number;
  crashPoint?: number;
  hashCommit?: string;
  countdownMs?: number;
  getMultiplierColor: (m: number) => string;
  theme?: Theme;
}

// Stay in sync with server GROWTH_RATE
const GROWTH_RATE = 0.06;
const ROCKET_W = 84;
const ROCKET_H = 44;

function multiplierAt(elapsedMs: number): number {
  return Math.exp((GROWTH_RATE * Math.max(0, elapsedMs)) / 1000);
}

/**
 * Smooth per-frame FLYING multiplier: interpolate locally from the server
 * flight-start clock every animation frame (~60fps) instead of rendering the
 * 50ms WS ticks, which stutter with network jitter. The server value is a floor
 * (never show less than the server has confirmed); crashPoint is the cap.
 */
export function liveMultiplier(
  flightStartTime: number | null,
  serverClockOffsetMs: number,
  serverMultiplier: number,
  crashPoint?: number,
): number {
  if (!flightStartTime) return serverMultiplier;
  const elapsedMs = Math.max(0, Date.now() + serverClockOffsetMs - flightStartTime);
  let m = multiplierAt(elapsedMs);
  if (m < serverMultiplier) m = serverMultiplier;
  if (crashPoint && m > crashPoint) m = crashPoint;
  return m;
}

// ─── Pre-rendered rocket sprite ────────────────────────────────────────────
// Drawing the rocket once into an offscreen canvas means we get layered
// gradients and detail without paying for them every animation frame.
function buildRocketSprite(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = ROCKET_W * dpr;
  const h = ROCKET_H * dpr;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.translate(ROCKET_W / 2, ROCKET_H / 2);

  // ───── Fins (back, behind body so body overlaps) ─────
  ctx.save();
  const finGrad = ctx.createLinearGradient(0, -20, 0, 20);
  finGrad.addColorStop(0, '#ef4444');
  finGrad.addColorStop(1, '#7f1d1d');
  ctx.fillStyle = finGrad;
  // Top fin
  ctx.beginPath();
  ctx.moveTo(-22, -6);
  ctx.lineTo(-32, -20);
  ctx.lineTo(-12, -8);
  ctx.closePath();
  ctx.fill();
  // Bottom fin
  ctx.beginPath();
  ctx.moveTo(-22, 6);
  ctx.lineTo(-32, 20);
  ctx.lineTo(-12, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ───── Engine nozzle ─────
  ctx.save();
  const nozzleGrad = ctx.createLinearGradient(-30, 0, -22, 0);
  nozzleGrad.addColorStop(0, '#1f2937');
  nozzleGrad.addColorStop(1, '#4b5563');
  ctx.fillStyle = nozzleGrad;
  ctx.beginPath();
  ctx.moveTo(-30, -8);
  ctx.lineTo(-22, -6);
  ctx.lineTo(-22, 6);
  ctx.lineTo(-30, 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();

  // ───── Main body — chrome with red accent stripe ─────
  ctx.save();
  const bodyGrad = ctx.createLinearGradient(0, -10, 0, 10);
  bodyGrad.addColorStop(0, '#f8fafc');
  bodyGrad.addColorStop(0.4, '#cbd5e1');
  bodyGrad.addColorStop(0.6, '#94a3b8');
  bodyGrad.addColorStop(1, '#475569');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  // Body: rounded cylinder with a pointed nose on the right
  ctx.moveTo(-22, -10);
  ctx.lineTo(18, -10);
  ctx.quadraticCurveTo(28, -8, 34, 0); // nose top curve
  ctx.quadraticCurveTo(28, 8, 18, 10);
  ctx.lineTo(-22, 10);
  ctx.quadraticCurveTo(-24, 0, -22, -10);
  ctx.closePath();
  ctx.fill();
  // Subtle outline
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.4)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();

  // ───── Red accent stripe ─────
  ctx.save();
  const stripeGrad = ctx.createLinearGradient(0, -3, 0, 3);
  stripeGrad.addColorStop(0, '#fca5a5');
  stripeGrad.addColorStop(0.5, '#ef4444');
  stripeGrad.addColorStop(1, '#991b1b');
  ctx.fillStyle = stripeGrad;
  ctx.beginPath();
  ctx.moveTo(-20, -2.5);
  ctx.lineTo(20, -2.5);
  ctx.lineTo(22, 2.5);
  ctx.lineTo(-20, 2.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ───── Cockpit window ─────
  ctx.save();
  const winGrad = ctx.createRadialGradient(12, -2, 0, 12, 0, 8);
  winGrad.addColorStop(0, '#bae6fd');
  winGrad.addColorStop(0.5, '#0ea5e9');
  winGrad.addColorStop(1, '#075985');
  ctx.fillStyle = winGrad;
  ctx.beginPath();
  ctx.ellipse(12, 0, 5.5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Glass highlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.beginPath();
  ctx.ellipse(11, -1.4, 2, 1, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.ellipse(12, 0, 5.5, 4, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // ───── Body highlight (top sheen) ─────
  ctx.save();
  const sheen = ctx.createLinearGradient(0, -10, 0, -3);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.moveTo(-18, -9);
  ctx.lineTo(20, -9);
  ctx.quadraticCurveTo(25, -7, 28, -4);
  ctx.lineTo(28, -3);
  ctx.lineTo(-18, -3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ───── Nose tip — red cone ─────
  ctx.save();
  const noseGrad = ctx.createRadialGradient(32, 0, 0, 32, 0, 6);
  noseGrad.addColorStop(0, '#fecaca');
  noseGrad.addColorStop(0.5, '#ef4444');
  noseGrad.addColorStop(1, '#7f1d1d');
  ctx.fillStyle = noseGrad;
  ctx.beginPath();
  ctx.moveTo(28, -4);
  ctx.quadraticCurveTo(34, 0, 28, 4);
  ctx.lineTo(34, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ───── Small rivets along the body ─────
  ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
  for (let x = -16; x <= 16; x += 6) {
    ctx.beginPath();
    ctx.arc(x, -7.5, 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, 7.5, 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

export default function GameCanvas({
  phase,
  flightStartTime,
  serverClockOffsetMs,
  currentMultiplier,
  crashPoint,
  hashCommit,
  countdownMs,
  getMultiplierColor,
  theme,
}: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const starsRef = useRef<Array<{ x: number; y: number; r: number; speed: number; depth: number; tw: number }>>([]);
  const nebulaRef = useRef<Array<{ x: number; y: number; r: number; hue: number; drift: number }>>([]);
  const flameParticlesRef = useRef<Array<{ x: number; y: number; vx: number; vy: number; life: number; max: number; hue: number }>>([]);
  const orbitOffsetRef = useRef(0);
  const crashAnimRef = useRef<{ startTime: number; finalMultiplier: number } | null>(null);
  const bgScrollRef = useRef({ offset: 0, lastFrameMs: 0 });

  const rocket = useMemo(() => buildRocketSprite(), []);

  // Cache custom image assets (re-create when their data URL changes)
  const spriteRefs = useImageRefs({
    legacy:  theme?.assets?.sprite ?? null,
    ground:  theme?.assets?.spriteGround ?? null,
    flying:  theme?.assets?.spriteFlying ?? null,
    crashed: theme?.assets?.spriteCrashed ?? null,
    bg:      theme?.assets?.background ?? null,
  });

  // Stable starfield + nebula
  useEffect(() => {
    const stars: typeof starsRef.current = [];
    for (let i = 0; i < 220; i++) {
      const depth = Math.random();
      stars.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.4 + depth * 1.8,
        speed: 4 + depth * 18,
        depth,
        tw: Math.random() * Math.PI * 2,
      });
    }
    starsRef.current = stars;

    const nebula: typeof nebulaRef.current = [];
    for (let i = 0; i < 4; i++) {
      nebula.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.25 + Math.random() * 0.25,
        hue: [275, 250, 195, 320][i % 4], // violet, indigo, cyan, magenta
        drift: 0.01 + Math.random() * 0.02,
      });
    }
    nebulaRef.current = nebula;
  }, []);

  useEffect(() => {
    if (phase === 'CRASHED') {
      crashAnimRef.current = {
        startTime: Date.now(),
        finalMultiplier: crashPoint ?? currentMultiplier,
      };
    }
  }, [phase, crashPoint, currentMultiplier]);

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

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }
      const W = canvas.width;
      const H = canvas.height;
      const tSec = Date.now() / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // ── GIF mode: clear and overlay text only — the <img> renders the GIF
      if (theme?.gameType === 'gif') {
        ctx.clearRect(0, 0, W, H);
        // Interpolate locally so the number is smooth (see liveMultiplier);
        // rendering the raw 50ms WS value here made GIF games look laggy.
        const m = phase === 'FLYING'
          ? liveMultiplier(flightStartTime, serverClockOffsetMs, currentMultiplier, crashPoint)
          : currentMultiplier;
        const tier = getMultiplierColor(m);
        if (phase === 'BETTING') drawGifOverlayBetting(ctx, W, H, dpr, countdownMs);
        else if (phase === 'FLYING') drawGifOverlayFlying(ctx, W, H, dpr, m, tier);
        else drawGifOverlayCrashed(ctx, W, H, dpr, crashPoint ?? currentMultiplier, theme.colors.crash);
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      const bgImg = spriteRefs.bg.current;
      if (bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
        // Accumulate scroll offset per-frame so changing speed (tied-to-multiplier)
        // doesn't make the image jump. Reset to 0 when we're not in FLYING.
        const now = Date.now();
        const last = bgScrollRef.current.lastFrameMs || now;
        const dt = Math.min(0.1, (now - last) / 1000); // cap dt at 100ms to avoid huge jumps after tab-switch
        if (phase === 'FLYING') {
          const speed = effectiveBgSpeed(theme?.backgroundMotion, currentMultiplier);
          bgScrollRef.current.offset += dt * speed;
        } else {
          bgScrollRef.current.offset = 0;
        }
        bgScrollRef.current.lastFrameMs = now;
        drawBackgroundImage(ctx, bgImg, W, H, theme?.backgroundMotion, bgScrollRef.current.offset);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
        ctx.fillRect(0, 0, W, H);
      } else {
        drawGalaxyBackground(ctx, W, H, dpr, tSec, starsRef.current, nebulaRef.current, orbitOffsetRef);
      }

      // Pick the right sprite for the current phase + multiplier
      const transitionAt = theme?.spriteTransitionAt ?? 1.5;
      const legacy = imgIfReady(spriteRefs.legacy.current);
      const ground = imgIfReady(spriteRefs.ground.current) ?? legacy ?? rocket;
      const flying = imgIfReady(spriteRefs.flying.current) ?? legacy ?? rocket;
      const crashed = imgIfReady(spriteRefs.crashed.current) ?? flying;

      if (phase === 'BETTING') {
        renderBetting(ctx, W, H, dpr, countdownMs, hashCommit);
        drawParkedSprite(ctx, ground, W, H, dpr);
      } else if (phase === 'FLYING') {
        const useSprite = currentMultiplier < transitionAt ? ground : flying;
        const anim: FlightAnimation = { ...DEFAULT_FLIGHT_ANIMATION, ...(theme?.flightAnimation ?? {}) };
        const trajectory: FlightTrajectory = theme?.flightTrajectory ?? DEFAULT_FLIGHT_TRAJECTORY;
        renderFlying(
          ctx, W, H, dpr,
          flightStartTime, serverClockOffsetMs,
          currentMultiplier, crashPoint, getMultiplierColor,
          flameParticlesRef, useSprite, transitionAt, anim, trajectory,
        );
      } else if (phase === 'CRASHED') {
        renderCrashed(ctx, W, H, dpr, crashAnimRef.current, crashed);
      } else if (phase === 'RESULT') {
        renderResult(ctx, W, H, dpr, crashPoint ?? 0);
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [phase, flightStartTime, serverClockOffsetMs, currentMultiplier, crashPoint, hashCommit, countdownMs, getMultiplierColor, rocket, theme]);

  // ─── GIF mode: full-screen animated GIF behind the canvas overlay ─────
  const gifSrc = pickGif(theme, phase, currentMultiplier);

  return (
    <div className="relative w-full h-full">
      {gifSrc &&
        // key={src} forces a fresh mount whenever the source changes (i.e. on
        // every phase change), which restarts the clip and re-applies the fit.
        (isVideoSrc(gifSrc) ? (
          <GifVideo
            key={gifSrc}
            src={gifSrc}
            mode={fitModeForPhase(phase)}
            remainingMs={countdownMs ?? DEFAULT_BETTING_MS}
          />
        ) : (
          <img
            key={gifSrc}
            src={gifSrc}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        ))}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
    </div>
  );
}

/** A stored asset URL that should render as <video> rather than <img>. */
function isVideoSrc(src: string): boolean {
  return /^data:video\//i.test(src) || /\.(mp4|webm|mov)(\?|#|$)/i.test(src);
}

type FitMode = 'stretch' | 'loop' | 'once';

// Fallback betting window when the server countdown isn't known yet (matches
// GAME_CONFIG.bettingPhaseMs). Not imported from @crash/shared because that
// barrel pulls in node crypto and breaks the browser build.
const DEFAULT_BETTING_MS = 5000;

/**
 * playbackRate that makes a clip of `durationSec` play exactly once over the
 * time left in betting (`remainingMs`), clamped to the browser-supported range.
 */
export function stretchPlaybackRate(durationSec: number, remainingMs: number): number {
  const remSec = Math.max(0.25, remainingMs / 1000);
  return Math.max(0.0625, Math.min(16, durationSec / remSec));
}

/** How a phase clip is time-fitted — derived from the phase, no per-game config. */
function fitModeForPhase(phase: GameCanvasProps['phase']): FitMode {
  if (phase === 'BETTING') return 'stretch'; // fill the betting window, once
  if (phase === 'FLYING') return 'loop'; // seamless loop for the unbounded flight
  return 'once'; // crash clip is authored to fit the ~1.5s crash window
}

/**
 * A phase clip rendered as <video>, auto-fitted to its phase:
 *   - stretch: playbackRate so a clip of any length plays exactly once across
 *     the remaining betting window and ends as it closes.
 *   - loop: native seamless loop.
 *   - once: play through at native speed (cut off by the next phase).
 */
function GifVideo({ src, mode, remainingMs }: { src: string; mode: FitMode; remainingMs: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Capture the countdown once at mount; later per-tick updates must not re-fit.
  const remainingAtMount = useRef(remainingMs);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const configure = () => {
      if (mode === 'stretch' && v.duration > 0) {
        // Play the whole clip over the time left in betting, so it ends as the
        // window closes.
        v.currentTime = 0;
        v.playbackRate = stretchPlaybackRate(v.duration, remainingAtMount.current);
      } else {
        v.playbackRate = 1;
      }
      void v.play().catch(() => {});
    };
    if (v.readyState >= 1 /* HAVE_METADATA */) configure();
    else v.addEventListener('loadedmetadata', configure, { once: true });
  }, [mode]);

  return (
    <video
      ref={ref}
      src={src}
      autoPlay
      loop={mode === 'loop'}
      muted
      playsInline
      preload="auto"
      disablePictureInPicture
      disableRemotePlayback
      className="absolute inset-0 w-full h-full object-cover"
    />
  );
}

/** Choose which GIF (if any) to display in GIF mode for the current phase. */
function pickGif(theme: Theme | undefined, phase: GameCanvasProps['phase'], multiplier: number): string | null {
  if (!theme || theme.gameType !== 'gif' || !theme.gifs) return null;
  const g = theme.gifs;
  if (phase === 'BETTING') return g.loading ?? null;
  if (phase === 'FLYING') {
    const thr = g.flyingThresholdAt ?? 2.0;
    if (g.flyingThreshold && multiplier >= thr) return g.flyingThreshold;
    return g.flying ?? null;
  }
  // CRASHED + RESULT: show crashed gif if present, otherwise hold last flying frame
  return g.crashed ?? g.flying ?? null;
}

// ─── Background: nebula + parallax stars + orbital arcs ──────────────────────
function drawGalaxyBackground(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number, tSec: number,
  stars: Array<{ x: number; y: number; r: number; speed: number; depth: number; tw: number }>,
  nebula: Array<{ x: number; y: number; r: number; hue: number; drift: number }>,
  orbitRef: { current: number },
) {
  // Deep-space gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0820');
  bg.addColorStop(0.5, '#070617');
  bg.addColorStop(1, '#04030d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Nebula clouds (drifting soft blobs)
  for (const n of nebula) {
    const cx = (n.x + tSec * n.drift) % 1 * W;
    const cy = (n.y * 0.6 + 0.2) * H;
    const rad = n.r * Math.min(W, H);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, `hsla(${n.hue}, 70%, 55%, 0.16)`);
    grad.addColorStop(0.5, `hsla(${n.hue}, 70%, 40%, 0.06)`);
    grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle horizontal aurora band across the lower third
  const aurora = ctx.createLinearGradient(0, H * 0.7, 0, H);
  aurora.addColorStop(0, 'rgba(34, 211, 238, 0)');
  aurora.addColorStop(0.5, 'rgba(124, 58, 237, 0.08)');
  aurora.addColorStop(1, 'rgba(34, 211, 238, 0.05)');
  ctx.fillStyle = aurora;
  ctx.fillRect(0, H * 0.7, W, H * 0.3);

  // Parallax stars
  for (const s of stars) {
    const sx = (s.x * W + tSec * s.speed * dpr) % W;
    const sy = s.y * H;
    const tw = 0.5 + 0.5 * Math.sin(tSec * 2 + s.tw);
    const a = (0.25 + 0.75 * s.depth) * (0.6 + 0.4 * tw);
    ctx.fillStyle = `rgba(${220 - s.depth * 40}, ${230 - s.depth * 20}, 255, ${a})`;
    ctx.beginPath();
    ctx.arc(sx, sy, s.r * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Orbital arcs (curved guides — much nicer than a square grid)
  orbitRef.current = (orbitRef.current + 0.3) % (140 * dpr);
  ctx.save();
  ctx.strokeStyle = 'rgba(124, 58, 237, 0.08)';
  ctx.lineWidth = 1;
  const cx = W * 0.5;
  const cy = H * 1.4;
  for (let r = 200 * dpr - orbitRef.current; r < Math.hypot(W, H) * 1.4; r += 140 * dpr) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── GIF-mode overlays (drawn on transparent canvas above the <img>) ────────
function drawGifOverlayBetting(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  countdownMs: number | undefined,
) {
  const remaining = countdownMs ?? 5000;
  const seconds = Math.max(0, Math.ceil(remaining / 1000));

  // Big translucent number near bottom — readable on any GIF
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 18 * dpr;
  ctx.font = `700 ${Math.min(140 * dpr, H * 0.22)}px Poppins, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${seconds}`, W / 2, H * 0.78);

  ctx.font = `600 ${Math.min(18 * dpr, H * 0.04)}px Poppins, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('PLACE YOUR BET', W / 2, H * 0.88);
  ctx.restore();
}

function drawGifOverlayFlying(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  multiplier: number, tier: string,
) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = Math.min(190 * dpr, H * 0.32);
  ctx.font = `800 ${fontSize}px Poppins, sans-serif`;

  // Heavy dark shadow first for legibility on bright GIFs
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 26 * dpr;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${multiplier.toFixed(2)}x`, W / 2, H / 2);

  // Tinted glow over the top
  ctx.shadowColor = tier;
  ctx.shadowBlur = 40 * dpr;
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = tier;
  ctx.fillText(`${multiplier.toFixed(2)}x`, W / 2, H / 2);
  ctx.restore();
}

function drawGifOverlayCrashed(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  crashPoint: number, crashColor: string,
) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = Math.min(190 * dpr, H * 0.32);
  ctx.font = `800 ${fontSize}px Poppins, sans-serif`;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.92)';
  ctx.shadowBlur = 28 * dpr;
  ctx.fillStyle = crashColor;
  ctx.fillText(`${crashPoint.toFixed(2)}x`, W / 2, H / 2 - 24 * dpr);

  ctx.font = `700 ${Math.min(34 * dpr, H * 0.07)}px Poppins, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 16 * dpr;
  ctx.fillText('CRASHED', W / 2, H / 2 + Math.min(50 * dpr, H * 0.10));
  ctx.restore();
}

// ─── Custom asset helpers ────────────────────────────────────────────────────

/** Hook: maintain stable HTMLImageElement refs for a set of data URLs, recreating only when the URL changes. */
function useImageRefs(urls: Record<string, string | null>) {
  // Build refs once per key (stable across renders)
  const refs = useRef<Record<string, { current: HTMLImageElement | null }>>({});
  const srcs = useRef<Record<string, string | null>>({});
  for (const key of Object.keys(urls)) {
    if (!refs.current[key]) refs.current[key] = { current: null };
    const url = urls[key];
    if (srcs.current[key] !== url) {
      srcs.current[key] = url;
      if (url) {
        const img = new Image();
        img.src = url;
        refs.current[key].current = img;
      } else {
        refs.current[key].current = null;
      }
    }
  }
  return refs.current;
}

/** Returns the image only if it's ready, else null. */
function imgIfReady(img: HTMLImageElement | null | undefined): HTMLImageElement | null {
  if (img && img.complete && img.naturalWidth > 0) return img;
  return null;
}

/** Sprite sizing — procedural canvas keeps its native size; uploaded images
 *  fit-width to a slightly larger box (preserves aspect ratio). */
function computeSpriteSize(sprite: HTMLCanvasElement | HTMLImageElement, dpr: number) {
  if (sprite instanceof HTMLCanvasElement) {
    return { w: ROCKET_W * dpr, h: ROCKET_H * dpr };
  }
  const targetW = 110 * dpr;
  const aspect = sprite.naturalWidth / Math.max(1, sprite.naturalHeight);
  return { w: targetW, h: targetW / Math.max(0.2, aspect) };
}

/** Cover-fit draw (object-fit: cover). */
function drawCoverImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, W: number, H: number) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const canvasAspect = W / H;
  const imgAspect = iw / ih;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (imgAspect > canvasAspect) {
    sw = ih * canvasAspect;
    sx = (iw - sw) / 2;
  } else {
    sh = iw / canvasAspect;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
}

/**
 * Draw the background image, tiling seamlessly in the motion direction.
 * `scrollPixels` is the accumulated pixel offset (integrated per-frame so
 * tying speed to the multiplier doesn't make the image jump).
 */
function drawBackgroundImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement, W: number, H: number,
  motion: BackgroundMotion | undefined,
  scrollPixels: number,
) {
  const direction = motion?.direction ?? 'none';
  if (direction === 'none' || scrollPixels === 0) {
    drawCoverImage(ctx, img, W, H);
    return;
  }
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;

  if (direction === 'left' || direction === 'right') {
    const scale = H / ih;
    const w = iw * scale;
    const offset = scrollPixels % w;
    const dx = direction === 'left' ? -offset : -(w - offset);
    for (let x = dx; x < W; x += w) {
      ctx.drawImage(img, 0, 0, iw, ih, x, 0, w, H);
    }
  } else {
    const scale = W / iw;
    const h = ih * scale;
    const offset = scrollPixels % h;
    const dy = direction === 'up' ? -offset : -(h - offset);
    for (let y = dy; y < H; y += h) {
      ctx.drawImage(img, 0, 0, iw, ih, 0, y, W, h);
    }
  }
}

/**
 * Park the ground sprite during BETTING — sits exactly where the elliptic
 * flight path begins, so when the round starts the sprite seamlessly lifts
 * off from the same spot (no teleport).
 */
function drawParkedSprite(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement | HTMLImageElement | null,
  W: number, H: number, dpr: number,
) {
  if (!sprite) return;
  const { w, h } = computeSpriteSize(sprite, dpr);
  const padding = 64 * dpr;
  const start = ellipticPositionAt(0, padding, W - padding * 2, H - padding * 2, H);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(start.x - w * 1.2, start.y + h / 2 + 2 * dpr);
  ctx.lineTo(start.x + w * 2.4, start.y + h / 2 + 2 * dpr);
  ctx.stroke();
  ctx.restore();
  ctx.drawImage(sprite, start.x - w / 2, start.y - h / 2, w, h);
}

/**
 * Time at which the sprite reaches the cruise point on the elliptic arc —
 * derived from the configured "fully airborne" multiplier and the game's
 * growth rate. e.g. threshold 1.5x @ growth 0.06 → ln(1.5)/0.06 ≈ 6.76s.
 */
function ellipticTargetMs(transitionAt: number | undefined): number {
  const m = Math.max(1.05, transitionAt ?? 1.5);
  return (Math.log(m) / GROWTH_RATE) * 1000;
}

/**
 * Flight progress on the quarter-elliptic arc.
 *
 *   • Approach phase (elapsed < targetMs): eased ramp from 0 → cruisePoint
 *   • Cruise phase  (elapsed ≥ targetMs): bobs ±bobAmplitude around
 *     cruisePoint with period bobPeriodMs so the sprite visibly slides
 *     back and forth along the arc.
 *
 *  All three parameters come from the theme's flightAnimation.
 */
function computeFlightProgress(elapsedMs: number, targetMs: number, anim: FlightAnimation): number {
  const linear = Math.max(0, elapsedMs) / Math.max(1, targetMs);
  if (linear < 1) {
    const eased = 1 - Math.pow(1 - linear, 1.6);
    return eased * anim.cruisePoint;
  }
  if (anim.bobAmplitude <= 0) return anim.cruisePoint;
  const phase = ((elapsedMs - targetMs) / Math.max(50, anim.bobPeriodMs)) * (2 * Math.PI);
  const bobbed = anim.cruisePoint + Math.sin(phase) * anim.bobAmplitude;
  return Math.max(0.02, Math.min(0.98, bobbed));
}

// ─── Flight trajectory dispatch ──────────────────────────────────────────────

/** Lerp two angles handling the ±π wraparound (shortest-arc interpolation). */
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + diff * t;
}

function flightPositionAt(
  trajectory: FlightTrajectory, progress: number,
  padding: number, graphW: number, graphH: number, H: number,
): { x: number; y: number } {
  return trajectory === 'straight'
    ? straightPositionAt(progress, padding, graphW, H)
    : ellipticPositionAt(progress, padding, graphW, graphH, H);
}

function flightTangentAt(
  trajectory: FlightTrajectory, progress: number,
  padding: number, graphW: number, graphH: number, H: number,
): number {
  return trajectory === 'straight'
    ? straightTangentAt(progress, padding, graphW, H)
    : ellipticTangentAt(progress, padding, graphW, graphH, H);
}

/** Position on the quarter ellipse at parametric progress in [0, 1]. */
function ellipticPositionAt(
  progress: number,
  padding: number, graphW: number, graphH: number, H: number,
): { x: number; y: number } {
  const startX = padding;
  const startY = H - padding;
  const endX = padding + graphW;
  const endY = H - padding - graphH;
  const a = Math.max(0, Math.min(1, progress)) * (Math.PI / 2);
  return {
    x: startX + (endX - startX) * Math.sin(a),
    y: startY - (startY - endY) * (1 - Math.cos(a)),
  };
}

/** Geometric tangent of the quarter ellipse — always forward-pointing. */
function ellipticTangentAt(
  progress: number,
  padding: number, graphW: number, graphH: number, H: number,
): number {
  const startX = padding;
  const startY = H - padding;
  const endX = padding + graphW;
  const endY = H - padding - graphH;
  const a = Math.max(0, Math.min(1, progress)) * (Math.PI / 2);
  const tx = Math.cos(a) * (endX - startX);
  const ty = -Math.sin(a) * (startY - endY); // canvas y grows downward
  return Math.atan2(ty, tx);
}

/**
 * "Straight" trajectory — quadratic Bezier J-curve.
 *
 *   start  = (padding, H - padding)        ← parked at bottom-left
 *   ctrl   = (padding + 0.35·graphW, H/2)  ← elbow at vertical center
 *   end    = (padding + graphW,      H/2)  ← cruising at vertical center
 *
 * Takes off diagonally, then smoothly levels off to fly horizontally across
 * the vertical center. Sprite flies straight, not up, once past the takeoff.
 */
function straightPositionAt(
  progress: number,
  padding: number, graphW: number, H: number,
): { x: number; y: number } {
  const t = Math.max(0, Math.min(1, progress));
  const startX = padding, startY = H - padding;
  const centerY = H * 0.5;
  const ctrlX = startX + graphW * 0.35, ctrlY = centerY;
  const endX = padding + graphW, endY = centerY;
  const u = 1 - t;
  return {
    x: u * u * startX + 2 * u * t * ctrlX + t * t * endX,
    y: u * u * startY + 2 * u * t * ctrlY + t * t * endY,
  };
}

function straightTangentAt(
  progress: number,
  padding: number, graphW: number, H: number,
): number {
  const t = Math.max(0, Math.min(1, progress));
  const startX = padding, startY = H - padding;
  const centerY = H * 0.5;
  const ctrlX = startX + graphW * 0.35, ctrlY = centerY;
  const endX = padding + graphW, endY = centerY;
  const u = 1 - t;
  // B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1)
  const dx = 2 * u * (ctrlX - startX) + 2 * t * (endX - ctrlX);
  const dy = 2 * u * (ctrlY - startY) + 2 * t * (endY - ctrlY);
  return Math.atan2(dy, dx);
}

// ─── Phase: BETTING ──────────────────────────────────────────────────────────
function renderBetting(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  countdownMs: number | undefined,
  hashCommit: string | undefined,
) {
  const remaining = countdownMs ?? 5000;
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const totalMs = 5000;
  const progress = Math.max(0, Math.min(1, (totalMs - remaining) / totalMs));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Outer ring countdown
  const cx = W / 2;
  const cy = H / 2;
  const ringR = Math.min(W, H) * 0.16;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 6 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();
  // Progress arc
  ctx.strokeStyle = '#22d3ee';
  ctx.lineCap = 'round';
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 14 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  ctx.restore();

  // Number
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${88 * dpr}px Poppins, sans-serif`;
  ctx.fillText(`${seconds}`, cx, cy + 4 * dpr);

  // Label
  ctx.font = `500 ${12 * dpr}px Poppins, sans-serif`;
  ctx.fillStyle = 'rgba(180, 195, 230, 0.6)';
  ctx.fillText('PLACE YOUR BET', cx, cy + ringR + 30 * dpr);

  if (hashCommit) {
    ctx.font = `${10 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(124, 137, 180, 0.5)';
    ctx.fillText(`commit · ${hashCommit.slice(0, 12)}…`, cx, cy + ringR + 56 * dpr);
  }
}

// ─── Phase: FLYING ───────────────────────────────────────────────────────────
function renderFlying(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  flightStartTime: number | null,
  serverClockOffsetMs: number,
  serverMultiplier: number,
  crashPoint: number | undefined,
  color: (m: number) => string,
  particleRef: { current: Array<{ x: number; y: number; vx: number; vy: number; life: number; max: number; hue: number }> },
  rocket: HTMLCanvasElement | HTMLImageElement | null,
  transitionAt: number,
  anim: FlightAnimation,
  trajectory: FlightTrajectory,
) {
  let elapsedMs = 0;
  let m: number;
  if (flightStartTime) {
    const serverNow = Date.now() + serverClockOffsetMs;
    elapsedMs = Math.max(0, serverNow - flightStartTime);
    m = multiplierAt(elapsedMs);
    if (m < serverMultiplier) m = serverMultiplier;
    if (crashPoint && m > crashPoint) m = crashPoint;
  } else {
    m = serverMultiplier;
    elapsedMs = (Math.log(Math.max(1, m)) / GROWTH_RATE) * 1000;
  }
  const display = Math.floor(m * 100) / 100;

  const padding = 64 * dpr;
  const graphW = W - padding * 2;
  const graphH = H - padding * 2;

  // At the configured "fully airborne" multiplier, the sprite reaches its
  // cruise point, then bobs back and forth per the theme's flight animation
  // settings.
  const fullyFlyingAt = ellipticTargetMs(transitionAt);
  const progress = computeFlightProgress(elapsedMs, fullyFlyingAt, anim);

  // ─── Cruise extension (both trajectories) ──────────────────────────────
  // Once the plane has settled into cruise, scroll the world in the cruise
  // tangent direction so the trail keeps growing behind the sprite — gives
  // the visual sense that the plane is actually moving forward, not just
  // bobbing in place. Direction:
  //   • straight  → mostly horizontal (tangent ≈ right)
  //   • elliptic  → mostly vertical   (tangent ≈ steep up)
  const CRUISE_SPEED_PX_PER_SEC = 110;
  const inCruise = elapsedMs > fullyFlyingAt;
  const extensionDist = inCruise
    ? ((elapsedMs - fullyFlyingAt) / 1000) * CRUISE_SPEED_PX_PER_SEC
    : 0;

  // Cruise direction (unit vector along the cruise tangent at the cruise point)
  const cruiseTangentAngle = flightTangentAt(trajectory, anim.cruisePoint, padding, graphW, graphH, H);
  const tdx = Math.cos(cruiseTangentAngle);
  const tdy = Math.sin(cruiseTangentAngle);
  const scrollX = extensionDist * tdx;
  const scrollY = extensionDist * tdy;

  const path = flightPositionAt(trajectory, progress, padding, graphW, graphH, H);

  // Trail: shift approach curve by -(scroll), then splice in an extension
  // segment from the displaced approach endpoint to the sprite.
  const N = 160;
  const points: { x: number; y: number }[] = [];
  const trailMax = inCruise ? anim.cruisePoint : progress;
  for (let i = 0; i <= N; i++) {
    const frac = i / N;
    const wp = flightPositionAt(trajectory, frac * trailMax, padding, graphW, graphH, H);
    points.push({ x: wp.x - scrollX, y: wp.y - scrollY });
  }
  if (inCruise) {
    const startExt = points[points.length - 1];
    const extSamples = Math.min(60, Math.ceil(extensionDist / 14));
    for (let i = 1; i <= extSamples; i++) {
      const frac = i / extSamples;
      points.push({
        x: startExt.x + (path.x - startExt.x) * frac,
        y: startExt.y + (path.y - startExt.y) * frac,
      });
    }
  }

  const tierColor = color(display);
  // Keep this so we still know what max value the multiplier hits for the y-axis ticks
  const maxDisplayM = Math.max(2, display * 1.08);

  // Fill under curve — soft cyan-to-violet
  const fill = ctx.createLinearGradient(0, padding, 0, H - padding);
  fill.addColorStop(0, tierColor + '40');
  fill.addColorStop(1, tierColor + '00');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(points[0].x, H - padding);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, H - padding);
  ctx.closePath();
  ctx.fill();

  // Glow stroke
  ctx.save();
  ctx.shadowColor = tierColor;
  ctx.shadowBlur = 20 * dpr;
  ctx.strokeStyle = tierColor;
  ctx.lineWidth = 3 * dpr;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();

  // Dashed trail accent
  ctx.save();
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1.4 * dpr;
  ctx.setLineDash([5 * dpr, 6 * dpr]);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();

  // Sprite angle. During approach: tangent at the (bobbed) progress so the
  // plane visibly pitches up as it climbs. Once in cruise: smoothly blend
  // toward a "level" angle so the sprite stops wobbling — exactly 0
  // (horizontal) for straight, the cruise-point tangent for elliptic.
  const approachAngle = flightTangentAt(trajectory, progress, padding, graphW, graphH, H);
  let angle = approachAngle;
  if (inCruise) {
    const levelAngle = trajectory === 'straight' ? 0 : cruiseTangentAngle;
    const blend = Math.min(1, (elapsedMs - fullyFlyingAt) / 1200);
    angle = lerpAngle(approachAngle, levelAngle, blend);
  }

  spawnFlameParticles(particleRef.current, path.x, path.y, angle, display, dpr);
  drawFlameParticles(ctx, particleRef.current, dpr);
  drawRocket(ctx, path.x, path.y, angle, dpr, rocket);

  // Faint horizontal guides for depth (no longer multiplier-aligned since
  // the curve is parametric on time, not the multiplier value)
  ctx.save();
  ctx.strokeStyle = 'rgba(124, 137, 180, 0.06)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3 * dpr, 6 * dpr]);
  for (let i = 1; i <= 3; i++) {
    const ly = H - padding - (i / 4) * graphH;
    ctx.beginPath();
    ctx.moveTo(padding, ly);
    ctx.lineTo(W - padding, ly);
    ctx.stroke();
  }
  ctx.restore();
  // maxDisplayM kept declared but unused now — silence the warning
  void maxDisplayM;

  // Centered multiplier readout — single white-to-tier color, all in one piece
  ctx.save();
  ctx.shadowColor = tierColor;
  ctx.shadowBlur = 36 * dpr;
  const fontSize = Math.min(170 * dpr, (74 + display * 4) * dpr);
  ctx.font = `700 ${fontSize}px Poppins, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Vertical gradient from white to tier color so the "x" reads naturally
  const grad = ctx.createLinearGradient(0, H / 2 - fontSize / 2, 0, H / 2 + fontSize / 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, tierColor);
  ctx.fillStyle = grad;
  ctx.fillText(`${display.toFixed(2)}x`, W / 2, H / 2 - 6 * dpr);
  ctx.restore();
}

// ─── Flame particle system ───────────────────────────────────────────────────
function spawnFlameParticles(
  particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; max: number; hue: number }>,
  rocketX: number, rocketY: number, angle: number, mult: number, dpr: number,
) {
  // Spawn a few per frame from the back of the rocket
  const back = ROCKET_W * 0.42 * dpr; // distance from center to nozzle in screen units
  const ox = rocketX - Math.cos(angle) * back;
  const oy = rocketY - Math.sin(angle) * back;
  const intensity = Math.min(6, 2 + Math.floor(mult / 2));
  for (let i = 0; i < intensity; i++) {
    const spread = (Math.random() - 0.5) * 0.5;
    const back2 = Math.cos(angle + Math.PI) + Math.cos(angle + Math.PI + spread) * 0.4;
    const speed = (1.2 + Math.random() * 2.4) * dpr;
    const hue = mult >= 5 ? 5 + Math.random() * 30 : 28 + Math.random() * 25;
    particles.push({
      x: ox + (Math.random() - 0.5) * 2 * dpr,
      y: oy + (Math.random() - 0.5) * 2 * dpr,
      vx: Math.cos(angle + Math.PI + spread) * speed + back2 * 0.2,
      vy: Math.sin(angle + Math.PI + spread) * speed,
      life: 0,
      max: 22 + Math.random() * 14,
      hue,
    });
  }
  // Cap total
  if (particles.length > 220) particles.splice(0, particles.length - 220);
}

function drawFlameParticles(
  ctx: CanvasRenderingContext2D,
  particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; max: number; hue: number }>,
  dpr: number,
) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.96;
    p.vy *= 0.96;
    p.life += 1;
    if (p.life >= p.max) {
      particles.splice(i, 1);
      continue;
    }
    const k = 1 - p.life / p.max;
    const r = (4 + (1 - k) * 6) * dpr;
    const a = k * 0.65;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, `hsla(${p.hue + 30 * k}, 95%, 70%, ${a})`);
    grad.addColorStop(0.5, `hsla(${p.hue}, 100%, 55%, ${a * 0.6})`);
    grad.addColorStop(1, `hsla(${p.hue - 20}, 100%, 40%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Draw the pre-rendered rocket sprite, rotated ────────────────────────────
function drawRocket(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, angle: number, dpr: number,
  sprite: HTMLCanvasElement | HTMLImageElement | null,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // Engine glow halo
  const halo = ctx.createRadialGradient(-ROCKET_W * 0.35 * dpr, 0, 0, -ROCKET_W * 0.35 * dpr, 0, 22 * dpr);
  halo.addColorStop(0, 'rgba(255, 200, 100, 0.6)');
  halo.addColorStop(0.5, 'rgba(255, 130, 30, 0.25)');
  halo.addColorStop(1, 'rgba(255, 80, 0, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(-ROCKET_W * 0.35 * dpr, 0, 22 * dpr, 0, Math.PI * 2);
  ctx.fill();

  if (sprite) {
    // Procedural canvas was authored at ROCKET_W x ROCKET_H. Custom image
    // gets fit-width scaling so portrait/landscape uploads look reasonable.
    const { w: sw, h: sh } = computeSpriteSize(sprite, dpr);
    ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
  } else {
    // Fallback: tiny placeholder triangle
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(18 * dpr, 0);
    ctx.lineTo(-12 * dpr, -8 * dpr);
    ctx.lineTo(-12 * dpr, 8 * dpr);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

// ─── Phase: CRASHED ──────────────────────────────────────────────────────────
function renderCrashed(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  crashAnim: { startTime: number; finalMultiplier: number } | null,
  sprite: HTMLCanvasElement | HTMLImageElement | null,
) {
  const cp = crashAnim?.finalMultiplier ?? 0;
  const elapsed = crashAnim ? Date.now() - crashAnim.startTime : 0;

  if (elapsed < 280) {
    ctx.fillStyle = `rgba(239, 68, 68, ${(1 - elapsed / 280) * 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }

  if (elapsed < 1200) {
    const progress = Math.min(1, elapsed / 1000);
    const startX = W * 0.62;
    const startY = H * 0.45;
    const px = startX + progress * W * 0.7;
    const py = startY - progress * H * 0.65;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-0.55 - progress * 0.5);
    ctx.globalAlpha = 1 - progress * 0.5;
    if (sprite) {
      const { w: sw, h: sh } = computeSpriteSize(sprite, dpr);
      ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
    }
    // Explosion debris
    ctx.globalAlpha = 1;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + elapsed * 0.01;
      const d = progress * 60 * dpr;
      const k = 1 - progress;
      ctx.fillStyle = `rgba(255, ${110 + i * 8}, 30, ${k * 0.85})`;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, 3 * k * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Multiplier
  ctx.save();
  ctx.shadowColor = '#ef4444';
  ctx.shadowBlur = 36 * dpr;
  ctx.fillStyle = '#ef4444';
  ctx.font = `700 ${108 * dpr}px Poppins, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${cp.toFixed(2)}x`, W / 2, H / 2 - 28 * dpr);
  ctx.restore();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.font = `600 ${20 * dpr}px Poppins, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('CRASHED', W / 2, H / 2 + 40 * dpr);
}

// ─── Phase: RESULT ───────────────────────────────────────────────────────────
function renderResult(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  crashPoint: number,
) {
  ctx.save();
  ctx.shadowColor = '#ef4444';
  ctx.shadowBlur = 22 * dpr;
  ctx.fillStyle = '#ef4444';
  ctx.font = `700 ${72 * dpr}px Poppins, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${crashPoint.toFixed(2)}x`, W / 2, H / 2 - 24 * dpr);
  ctx.restore();
  ctx.fillStyle = 'rgba(180, 195, 230, 0.55)';
  ctx.font = `500 ${13 * dpr}px Poppins, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('next launch incoming…', W / 2, H / 2 + 28 * dpr);
}
