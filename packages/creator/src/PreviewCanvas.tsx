import { useEffect, useRef, useState } from 'react';
import type { Theme } from './theme';
import GameCanvas from '@crash/client/src/components/GameCanvas';
import type { Theme as ClientTheme } from '@crash/client/src/theme/types';
import { timeToMultiplierMs } from '@crash/shared/curve';

// The Creator preview now renders the REAL game (the client's GameCanvas), so
// what you see matches production exactly — sprite, GIF or scene, and the
// configured growth curve. A tiny local simulator drives a demo round loop
// (betting → flying → crash → repeat); GameCanvas does all the rendering.

type Phase = 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';

function tier(theme: Theme, m: number): string {
  const c = theme.colors;
  if (m >= 10) return c.gold;
  if (m >= 5) return c.accent2;
  if (m >= 2) return c.accent;
  return c.win;
}

export default function PreviewCanvas({ theme }: { theme: Theme }) {
  const [s, setS] = useState<{ phase: Phase; flightStart: number | null; mult: number; crashPoint: number; countdownMs: number }>(
    { phase: 'BETTING', flightStart: null, mult: 1, crashPoint: 2, countdownMs: theme.bettingMs },
  );
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    let alive = true;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => { const t = window.setTimeout(() => { if (alive) fn(); }, ms); timers.push(t); };

    const betting = () => {
      const t = themeRef.current;
      const startedAt = Date.now();
      setS((p) => ({ ...p, phase: 'BETTING', flightStart: null, mult: 1, countdownMs: t.bettingMs }));
      const iv = window.setInterval(() => {
        if (!alive) { clearInterval(iv); return; }
        const remaining = Math.max(0, t.bettingMs - (Date.now() - startedAt));
        setS((p) => (p.phase === 'BETTING' ? { ...p, countdownMs: remaining } : p));
        if (remaining <= 0) clearInterval(iv);
      }, 100);
      timers.push(iv);
      later(flying, t.bettingMs);
    };
    const flying = () => {
      const t = themeRef.current;
      // Demo crash point skewed toward low values (like a real crash distribution).
      const crashPoint = Math.round((1.15 + Math.random() * Math.random() * 14) * 100) / 100;
      setS((p) => ({ ...p, phase: 'FLYING', flightStart: Date.now(), mult: 1, crashPoint }));
      const crashMs = timeToMultiplierMs(crashPoint, t.growthRate, t.growthSegments);
      later(() => crash(crashPoint), Math.max(700, crashMs));
    };
    const crash = (crashPoint: number) => {
      setS((p) => ({ ...p, phase: 'CRASHED', mult: crashPoint }));
      later(betting, 2400);
    };

    betting();
    return () => { alive = false; timers.forEach((t) => clearTimeout(t)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <GameCanvas
      theme={theme as unknown as ClientTheme}
      phase={s.phase}
      flightStartTime={s.flightStart}
      serverClockOffsetMs={0}
      currentMultiplier={s.mult}
      crashPoint={s.crashPoint}
      countdownMs={s.countdownMs}
      getMultiplierColor={(m) => tier(theme, m)}
    />
  );
}
