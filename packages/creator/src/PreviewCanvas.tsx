import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundMotion, FlightAnimation, FlightTrajectory, Theme } from './theme';
import { DEFAULT_FLIGHT_ANIMATION, DEFAULT_FLIGHT_TRAJECTORY, effectiveBgSpeed, tierColor } from './theme';
import { buildSprite, SPRITE_H, SPRITE_W } from './sprites';
import { drawBackground, newBackgroundState } from './backgrounds';

/** Cached <img> for a data URL — avoids re-creating per frame. */
function useImage(src: string | null | undefined): HTMLImageElement | null {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastSrcRef = useRef<string | null | undefined>(undefined);
  if (lastSrcRef.current !== src) {
    lastSrcRef.current = src;
    if (!src) {
      imgRef.current = null;
    } else {
      const img = new Image();
      img.src = src;
      imgRef.current = img;
    }
  }
  return imgRef.current;
}

interface Props {
  theme: Theme;
}

interface FlameParticle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; hue: number;
}

type Phase = 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';

// Scripted crash points covering all tier colors so users always see variety.
const CRASH_LOOP = [1.32, 4.87, 1.05, 12.4, 2.45, 1.91, 7.2, 1.6, 30.5];

export default function PreviewCanvas({ theme }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const stateRef = useRef(newBackgroundState());
  const particlesRef = useRef<FlameParticle[]>([]);
  const phaseRef = useRef<Phase>('BETTING');
  const phaseStartRef = useRef(Date.now());
  const crashIdxRef = useRef(0);
  const crashPointRef = useRef(CRASH_LOOP[0]);
  const liveMultiplierRef = useRef(1.0);
  const bgScrollRef = useRef({ offset: 0, lastFrameMs: 0 });

  // Re-bake sprite when sprite key or color tokens change
  const sprite = useMemo(
    () => buildSprite(theme.sprite, theme),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      theme.sprite,
      theme.colors.accent, theme.colors.accent2,
      theme.colors.crash, theme.colors.win, theme.colors.gold,
    ],
  );

  // Custom sprite slots + background image (when uploaded)
  const customSprite = useImage(theme.assets?.sprite);
  const customGround = useImage(theme.assets?.spriteGround);
  const customFlying = useImage(theme.assets?.spriteFlying);
  const customCrashed = useImage(theme.assets?.spriteCrashed);
  const customBackground = useImage(theme.assets?.background);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const W = Math.floor(rect.width * dpr);
      const H = Math.floor(rect.height * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const tick = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) { animRef.current = requestAnimationFrame(tick); return; }
      const W = canvas.width;
      const H = canvas.height;
      const now = Date.now();
      const tSec = now / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Phase transitions
      const phaseElapsed = now - phaseStartRef.current;
      switch (phaseRef.current) {
        case 'BETTING':
          if (phaseElapsed >= theme.bettingMs) {
            phaseRef.current = 'FLYING';
            phaseStartRef.current = now;
            liveMultiplierRef.current = 1.0;
          }
          break;
        case 'FLYING': {
          const t = phaseElapsed / 1000;
          const m = Math.exp(theme.growthRate * t);
          liveMultiplierRef.current = Math.min(m, crashPointRef.current);
          if (m >= crashPointRef.current) {
            phaseRef.current = 'CRASHED';
            phaseStartRef.current = now;
          }
          break;
        }
        case 'CRASHED':
          if (phaseElapsed >= 1200) {
            phaseRef.current = 'RESULT';
            phaseStartRef.current = now;
          }
          break;
        case 'RESULT':
          if (phaseElapsed >= 1400) {
            crashIdxRef.current = (crashIdxRef.current + 1) % CRASH_LOOP.length;
            crashPointRef.current = CRASH_LOOP[crashIdxRef.current];
            phaseRef.current = 'BETTING';
            phaseStartRef.current = now;
            particlesRef.current = [];
          }
          break;
      }

      // GIF mode: clear and only overlay multiplier text — the <img> sibling renders the GIF
      if (theme.gameType === 'gif') {
        ctx.clearRect(0, 0, W, H);
        const m = liveMultiplierRef.current;
        const tier = tierColor(theme, m);
        if (phaseRef.current === 'BETTING') {
          drawGifOverlayBetting(ctx, W, H, dpr, theme.bettingMs - phaseElapsed);
        } else if (phaseRef.current === 'FLYING') {
          drawGifOverlayFlying(ctx, W, H, dpr, m, tier);
        } else {
          drawGifOverlayCrashed(ctx, W, H, dpr, crashPointRef.current, theme.colors.crash);
        }
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      // Background — custom image if uploaded, otherwise procedural.
      // Scroll offset is accumulated per-frame so changing speed (tied-to-multiplier)
      // doesn't cause the image to jump.
      if (customBackground && customBackground.complete && customBackground.naturalWidth > 0) {
        const last = bgScrollRef.current.lastFrameMs || now;
        const dt = Math.min(0.1, (now - last) / 1000);
        if (phaseRef.current === 'FLYING') {
          const speed = effectiveBgSpeed(theme.backgroundMotion, liveMultiplierRef.current);
          bgScrollRef.current.offset += dt * speed;
        } else {
          bgScrollRef.current.offset = 0;
        }
        bgScrollRef.current.lastFrameMs = now;
        drawBackgroundImage(ctx, customBackground, W, H, theme.backgroundMotion, bgScrollRef.current.offset);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(0, 0, W, H);
      } else {
        drawBackground(theme.background, ctx, W, H, dpr, tSec, theme, stateRef.current);
      }

      // Pick the right sprite for the current phase + multiplier
      const transitionAt = theme.spriteTransitionAt ?? 1.5;
      const m = liveMultiplierRef.current;
      const ground  = imgIfReady(customGround)  ?? imgIfReady(customSprite) ?? sprite;
      const flying  = imgIfReady(customFlying)  ?? imgIfReady(customSprite) ?? sprite;
      const crashed = imgIfReady(customCrashed) ?? flying;

      // Phase content
      if (phaseRef.current === 'BETTING') {
        renderBetting(ctx, W, H, dpr, theme, theme.bettingMs - phaseElapsed);
        // Draw the ground sprite parked in the lower-left of the canvas
        drawParkedSprite(ctx, ground, W, H, dpr);
      } else if (phaseRef.current === 'FLYING') {
        const spriteForFlight = m < transitionAt ? ground : flying;
        renderFlying(ctx, W, H, dpr, theme, m, phaseElapsed, particlesRef.current, spriteForFlight);
      } else if (phaseRef.current === 'CRASHED') {
        renderCrashed(ctx, W, H, dpr, theme, crashPointRef.current, phaseElapsed, crashed);
      } else {
        renderResult(ctx, W, H, dpr, theme, crashPointRef.current);
      }

      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animRef.current);
    };
  }, [theme, sprite]);

  // In GIF mode we render the GIF as an <img> sibling underneath the canvas.
  // We pick the gif based on the live phase/multiplier and let React re-mount
  // the <img> on src change so the GIF restarts cleanly.
  const [gifTick, setGifTick] = useState(0);
  useEffect(() => {
    if (theme.gameType !== 'gif') return;
    const id = window.setInterval(() => setGifTick((t) => (t + 1) % 1_000_000), 120);
    return () => window.clearInterval(id);
  }, [theme.gameType]);
  // re-read phase on each tick so the chosen GIF stays current
  const gifSrc = (() => {
    if (theme.gameType !== 'gif') return null;
    void gifTick;
    return pickGifPreview(theme, phaseRef.current, liveMultiplierRef.current);
  })();

  return (
    <div className="relative w-full h-full">
      {gifSrc &&
        (isVideoSrc(gifSrc) ? (
          <video
            key={gifSrc}
            src={gifSrc}
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
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

/** A stored/inlined asset that should render as <video> rather than <img>. */
function isVideoSrc(src: string): boolean {
  return /^data:video\//i.test(src) || /\.(mp4|webm|mov)(\?|#|$)/i.test(src);
}

function pickGifPreview(theme: Theme, phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT', multiplier: number): string | null {
  const g = theme.gifs;
  if (!g) return null;
  if (phase === 'BETTING') return g.loading ?? null;
  if (phase === 'FLYING') {
    const thr = g.flyingThresholdAt ?? 2.0;
    if (g.flyingThreshold && multiplier >= thr) return g.flyingThreshold;
    return g.flying ?? null;
  }
  return g.crashed ?? g.flying ?? null;
}

// ─── Phase renderers ──────────────────────────────────────────────────────

function renderBetting(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  theme: Theme, remainingMs: number,
) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const progress = Math.max(0, Math.min(1, 1 - remainingMs / theme.bettingMs));
  const cx = W / 2; const cy = H / 2;
  const ringR = Math.min(W, H) * 0.16;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 6 * dpr;
  ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = theme.colors.accent;
  ctx.lineCap = 'round';
  ctx.shadowColor = theme.colors.accent;
  ctx.shadowBlur = 14 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = theme.colors.text;
  ctx.font = `600 ${88 * dpr}px "Space Grotesk", Inter, sans-serif`;
  ctx.fillText(`${seconds}`, cx, cy + 4 * dpr);

  ctx.font = `500 ${12 * dpr}px Inter, sans-serif`;
  ctx.fillStyle = hex(theme.colors.text, 0.6);
  ctx.fillText('PLACE YOUR BET', cx, cy + ringR + 30 * dpr);
}

function renderFlying(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  theme: Theme, m: number, elapsedMs: number,
  particles: FlameParticle[],
  sprite: HTMLCanvasElement | HTMLImageElement | null,
) {
  // Scale padding to the canvas size so the preview reads well at any size
  const padding = Math.min(60 * dpr, Math.min(W, H) * 0.10);
  const graphW = W - padding * 2;
  const graphH = H - padding * 2;

  // Flight path. At the configured "fully airborne" multiplier the sprite
  // reaches the cruise point on its path (elliptic arc OR straight J-curve),
  // then bobs back and forth.
  const anim: FlightAnimation = { ...DEFAULT_FLIGHT_ANIMATION, ...(theme.flightAnimation ?? {}) };
  const trajectory: FlightTrajectory = theme.flightTrajectory ?? DEFAULT_FLIGHT_TRAJECTORY;
  const fullyFlyingAt = ellipticTargetMs(theme.spriteTransitionAt, theme.growthRate);
  const progress = computeFlightProgress(elapsedMs, fullyFlyingAt, anim);

  // Cruise extension applies to BOTH trajectories. World scrolls in the
  // cruise tangent direction so the trail keeps growing behind the sprite.
  //   • straight  → horizontal extension (line extends behind to the left)
  //   • elliptic  → mostly vertical extension (line extends back-and-down)
  const CRUISE_SPEED_PX_PER_SEC = 110;
  const inCruise = elapsedMs > fullyFlyingAt;
  const extensionDist = inCruise ? ((elapsedMs - fullyFlyingAt) / 1000) * CRUISE_SPEED_PX_PER_SEC : 0;

  const cruiseTangentAngle = flightTangentAt(trajectory, anim.cruisePoint, padding, graphW, graphH, H);
  const tdx = Math.cos(cruiseTangentAngle);
  const tdy = Math.sin(cruiseTangentAngle);
  const scrollX = extensionDist * tdx;
  const scrollY = extensionDist * tdy;

  const path = flightPositionAt(trajectory, progress, padding, graphW, graphH, H);
  const N = 140;
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

  const color = tierColor(theme, m);

  // Fill under curve
  const fill = ctx.createLinearGradient(0, padding, 0, H - padding);
  fill.addColorStop(0, color + '44');
  fill.addColorStop(1, color + '00');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(points[0].x, H - padding);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, H - padding);
  ctx.closePath(); ctx.fill();

  // Glow stroke
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 20 * dpr;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * dpr;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();

  // Sprite angle. During approach: tangent at bobbed progress (pitches up).
  // During cruise: smoothly blend toward a level angle so the sprite stops
  // wobbling — 0 for straight, cruise-point tangent for elliptic.
  const approachAngle = flightTangentAt(trajectory, progress, padding, graphW, graphH, H);
  let angle = approachAngle;
  if (inCruise) {
    const levelAngle = trajectory === 'straight' ? 0 : cruiseTangentAngle;
    const blend = Math.min(1, (elapsedMs - fullyFlyingAt) / 1200);
    angle = lerpAngle(approachAngle, levelAngle, blend);
  }

  spawnFlame(particles, path.x, path.y, angle, m, dpr);
  drawFlame(ctx, particles, dpr);

  if (sprite) {
    ctx.save();
    ctx.translate(path.x, path.y);
    ctx.rotate(angle);
    const { w: sw, h: sh } = spriteSize(sprite, dpr);
    ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }

  // Multiplier readout (gradient white -> tier) — cap by canvas dimensions
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 36 * dpr;
  const sizeCap = Math.min(H * 0.30, W * 0.20);
  const fontSize = Math.min(sizeCap, (60 + m * 3.4) * dpr);
  ctx.font = `700 ${fontSize}px "Space Grotesk", Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const grad = ctx.createLinearGradient(0, H / 2 - fontSize / 2, 0, H / 2 + fontSize / 2);
  grad.addColorStop(0, theme.colors.text);
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.fillText(`${m.toFixed(2)}x`, W / 2, H / 2 - 6 * dpr);
  ctx.restore();
}

function renderCrashed(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  theme: Theme, cp: number, elapsedMs: number,
  sprite: HTMLCanvasElement | HTMLImageElement | null,
) {
  if (elapsedMs < 280) {
    ctx.fillStyle = hex(theme.colors.crash, (1 - elapsedMs / 280) * 0.35);
    ctx.fillRect(0, 0, W, H);
  }
  if (elapsedMs < 1100 && sprite) {
    const progress = Math.min(1, elapsedMs / 950);
    const startX = W * 0.6;
    const startY = H * 0.45;
    const px = startX + progress * W * 0.7;
    const py = startY - progress * H * 0.6;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-0.55 - progress * 0.5);
    ctx.globalAlpha = 1 - progress * 0.55;
    const { w: sw, h: sh } = spriteSize(sprite, dpr);
    ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
    ctx.globalAlpha = 1;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + elapsedMs * 0.01;
      const d = progress * 60 * dpr;
      const k = 1 - progress;
      ctx.fillStyle = hex(theme.colors.crash, k * 0.85);
      ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, 3 * k * dpr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  const crashSize = Math.min(108 * dpr, H * 0.20);
  ctx.save();
  ctx.shadowColor = theme.colors.crash;
  ctx.shadowBlur = 36 * dpr;
  ctx.fillStyle = theme.colors.crash;
  ctx.font = `700 ${crashSize}px "Space Grotesk", Inter, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${cp.toFixed(2)}x`, W / 2, H / 2 - 28 * dpr);
  ctx.restore();
  ctx.fillStyle = hex(theme.colors.text, 0.75);
  ctx.font = `600 ${Math.min(20 * dpr, H * 0.05)}px "Space Grotesk", Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('CRASHED', W / 2, H / 2 + crashSize * 0.4);
}

function renderResult(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  theme: Theme, cp: number,
) {
  ctx.save();
  ctx.shadowColor = theme.colors.crash;
  ctx.shadowBlur = 24 * dpr;
  ctx.fillStyle = theme.colors.crash;
  ctx.font = `700 ${72 * dpr}px "Space Grotesk", Inter, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${cp.toFixed(2)}x`, W / 2, H / 2 - 22 * dpr);
  ctx.restore();
  ctx.fillStyle = hex(theme.colors.text, 0.55);
  ctx.font = `500 ${13 * dpr}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('next round incoming…', W / 2, H / 2 + 28 * dpr);
}

// ─── Flame particles ──────────────────────────────────────────────────────

function spawnFlame(particles: FlameParticle[], x: number, y: number, angle: number, m: number, dpr: number) {
  const back = SPRITE_W * 0.42 * dpr;
  const ox = x - Math.cos(angle) * back;
  const oy = y - Math.sin(angle) * back;
  const intensity = Math.min(6, 2 + Math.floor(m / 2));
  for (let i = 0; i < intensity; i++) {
    const spread = (Math.random() - 0.5) * 0.5;
    const speed = (1.1 + Math.random() * 2.3) * dpr;
    const hue = m >= 5 ? 5 + Math.random() * 30 : 28 + Math.random() * 25;
    particles.push({
      x: ox + (Math.random() - 0.5) * 2 * dpr,
      y: oy + (Math.random() - 0.5) * 2 * dpr,
      vx: Math.cos(angle + Math.PI + spread) * speed,
      vy: Math.sin(angle + Math.PI + spread) * speed,
      life: 0,
      max: 20 + Math.random() * 14,
      hue,
    });
  }
  if (particles.length > 200) particles.splice(0, particles.length - 200);
}

function drawFlame(ctx: CanvasRenderingContext2D, particles: FlameParticle[], dpr: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy *= 0.96; p.life += 1;
    if (p.life >= p.max) { particles.splice(i, 1); continue; }
    const k = 1 - p.life / p.max;
    const r = (4 + (1 - k) * 6) * dpr;
    const a = k * 0.6;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, `hsla(${p.hue + 30 * k}, 95%, 70%, ${a})`);
    grad.addColorStop(0.5, `hsla(${p.hue}, 100%, 55%, ${a * 0.6})`);
    grad.addColorStop(1, `hsla(${p.hue - 20}, 100%, 40%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ─── Image drawing helpers ────────────────────────────────────────────────

/** Fit-width sizing so a portrait or landscape custom sprite scales sensibly. */
function spriteSize(sprite: HTMLCanvasElement | HTMLImageElement, dpr: number): { w: number; h: number } {
  // Procedural canvas sprite — already sized to (SPRITE_W * dpr) x (SPRITE_H * dpr)
  if (sprite instanceof HTMLCanvasElement) {
    return { w: SPRITE_W * dpr, h: SPRITE_H * dpr };
  }
  // Custom image — fit to a slightly larger box (96px wide) preserving aspect
  const targetW = 96 * dpr;
  const aspect = sprite.naturalWidth / Math.max(1, sprite.naturalHeight);
  const w = targetW;
  const h = w / Math.max(0.2, aspect);
  return { w, h };
}

/** Object-fit:cover style draw — fills the canvas, cropping overflow. */
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

/** Background image with optional seamless tile-scroll. scrollPixels is the
 *  accumulated pixel offset (integrated per-frame so variable speed doesn't jump). */
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

/** Returns the image only if it's ready to draw, else null. */
function imgIfReady(img: HTMLImageElement | null): HTMLImageElement | null {
  if (img && img.complete && img.naturalWidth > 0) return img;
  return null;
}

/**
 * Park the ground sprite during BETTING — at the same spot the elliptic
 * flight path starts, so liftoff is a smooth continuation, not a teleport.
 */
function drawParkedSprite(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement | HTMLImageElement | null,
  W: number, H: number, dpr: number,
) {
  if (!sprite) return;
  const { w, h } = spriteSize(sprite, dpr);
  const padding = Math.min(60 * dpr, Math.min(W, H) * 0.10);
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

/** Time at which the sprite reaches the cruise point on the arc. */
function ellipticTargetMs(transitionAt: number | undefined, growthRate: number): number {
  const m = Math.max(1.05, transitionAt ?? 1.5);
  const g = Math.max(0.001, growthRate);
  return (Math.log(m) / g) * 1000;
}

/** Approach phase: eased ramp from 0 → cruisePoint. Cruise: bob ±bobAmplitude every bobPeriodMs. */
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

/** Geometric tangent (always forward-facing) of the ellipse at this progress. */
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
  const ty = -Math.sin(a) * (startY - endY);
  return Math.atan2(ty, tx);
}

// ─── Flight trajectory dispatch + "straight" J-curve ─────────────────────────

/** Shortest-arc lerp between two angles (handles ±π wraparound). */
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

/**
 * "Straight" — quadratic Bezier J-curve: takes off diagonally from bottom-left,
 * smoothly levels off, then cruises horizontally across the vertical center.
 */
function straightPositionAt(
  progress: number, padding: number, graphW: number, H: number,
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
  progress: number, padding: number, graphW: number, H: number,
): number {
  const t = Math.max(0, Math.min(1, progress));
  const startX = padding, startY = H - padding;
  const centerY = H * 0.5;
  const ctrlX = startX + graphW * 0.35, ctrlY = centerY;
  const endX = padding + graphW, endY = centerY;
  const u = 1 - t;
  const dx = 2 * u * (ctrlX - startX) + 2 * t * (endX - ctrlX);
  const dy = 2 * u * (ctrlY - startY) + 2 * t * (endY - ctrlY);
  return Math.atan2(dy, dx);
}

// ─── GIF-mode overlays (transparent canvas on top of <img>) ───────────────
function drawGifOverlayBetting(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number,
  remainingMs: number,
) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 18 * dpr;
  ctx.font = `700 ${Math.min(140 * dpr, H * 0.22)}px "Space Grotesk", Inter, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${seconds}`, W / 2, H * 0.78);
  ctx.font = `600 ${Math.min(18 * dpr, H * 0.04)}px Inter, sans-serif`;
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
  ctx.font = `800 ${fontSize}px "Space Grotesk", Inter, sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 26 * dpr;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${multiplier.toFixed(2)}x`, W / 2, H / 2);
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
  ctx.font = `800 ${fontSize}px "Space Grotesk", Inter, sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.92)';
  ctx.shadowBlur = 28 * dpr;
  ctx.fillStyle = crashColor;
  ctx.fillText(`${crashPoint.toFixed(2)}x`, W / 2, H / 2 - 24 * dpr);
  ctx.font = `700 ${Math.min(34 * dpr, H * 0.07)}px "Space Grotesk", Inter, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 16 * dpr;
  ctx.fillText('CRASHED', W / 2, H / 2 + Math.min(50 * dpr, H * 0.10));
  ctx.restore();
}

// ─── helpers ──────────────────────────────────────────────────────────────
function hex(c: string, alpha: number): string {
  const v = c.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
