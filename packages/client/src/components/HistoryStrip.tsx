import { useEffect, useRef, useState } from 'react';
import { tierColor, type HistoryEntry } from './CrashRail';

interface HistoryStripProps {
  history: HistoryEntry[];
  /** Unused — kept so App.tsx's existing call site stays valid. */
  getChipClass?: (crashPoint: number) => string;
}

/**
 * The in-game history rail. Same rounds the lobby draws as bars, shown here as
 * exact figures because a player mid-session reads the values, not the shape.
 *
 * Crucially it uses the SAME tier thresholds as <CrashRail> — under 2× dim,
 * 2–10× ember, 10×+ mint. It previously had its own orange/purple scheme, so
 * the identical number meant one thing in the lobby and another in the game.
 *
 * How many chips show is MEASURED, not fixed. A hardcoded 30 had to serve both
 * a 360px phone and a 2560px monitor, so the rail scrolled sideways on anything
 * narrow — and a horizontal scroll nobody thinks to try is the same as hiding
 * the rounds. Now the count is whatever fits the actual width.
 */

/**
 * Chip width budget. Measured: a 5-character chip ("1.18×" — most rounds, since
 * most die under 10×) renders at ~44px, and each extra digit adds ~7px.
 * 50 leaves room for the common 6-character case without under-filling the rail
 * the way a worst-case "100.00×" budget would; the fade below covers the rare
 * run of wide numbers that reaches the edge.
 */
const CHIP_PX = 50;
/** gap-1.5 */
const GAP_PX = 6;
/** Past this the oldest rounds stop being interesting on any monitor. */
const MAX_CHIPS = 30;

export default function HistoryStrip({ history }: HistoryStripProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(MAX_CHIPS);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    // n chips occupy n*CHIP + (n-1)*GAP, so the largest n that fits width w is
    // floor((w + GAP) / (CHIP + GAP)).
    const measure = () => setFit(Math.max(
      1,
      Math.min(MAX_CHIPS, Math.floor((el.clientWidth + GAP_PX) / (CHIP_PX + GAP_PX))),
    ));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const recent = [...history].slice(-fit).reverse();

  return (
    <div className="flex items-center gap-2 rounded-card border border-edge bg-space-850 px-2.5 py-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-600">
        Last
      </span>
      {/* overflow-hidden, not auto: the count above is chosen to fit, so there is
          nothing to scroll to. The fade stays as insurance — CHIP_PX is an
          estimate, and a run of 100×+ rounds can still reach the edge, where a
          hard clip would read as a layout bug rather than a wide number. */}
      <div
        ref={railRef}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)',
        }}
      >
        {recent.length === 0 ? (
          <span className="px-1 py-1 text-[12px] text-neutral-600">No rounds yet</span>
        ) : (
          recent.map((entry, idx) => {
            const color = tierColor(entry.crashPoint);
            const dim = entry.crashPoint < 2;
            return (
              <span
                key={entry.roundNumber}
                title={`Round #${entry.roundNumber}`}
                className={`shrink-0 rounded-chip px-2 py-1 text-[12px] font-semibold tabular-nums ${
                  idx === 0 ? 'animate-chip-in' : ''
                }`}
                style={
                  dim
                    // The dim tier is a border-only chip: filling 30 of them with
                    // a flat grey would out-shout the two tiers that matter.
                    ? { color: 'hsl(0 0% 62%)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.10)' }
                    : { color: 'hsl(0 0% 6%)', backgroundColor: color }
                }
              >
                {entry.crashPoint.toFixed(2)}×
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}
