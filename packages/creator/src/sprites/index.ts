import type { SpriteKey, Theme } from '../theme';

export const SPRITE_W = 84;
export const SPRITE_H = 44;

type Drawer = (ctx: CanvasRenderingContext2D, theme: Theme) => void;

const drawers: Record<SpriteKey, Drawer> = {
  rocket: drawRocket,
  jet: drawJet,
  biplane: drawBiplane,
  ufo: drawUfo,
};

/**
 * Bake the chosen sprite into an offscreen canvas. Cheap to call per frame
 * (just a drawImage). Re-bake when sprite or theme.colors changes.
 */
export function buildSprite(key: SpriteKey, theme: Theme): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.width = SPRITE_W * dpr;
  c.height = SPRITE_H * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.translate(SPRITE_W / 2, SPRITE_H / 2);
  drawers[key](ctx, theme);
  return c;
}

// ─── Rocket ────────────────────────────────────────────────────────────────
function drawRocket(ctx: CanvasRenderingContext2D, theme: Theme) {
  // Fins
  const finGrad = ctx.createLinearGradient(0, -20, 0, 20);
  finGrad.addColorStop(0, theme.colors.crash);
  finGrad.addColorStop(1, shade(theme.colors.crash, -0.5));
  ctx.fillStyle = finGrad;
  ctx.beginPath(); ctx.moveTo(-22, -6); ctx.lineTo(-32, -20); ctx.lineTo(-12, -8); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-22, 6);  ctx.lineTo(-32, 20);  ctx.lineTo(-12, 8);  ctx.closePath(); ctx.fill();

  // Engine nozzle
  const nozGrad = ctx.createLinearGradient(-30, 0, -22, 0);
  nozGrad.addColorStop(0, '#1f2937'); nozGrad.addColorStop(1, '#4b5563');
  ctx.fillStyle = nozGrad;
  ctx.beginPath(); ctx.moveTo(-30, -8); ctx.lineTo(-22, -6); ctx.lineTo(-22, 6); ctx.lineTo(-30, 8); ctx.closePath(); ctx.fill();

  // Body — chrome
  const bodyGrad = ctx.createLinearGradient(0, -10, 0, 10);
  bodyGrad.addColorStop(0, '#f8fafc');
  bodyGrad.addColorStop(0.5, '#cbd5e1');
  bodyGrad.addColorStop(1, '#475569');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(-22, -10); ctx.lineTo(18, -10);
  ctx.quadraticCurveTo(28, -8, 34, 0);
  ctx.quadraticCurveTo(28, 8, 18, 10);
  ctx.lineTo(-22, 10);
  ctx.quadraticCurveTo(-24, 0, -22, -10);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,0.4)'; ctx.lineWidth = 0.8; ctx.stroke();

  // Accent stripe — tinted by theme accent
  const stripeGrad = ctx.createLinearGradient(0, -3, 0, 3);
  stripeGrad.addColorStop(0, shade(theme.colors.crash, 0.5));
  stripeGrad.addColorStop(0.5, theme.colors.crash);
  stripeGrad.addColorStop(1, shade(theme.colors.crash, -0.4));
  ctx.fillStyle = stripeGrad;
  ctx.beginPath(); ctx.moveTo(-20, -2.5); ctx.lineTo(20, -2.5); ctx.lineTo(22, 2.5); ctx.lineTo(-20, 2.5); ctx.closePath(); ctx.fill();

  // Cockpit window (theme accent)
  const winGrad = ctx.createRadialGradient(12, -2, 0, 12, 0, 8);
  winGrad.addColorStop(0, '#ffffff');
  winGrad.addColorStop(0.5, theme.colors.accent);
  winGrad.addColorStop(1, shade(theme.colors.accent, -0.5));
  ctx.fillStyle = winGrad;
  ctx.beginPath(); ctx.ellipse(12, 0, 5.5, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,0.6)'; ctx.lineWidth = 0.6; ctx.stroke();

  // Nose tip
  const noseGrad = ctx.createRadialGradient(32, 0, 0, 32, 0, 6);
  noseGrad.addColorStop(0, shade(theme.colors.crash, 0.4));
  noseGrad.addColorStop(0.5, theme.colors.crash);
  noseGrad.addColorStop(1, shade(theme.colors.crash, -0.5));
  ctx.fillStyle = noseGrad;
  ctx.beginPath(); ctx.moveTo(28, -4); ctx.quadraticCurveTo(34, 0, 28, 4); ctx.lineTo(34, 0); ctx.closePath(); ctx.fill();

  // Rivets
  ctx.fillStyle = 'rgba(15,23,42,0.35)';
  for (let x = -16; x <= 16; x += 6) {
    ctx.beginPath(); ctx.arc(x, -7.5, 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x,  7.5, 0.55, 0, Math.PI * 2); ctx.fill();
  }
}

// ─── Fighter Jet ───────────────────────────────────────────────────────────
function drawJet(ctx: CanvasRenderingContext2D, theme: Theme) {
  // Delta wings (back)
  ctx.fillStyle = shade(theme.colors.accent, -0.3);
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(-20, -16);
  ctx.lineTo(-28, -4);
  ctx.lineTo(-16, 4);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(-20, 16);
  ctx.lineTo(-28, 4);
  ctx.lineTo(-16, -4);
  ctx.closePath(); ctx.fill();

  // Tail fin
  ctx.fillStyle = shade(theme.colors.accent, -0.5);
  ctx.beginPath(); ctx.moveTo(-22, 0); ctx.lineTo(-30, -10); ctx.lineTo(-18, -2); ctx.closePath(); ctx.fill();

  // Fuselage (narrow, sleek)
  const bodyGrad = ctx.createLinearGradient(0, -6, 0, 6);
  bodyGrad.addColorStop(0, '#f1f5f9');
  bodyGrad.addColorStop(0.5, '#cbd5e1');
  bodyGrad.addColorStop(1, '#475569');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(-22, -5);
  ctx.lineTo(20, -5);
  ctx.quadraticCurveTo(34, -2, 36, 0);
  ctx.quadraticCurveTo(34, 2, 20, 5);
  ctx.lineTo(-22, 5);
  ctx.quadraticCurveTo(-26, 0, -22, -5);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,0.4)'; ctx.lineWidth = 0.6; ctx.stroke();

  // Accent stripe along the body
  ctx.fillStyle = theme.colors.accent2;
  ctx.fillRect(-18, -1, 38, 2);

  // Canopy
  const canopy = ctx.createLinearGradient(0, -5, 0, 0);
  canopy.addColorStop(0, '#ffffff');
  canopy.addColorStop(0.5, theme.colors.accent);
  canopy.addColorStop(1, shade(theme.colors.accent, -0.5));
  ctx.fillStyle = canopy;
  ctx.beginPath();
  ctx.moveTo(0, -5); ctx.quadraticCurveTo(8, -8, 16, -2); ctx.lineTo(16, -1); ctx.lineTo(0, -1); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,0.6)'; ctx.lineWidth = 0.5; ctx.stroke();

  // Engine intake glow
  ctx.fillStyle = '#1f2937';
  ctx.beginPath(); ctx.ellipse(-22, 0, 3, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shade(theme.colors.crash, 0.3);
  ctx.beginPath(); ctx.ellipse(-22, 0, 1.6, 2.2, 0, 0, Math.PI * 2); ctx.fill();
}

// ─── Biplane ───────────────────────────────────────────────────────────────
function drawBiplane(ctx: CanvasRenderingContext2D, theme: Theme) {
  // Bottom wing
  ctx.fillStyle = shade(theme.colors.accent2, -0.2);
  ctx.beginPath(); ctx.roundRect(-14, 7, 24, 4, 1); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.5; ctx.stroke();

  // Top wing
  ctx.fillStyle = theme.colors.accent2;
  ctx.beginPath(); ctx.roundRect(-12, -13, 28, 4, 1); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.5; ctx.stroke();

  // Wing struts
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(-8, -9); ctx.lineTo(-8, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(10, -9); ctx.lineTo(10, 7); ctx.stroke();

  // Fuselage
  const bodyGrad = ctx.createLinearGradient(0, -6, 0, 6);
  bodyGrad.addColorStop(0, shade(theme.colors.crash, 0.3));
  bodyGrad.addColorStop(0.5, theme.colors.crash);
  bodyGrad.addColorStop(1, shade(theme.colors.crash, -0.4));
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(-20, -3);
  ctx.lineTo(18, -6);
  ctx.quadraticCurveTo(28, 0, 18, 6);
  ctx.lineTo(-20, 3);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.6; ctx.stroke();

  // Tail
  ctx.fillStyle = shade(theme.colors.crash, -0.3);
  ctx.beginPath(); ctx.moveTo(-22, -2); ctx.lineTo(-28, -8); ctx.lineTo(-22, 0); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-22, 2); ctx.lineTo(-26, 8); ctx.lineTo(-18, 4); ctx.closePath(); ctx.fill();

  // Cockpit
  ctx.fillStyle = '#1f2937';
  ctx.beginPath(); ctx.ellipse(2, -2, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = theme.colors.accent;
  ctx.beginPath(); ctx.arc(2, -2, 1.2, 0, Math.PI * 2); ctx.fill();

  // Propeller hub
  ctx.fillStyle = '#1f2937';
  ctx.beginPath(); ctx.arc(28, 0, 1.4, 0, Math.PI * 2); ctx.fill();
  // Spinning blur
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath(); ctx.ellipse(28, 0, 1, 9, 0, 0, Math.PI * 2); ctx.fill();
}

// ─── UFO ───────────────────────────────────────────────────────────────────
function drawUfo(ctx: CanvasRenderingContext2D, theme: Theme) {
  // Bottom dome glow
  const glow = ctx.createRadialGradient(0, 6, 0, 0, 6, 22);
  glow.addColorStop(0, theme.colors.accent + '99');
  glow.addColorStop(1, theme.colors.accent + '00');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 6, 22, 0, Math.PI * 2); ctx.fill();

  // Lower saucer body
  const lower = ctx.createLinearGradient(0, -2, 0, 8);
  lower.addColorStop(0, '#cbd5e1');
  lower.addColorStop(0.5, '#94a3b8');
  lower.addColorStop(1, '#1e293b');
  ctx.fillStyle = lower;
  ctx.beginPath(); ctx.ellipse(0, 2, 28, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.5; ctx.stroke();

  // Lights ring
  for (let i = -3; i <= 3; i++) {
    ctx.fillStyle = i % 2 === 0 ? theme.colors.accent : theme.colors.accent2;
    ctx.beginPath(); ctx.arc(i * 8, 6, 1.2, 0, Math.PI * 2); ctx.fill();
  }

  // Upper dome (clear)
  const dome = ctx.createRadialGradient(-2, -5, 0, 0, -2, 14);
  dome.addColorStop(0, '#ffffff');
  dome.addColorStop(0.5, theme.colors.accent + 'cc');
  dome.addColorStop(1, shade(theme.colors.accent, -0.5));
  ctx.fillStyle = dome;
  ctx.beginPath(); ctx.ellipse(0, -3, 12, 8, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.6; ctx.stroke();

  // Pilot silhouette
  ctx.fillStyle = '#1f2937';
  ctx.beginPath(); ctx.arc(0, -4, 2.2, 0, Math.PI * 2); ctx.fill();
}

// ─── Color helpers ─────────────────────────────────────────────────────────
function shade(hex: string, amt: number): string {
  // amt in [-1, 1]; negative darkens, positive lightens
  const c = hex.replace('#', '');
  const num = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  r = Math.round((t - r) * p + r);
  g = Math.round((t - g) * p + g);
  b = Math.round((t - b) * p + b);
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
