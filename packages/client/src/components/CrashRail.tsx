export interface HistoryEntry {
  roundNumber: number;
  crashPoint: number;
}

/**
 * The crash rail — the lobby's signature element.
 *
 * Every other casino lobby shows you cover art. This shows you the game's
 * actual last rounds, pulled from the public /api/history feed: one bar per
 * round, newest on the right, height log-scaled against a 30× ceiling so a
 * 1.02× and a 24× are both legible on the same 28px rail.
 *
 * Colour carries the only meaning that matters to a crash player — how far it
 * ran before it went:
 *   under 2×   dim steel  (where most rounds die)
 *   2× – 10×   ember      (a normal good round)
 *   10× and up mint       (the rare one people stay for)
 */

const CEILING = 30;

export function tierColor(crashPoint: number): string {
  if (crashPoint >= 10) return 'hsl(138 61% 47%)';  // bet-400 — mint
  if (crashPoint >= 2) return '#fb6514';            // brand-500 — ember
  return 'hsl(0 0% 100% / 0.18)';                   // dim steel
}

/**
 * The same tiers for TEXT, floored at readable contrast.
 *
 * The dim-steel bar tier is 18% white, which is correct for a 5px bar in a row
 * of 18 but unreadable on a 52px figure — and a sub-2× round is exactly when
 * the headline number must still be legible. Text drops to near-white instead
 * of disappearing; only the two "notable" tiers get colour.
 */
export function tierTextColor(crashPoint: number): string {
  if (crashPoint >= 10) return 'hsl(138 61% 47%)';
  if (crashPoint >= 2) return '#fb6514';
  return 'hsl(0 0% 92%)';
}

export default function CrashRail({
  history,
  bars = 14,
  height = 28,
  stretch = false,
  className = '',
}: {
  history: HistoryEntry[];
  bars?: number;
  height?: number;
  /** Fill the available width (bars widen) instead of sitting at a fixed size. */
  stretch?: boolean;
  className?: string;
}) {
  const recent = history.slice(-bars);
  const newest = recent.length > 0 ? recent[recent.length - 1]!.roundNumber : null;
  const barClass = stretch ? 'min-w-[3px] flex-1' : 'w-[5px] shrink-0';

  // A stretching rail always lays out `bars` slots and right-aligns the real
  // rounds into them. Without the empty leading slots, a game with 15 rounds of
  // history would spread 15 bars across the full width as fat blocks, and the
  // bar geometry would visibly change every time a round landed.
  const slots: (HistoryEntry | null)[] = stretch
    ? [...Array.from({ length: Math.max(0, bars - recent.length) }, () => null), ...recent]
    : recent;

  return (
    <div
      className={`flex items-end gap-[3px] ${stretch ? 'w-full' : ''} ${className}`}
      style={{ height }}
      role="img"
      aria-label={
        recent.length === 0
          ? 'No rounds played yet'
          : `Last ${recent.length} rounds, most recent ${recent[recent.length - 1]!.crashPoint.toFixed(2)} times`
      }
    >
      {slots.map((entry, i) => {
        if (!entry) {
          return <span key={`empty-${i}`} className={`${barClass} rounded-[2px] bg-white/[0.04]`} style={{ height: 3 }} />;
        }
        const scaled = Math.log(Math.max(entry.crashPoint, 1.01)) / Math.log(CEILING);
        const pct = Math.min(Math.max(scaled, 0.08), 1);
        return (
          <span
            key={entry.roundNumber}
            title={`Round #${entry.roundNumber} — ${entry.crashPoint.toFixed(2)}×`}
            className={`${barClass} origin-bottom rounded-[2px] ${entry.roundNumber === newest ? 'animate-bar-in' : ''}`}
            style={{ height: `${pct * 100}%`, backgroundColor: tierColor(entry.crashPoint) }}
          />
        );
      })}
    </div>
  );
}
