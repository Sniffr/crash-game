import type { BackgroundKey, Theme } from '../theme';

export interface BackgroundState {
  stars: Array<{ x: number; y: number; r: number; speed: number; depth: number; tw: number }>;
  bubbles: Array<{ x: number; y: number; r: number; speed: number }>;
  nebulaSeed: number;
}

export function newBackgroundState(): BackgroundState {
  const stars = Array.from({ length: 180 }, () => {
    const depth = Math.random();
    return {
      x: Math.random(),
      y: Math.random(),
      r: 0.4 + depth * 1.8,
      speed: 4 + depth * 18,
      depth,
      tw: Math.random() * Math.PI * 2,
    };
  });
  const bubbles = Array.from({ length: 40 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 1 + Math.random() * 3,
    speed: 0.2 + Math.random() * 0.8,
  }));
  return { stars, bubbles, nebulaSeed: Math.random() * 1000 };
}

type BgFn = (
  ctx: CanvasRenderingContext2D,
  w: number, h: number, dpr: number, tSec: number,
  theme: Theme, state: BackgroundState,
) => void;

const renderers: Record<BackgroundKey, BgFn> = {
  galaxy: drawGalaxy,
  sunset: drawSunset,
  deep_sea: drawDeepSea,
  cyber: drawCyber,
};

export function drawBackground(
  key: BackgroundKey,
  ctx: CanvasRenderingContext2D,
  w: number, h: number, dpr: number, tSec: number,
  theme: Theme, state: BackgroundState,
) {
  renderers[key](ctx, w, h, dpr, tSec, theme, state);
}

// ─── Galaxy ────────────────────────────────────────────────────────────────
function drawGalaxy(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number, tSec: number,
  theme: Theme, state: BackgroundState,
) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, theme.colors.bgFrom);
  bg.addColorStop(1, theme.colors.bgTo);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Nebula clouds — pinned by seed so they don't flicker
  for (let i = 0; i < 4; i++) {
    const cx = ((Math.sin(state.nebulaSeed + i) * 0.5 + 0.5) + tSec * 0.01 * (i + 1)) % 1 * W;
    const cy = (0.2 + (i / 4) * 0.6) * H;
    const rad = (0.22 + (i * 0.04)) * Math.min(W, H);
    const hue = [theme.colors.accent2, theme.colors.accent, theme.colors.accent2, theme.colors.accent][i];
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, hex(hue, 0.16));
    grad.addColorStop(0.5, hex(hue, 0.06));
    grad.addColorStop(1, hex(hue, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
  }

  // Stars
  for (const s of state.stars) {
    const sx = (s.x * W + tSec * s.speed * dpr) % W;
    const sy = s.y * H;
    const tw = 0.5 + 0.5 * Math.sin(tSec * 2 + s.tw);
    const a = (0.25 + 0.75 * s.depth) * (0.6 + 0.4 * tw);
    ctx.fillStyle = `rgba(${220 - s.depth * 40}, ${230 - s.depth * 20}, 255, ${a})`;
    ctx.beginPath(); ctx.arc(sx, sy, s.r * dpr, 0, Math.PI * 2); ctx.fill();
  }
}

// ─── Sunset ────────────────────────────────────────────────────────────────
function drawSunset(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number, tSec: number,
  theme: Theme, _state: BackgroundState,
) {
  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, theme.colors.bgFrom);
  sky.addColorStop(0.6, mix(theme.colors.bgFrom, theme.colors.bgTo, 0.5));
  sky.addColorStop(1, theme.colors.bgTo);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Sun
  const sunX = W * 0.78;
  const sunY = H * 0.35;
  const sunR = 60 * dpr;
  const sunGrad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 2);
  sunGrad.addColorStop(0, '#fff7ed');
  sunGrad.addColorStop(0.3, theme.colors.gold);
  sunGrad.addColorStop(1, hex(theme.colors.gold, 0));
  ctx.fillStyle = sunGrad;
  ctx.beginPath(); ctx.arc(sunX, sunY, sunR * 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = theme.colors.gold;
  ctx.beginPath(); ctx.arc(sunX, sunY, sunR * 0.55, 0, Math.PI * 2); ctx.fill();

  // Distant clouds — long thin ellipses drifting right
  ctx.save();
  ctx.globalAlpha = 0.4;
  for (let i = 0; i < 6; i++) {
    const cy = H * (0.3 + (i / 6) * 0.25);
    const cx = ((i * 0.27 + tSec * 0.005 * (i + 1)) % 1) * W;
    const cw = 80 * dpr + i * 12 * dpr;
    ctx.fillStyle = 'rgba(255, 224, 200, 0.7)';
    ctx.beginPath(); ctx.ellipse(cx, cy, cw, 6 * dpr, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // Mountain silhouette
  ctx.fillStyle = mix(theme.colors.bgTo, '#000000', 0.4);
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H * 0.82);
  for (let x = 0; x <= W; x += W / 8) {
    const peak = H * 0.7 + Math.sin(x * 0.012 + 1.3) * 30 * dpr;
    ctx.lineTo(x + W / 16, peak);
    ctx.lineTo(x + W / 8, H * 0.82);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
}

// ─── Deep Sea ──────────────────────────────────────────────────────────────
function drawDeepSea(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number, tSec: number,
  theme: Theme, state: BackgroundState,
) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, theme.colors.bgFrom);
  bg.addColorStop(1, theme.colors.bgTo);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Light rays from the surface (top)
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    const cx = (0.2 + 0.2 * i) * W + Math.sin(tSec * 0.5 + i) * 20 * dpr;
    const grad = ctx.createLinearGradient(cx, 0, cx + 40 * dpr, H);
    grad.addColorStop(0, hex(theme.colors.accent, 0.18));
    grad.addColorStop(1, hex(theme.colors.accent, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - 30 * dpr, 0);
    ctx.lineTo(cx + 30 * dpr, 0);
    ctx.lineTo(cx + 100 * dpr, H);
    ctx.lineTo(cx - 100 * dpr, H);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Rising bubbles
  for (const b of state.bubbles) {
    const y = ((b.y - tSec * b.speed * 0.1) % 1 + 1) % 1 * H;
    const x = b.x * W + Math.sin(tSec * b.speed + b.x * 10) * 6 * dpr;
    ctx.fillStyle = hex(theme.colors.accent, 0.5);
    ctx.beginPath(); ctx.arc(x, y, b.r * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = hex(theme.colors.accent, 0.7);
    ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.arc(x, y, b.r * dpr, 0, Math.PI * 2); ctx.stroke();
  }
}

// ─── Cyber ─────────────────────────────────────────────────────────────────
function drawCyber(
  ctx: CanvasRenderingContext2D,
  W: number, H: number, dpr: number, tSec: number,
  theme: Theme, _state: BackgroundState,
) {
  // Black background with a top-violet gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, theme.colors.bgFrom);
  bg.addColorStop(0.7, theme.colors.bgTo);
  bg.addColorStop(1, '#000000');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Horizon line glow
  const horizonY = H * 0.55;
  const horizonGlow = ctx.createLinearGradient(0, horizonY - 20 * dpr, 0, horizonY + 20 * dpr);
  horizonGlow.addColorStop(0, hex(theme.colors.accent, 0));
  horizonGlow.addColorStop(0.5, hex(theme.colors.accent, 0.7));
  horizonGlow.addColorStop(1, hex(theme.colors.accent, 0));
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(0, horizonY - 20 * dpr, W, 40 * dpr);
  ctx.strokeStyle = theme.colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, horizonY); ctx.lineTo(W, horizonY); ctx.stroke();

  // Perspective grid below horizon
  ctx.save();
  ctx.strokeStyle = hex(theme.colors.accent, 0.5);
  ctx.lineWidth = 1;
  // Horizontal lines (perspective, exponentially closer to horizon)
  const offset = (tSec * 60 * dpr) % (40 * dpr);
  for (let i = 0; i < 18; i++) {
    const yProgress = i / 18;
    const y = horizonY + Math.pow(yProgress, 0.6) * (H - horizonY) + offset * (1 - yProgress);
    if (y > H) continue;
    ctx.globalAlpha = 0.2 + yProgress * 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Vertical lines (converging on horizon center)
  const cx = W / 2;
  for (let i = -8; i <= 8; i++) {
    const xBottom = cx + (i / 8) * W * 0.8;
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(xBottom, H);
    ctx.stroke();
  }
  ctx.restore();

  // Distant city silhouette above horizon
  ctx.fillStyle = mix(theme.colors.bgTo, '#000000', 0.6);
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  let x = 0;
  while (x < W) {
    const w = 20 * dpr + Math.random() * 30 * dpr;
    const h = 12 * dpr + (Math.sin(x * 0.05) + 1) * 20 * dpr;
    ctx.lineTo(x, horizonY - h);
    ctx.lineTo(x + w, horizonY - h);
    x += w;
  }
  ctx.lineTo(W, horizonY);
  ctx.closePath();
  // Skip — actually don't draw a city, it'll flicker each frame from Math.random.
  // Instead, simple skyline with sine.
  ctx.fillStyle = mix(theme.colors.bgTo, '#000000', 0.7);
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  for (let xx = 0; xx <= W; xx += 14 * dpr) {
    const h = (Math.sin(xx * 0.04) + 1.2) * 14 * dpr;
    ctx.lineTo(xx, horizonY - h);
    ctx.lineTo(xx + 14 * dpr, horizonY - h);
  }
  ctx.lineTo(W, horizonY);
  ctx.closePath();
  ctx.fill();
}

// ─── helpers ───────────────────────────────────────────────────────────────
function hex(c: string, alpha: number): string {
  // c is #rrggbb; output rgba()
  const v = c.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mix(a: string, b: string, t: number): string {
  const va = a.replace('#', '');
  const vb = b.replace('#', '');
  const ra = parseInt(va.slice(0, 2), 16), rb = parseInt(vb.slice(0, 2), 16);
  const ga = parseInt(va.slice(2, 4), 16), gb = parseInt(vb.slice(2, 4), 16);
  const ba = parseInt(va.slice(4, 6), 16), bb = parseInt(vb.slice(4, 6), 16);
  const r = Math.round(ra + (rb - ra) * t);
  const g = Math.round(ga + (gb - ga) * t);
  const bl = Math.round(ba + (bb - ba) * t);
  return '#' + [r, g, bl].map((v2) => v2.toString(16).padStart(2, '0')).join('');
}
