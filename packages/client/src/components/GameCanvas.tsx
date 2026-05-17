import { useEffect, useRef, useCallback } from 'react';

interface GameCanvasProps {
  phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';
  currentMultiplier: number;
  crashPoint?: number;
  hashCommit?: string;
  countdownMs?: number;
  getMultiplierColor: (m: number) => string;
}

export default function GameCanvas({
  phase,
  currentMultiplier,
  crashPoint,
  hashCommit,
  countdownMs,
  getMultiplierColor,
}: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(Date.now());
  const starsRef = useRef<Array<{ x: number; y: number; size: number; speed: number; brightness: number }>>([]);
  const gridOffsetRef = useRef(0);
  const crashAnimRef = useRef<{ startTime: number } | null>(null);
  const flashRef = useRef(0);

  const generateStars = useCallback(() => {
    const stars = [];
    for (let i = 0; i < 120; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        size: Math.random() * 2 + 0.5,
        speed: Math.random() * 0.3 + 0.1,
        brightness: Math.random() * 0.5 + 0.3,
      });
    }
    return stars;
  }, []);

  useEffect(() => {
    starsRef.current = generateStars();
  }, [generateStars]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const t = Date.now() / 1000;

    // ─── Background gradient ───────────────────────────────────────────────
    const bgGrad = ctx.createRadialGradient(W * 0.7, H * 0.3, 0, W * 0.5, H * 0.5, W * 0.8);
    bgGrad.addColorStop(0, '#1a1a4e');
    bgGrad.addColorStop(0.5, '#0f0f3a');
    bgGrad.addColorStop(1, '#0a0a2e');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ─── Stars ─────────────────────────────────────────────────────────────
    for (const star of starsRef.current) {
      const sx = (star.x * W + t * star.speed * 20) % W;
      const sy = star.y * H;
      const twinkle = star.brightness + Math.sin(t * 2 + star.x * 10) * 0.15;
      ctx.fillStyle = `rgba(255, 255, 255, ${twinkle})`;
      ctx.beginPath();
      ctx.arc(sx, sy, star.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // ─── Scrolling grid ────────────────────────────────────────────────────
    gridOffsetRef.current = (gridOffsetRef.current + 0.3) % 60;
    ctx.strokeStyle = 'rgba(100, 100, 200, 0.08)';
    ctx.lineWidth = 1;

    for (let x = -gridOffsetRef.current; x < W; x += 60) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    for (let y = 0; y < H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y + gridOffsetRef.current * 0.5);
      ctx.lineTo(W, y + gridOffsetRef.current * 0.5);
      ctx.stroke();
    }

    // ─── Phase-specific rendering ──────────────────────────────────────────
    if (phase === 'BETTING') {
      const countdown = countdownMs ? Math.max(0, Math.ceil(countdownMs / 1000)) : 5;
      const totalMs = 5000;
      const progress = countdownMs ? (totalMs - countdownMs) / totalMs : 0;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.font = 'bold 64px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${countdown}`, W / 2, H / 2 - 20);

      ctx.font = '16px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillText('PLACE YOUR BETS', W / 2, H / 2 + 30);

      const barWidth = W * 0.6;
      const barHeight = 4;
      const barX = (W - barWidth) / 2;
      const barY = H / 2 + 60;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fillRect(barX, barY, barWidth, barHeight);
      ctx.fillStyle = 'rgba(0, 230, 118, 0.6)';
      ctx.fillRect(barX, barY, barWidth * progress, barHeight);

      if (hashCommit) {
        ctx.font = '11px monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fillText(`Hash: ${hashCommit.slice(0, 16)}...`, W / 2, H / 2 + 85);
      }

    } else if (phase === 'FLYING') {
      const elapsed = Date.now() - startTimeRef.current;
      const mult = 1 + (elapsed / 1000) * 0.05;
      const currentM = Math.round(mult * 100) / 100;
      const maxDisplayM = Math.max(currentM, 2);

      const padding = 60;
      const graphW = W - padding * 2;
      const graphH = H - padding * 2;

      // Compute curve points
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i <= 200; i++) {
        const frac = i / 200;
        const tSec = frac * (elapsed / 1000) || 0.01;
        const m = 1 + tSec * 0.05;
        const px = padding + frac * graphW;
        const py = H - padding - ((m - 1) / (maxDisplayM - 1)) * graphH;
        points.push({ x: px, y: Math.max(padding, Math.min(H - padding, py)) });
      }

      // Curve glow
      ctx.save();
      ctx.shadowColor = getMultiplierColor(currentM);
      ctx.shadowBlur = 20;
      ctx.strokeStyle = getMultiplierColor(currentM);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.restore();

      // Solid curve
      ctx.strokeStyle = getMultiplierColor(currentM);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();

      // Fill under curve
      const grad = ctx.createLinearGradient(0, padding, 0, H - padding);
      grad.addColorStop(0, getMultiplierColor(currentM) + '30');
      grad.addColorStop(1, getMultiplierColor(currentM) + '05');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(points[0].x, H - padding);
      for (const p of points) {
        ctx.lineTo(p.x, p.y);
      }
      ctx.lineTo(points[points.length - 1].x, H - padding);
      ctx.closePath();
      ctx.fill();

      // Trail
      ctx.save();
      ctx.shadowColor = '#ff9100';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#ff9100';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Plane at tip
      const lastPt = points[points.length - 1];
      const prevPt = points[points.length - 2] || lastPt;
      const angle = Math.atan2(lastPt.y - prevPt.y, lastPt.x - prevPt.x);

      ctx.save();
      ctx.translate(lastPt.x, lastPt.y);
      ctx.rotate(angle);

      // Plane body
      ctx.fillStyle = '#ff1744';
      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.lineTo(-12, -8);
      ctx.lineTo(-8, 0);
      ctx.lineTo(-12, 8);
      ctx.closePath();
      ctx.fill();

      // Wing highlight
      ctx.fillStyle = '#ff5252';
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-6, -5);
      ctx.lineTo(-4, 0);
      ctx.closePath();
      ctx.fill();

      // Cockpit
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(8, 0, 3, 0, Math.PI * 2);
      ctx.fill();

      // Engine glow
      ctx.fillStyle = '#ff9100';
      ctx.beginPath();
      ctx.arc(-10, 0, 3 + Math.sin(t * 20) * 1.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // Multiplier text
      const color = getMultiplierColor(currentM);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 30;
      ctx.fillStyle = color;
      const fontSize = Math.min(120, 60 + currentM * 3);
      ctx.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${currentM.toFixed(2)}x`, W / 2, H / 2);
      ctx.restore();

      // Y-axis labels
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.textAlign = 'right';

      const maxLabel = Math.max(2, Math.ceil(currentM / 2) * 2);
      for (let m = 2; m <= maxLabel; m += 2) {
        const frac = (m - 1) / (maxDisplayM - 1);
        const ly = H - padding - frac * graphH;
        if (ly >= padding && ly <= H - padding) {
          ctx.fillText(`${m.toFixed(0)}x`, padding - 8, ly + 4);
          ctx.strokeStyle = 'rgba(100, 100, 200, 0.05)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 8]);
          ctx.beginPath();
          ctx.moveTo(padding, ly);
          ctx.lineTo(W - padding, ly);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

    } else if (phase === 'CRASHED') {
      const crashTime = crashAnimRef.current?.startTime || Date.now();
      const elapsed = Date.now() - crashTime;

      // Flash
      if (elapsed < 300) {
        flashRef.current = 1 - elapsed / 300;
        ctx.fillStyle = `rgba(255, 23, 68, ${flashRef.current * 0.3})`;
        ctx.fillRect(0, 0, W, H);
      } else {
        flashRef.current = 0;
      }

      // Crashed plane flying off with particles
      if (elapsed < 1000) {
        const progress = Math.min(1, elapsed / 800);
        const startX = W * 0.7;
        const startY = H * 0.4;
        const px = startX + progress * W * 0.5;
        const py = startY - progress * H * 0.5;

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(-0.5);
        ctx.globalAlpha = 1 - progress;

        ctx.fillStyle = '#ff1744';
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(-12, -8);
        ctx.lineTo(-8, 0);
        ctx.lineTo(-12, 8);
        ctx.closePath();
        ctx.fill();

        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2 + elapsed * 0.01;
          const dist = progress * 40;
          ctx.fillStyle = `rgba(255, ${100 + i * 20}, 0, ${1 - progress})`;
          ctx.beginPath();
          ctx.arc(Math.cos(angle) * dist, Math.sin(angle) * dist, 3 * (1 - progress), 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }

      // Crash point display
      const cp = crashPoint || 0;
      ctx.save();
      ctx.shadowColor = '#ff1744';
      ctx.shadowBlur = 40;
      ctx.fillStyle = '#ff1744';
      ctx.font = 'bold 100px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${cp.toFixed(2)}x`, W / 2, H / 2 - 30);
      ctx.restore();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = 'bold 28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('CRASHED', W / 2, H / 2 + 30);

    } else if (phase === 'RESULT') {
      const cp = crashPoint || 0;
      ctx.save();
      ctx.shadowColor = '#ff1744';
      ctx.shadowBlur = 30;
      ctx.fillStyle = '#ff1744';
      ctx.font = 'bold 80px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${cp.toFixed(2)}x`, W / 2, H / 2 - 40);
      ctx.restore();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = 'bold 24px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('ROUND COMPLETE', W / 2, H / 2 + 10);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '14px Inter, system-ui, sans-serif';
      ctx.fillText('Next round starting...', W / 2, H / 2 + 45);
    }

    animFrameRef.current = requestAnimationFrame(draw);
  }, [phase, currentMultiplier, crashPoint, countdownMs, hashCommit, getMultiplierColor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (rect) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    };
    resize();
    window.addEventListener('resize', resize);

    startTimeRef.current = Date.now();
    animFrameRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [draw]);

  useEffect(() => {
    if (phase === 'CRASHED') {
      crashAnimRef.current = { startTime: Date.now() };
    }
  }, [phase]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      style={{ imageRendering: 'auto' }}
    />
  );
}
