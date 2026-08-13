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
 */
export default function HistoryStrip({ history }: HistoryStripProps) {
  const recent = [...history].slice(-30).reverse();

  return (
    <div className="flex items-center gap-2 rounded-card border border-edge bg-space-850 px-2.5 py-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-600">
        Last
      </span>
      {/* Fades at the right edge instead of guillotining the last chip — the
          rail scrolls, and a hard clip reads as a layout bug rather than
          "there's more this way". */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
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
