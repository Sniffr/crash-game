import { fromMinor } from '../lib/money';
import { tierColor } from './CrashRail';

interface Player {
  playerId: string;
  amount: number;
  autoCashout?: number;
  cashedOut: boolean;
  isBot: boolean;
  botName?: string;
  profit?: number;
  cashoutMultiplier?: number;
  operatorId?: string;
  currency?: string;
  amountMinor?: number;
}

interface PlayerListProps {
  bets: Player[];
  youPlayerId?: string;
}

function amountOf(bet: Player): string {
  return bet.currency
    ? fromMinor(bet.amountMinor ?? bet.amount, bet.currency)
    : bet.amount.toFixed(2);
}

/**
 * Who else is in this round, and what happened to them.
 *
 * Your own row is pinned to the top and marked with an ember rail down its left
 * edge — you should never have to hunt for yourself in a moving list. Cashed-out
 * rows carry the same multiplier tiers as the history strip and the lobby rail,
 * so a 12× reads as a 12× everywhere in the product.
 */
export default function PlayerList({ bets, youPlayerId }: PlayerListProps) {
  const sorted = [...bets].sort((a, b) => {
    const aIsYou = a.playerId === youPlayerId ? 1 : 0;
    const bIsYou = b.playerId === youPlayerId ? 1 : 0;
    if (aIsYou !== bIsYou) return bIsYou - aIsYou;
    if (a.cashedOut !== b.cashedOut) return a.cashedOut ? -1 : 1;
    if (a.cashedOut && b.cashedOut) return (b.profit || 0) - (a.profit || 0);
    return b.amount - a.amount;
  });

  const cashedCount = bets.filter((b) => b.cashedOut).length;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-edge bg-space-850">
      <div className="flex items-center justify-between gap-2 border-b border-edge-soft px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-neutral-100">
          Live bets <span className="ml-1 font-normal tabular-nums text-neutral-600">{bets.length}</span>
        </h2>
        {cashedCount > 0 && (
          <span className="text-[11px] tabular-nums text-bet-400">{cashedCount} cashed</span>
        )}
      </div>

      <div className="grid grid-cols-[1.2fr_1fr_auto_1fr] gap-2 border-b border-edge-soft px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-neutral-600">
        <span>Player</span>
        <span>Bet</span>
        <span className="text-center">At</span>
        <span className="text-right">Returned</span>
      </div>

      {/* Capped on mobile too — a busy round is 30+ bets, and uncapped it turns
          the phone layout into a mile of scrolling below the game. */}
      <div className="min-h-0 max-h-[340px] flex-1 overflow-y-auto lg:max-h-[calc(100vh-320px)]">
        {bets.length === 0 && (
          <p className="px-3 py-10 text-center text-[12px] text-neutral-600">
            No bets in this round yet.
          </p>
        )}
        {sorted.map((bet) => {
          const isYou = bet.playerId === youPlayerId;
          return (
            <div
              key={bet.playerId}
              className={`relative grid grid-cols-[1.2fr_1fr_auto_1fr] items-center gap-2 border-b border-white/[0.04] px-3 py-2 text-[12px] ${
                bet.cashedOut ? 'bg-bet-500/[0.06]' : ''
              }`}
            >
              {isYou && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" />}
              <span className={`truncate ${isYou ? 'font-semibold text-neutral-100' : 'text-neutral-400'}`}>
                {isYou ? 'You' : bet.botName ?? bet.playerId.slice(0, 3)}
              </span>
              <span className="tabular-nums text-neutral-300">{amountOf(bet)}</span>
              <span className="text-center">
                {bet.cashedOut && bet.cashoutMultiplier ? (
                  <span
                    className="inline-block rounded-chip px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
                    style={
                      bet.cashoutMultiplier < 2
                        ? { color: 'hsl(0 0% 70%)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.12)' }
                        : { color: 'hsl(0 0% 6%)', backgroundColor: tierColor(bet.cashoutMultiplier) }
                    }
                  >
                    {bet.cashoutMultiplier.toFixed(2)}×
                  </span>
                ) : bet.autoCashout ? (
                  // Not a result — a standing instruction. Rendered as plain
                  // muted text so it can't be mistaken for a cashed-out chip.
                  <span className="text-[11px] tabular-nums text-neutral-600">
                    auto {bet.autoCashout.toFixed(2)}×
                  </span>
                ) : (
                  <span className="text-neutral-700">–</span>
                )}
              </span>
              <span className={`text-right tabular-nums ${bet.cashedOut ? 'font-semibold text-bet-400' : 'text-neutral-700'}`}>
                {bet.cashedOut
                  ? bet.currency
                    ? fromMinor((bet.amountMinor ?? bet.amount) + (bet.profit ?? 0), bet.currency)
                    : (bet.amount + (bet.profit ?? 0)).toFixed(2)
                  : '–'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
