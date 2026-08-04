import { fromMinor } from '../lib/money';

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

/** OdiBets-style multiplier chip: orange for ≥2×, muted purple below. */
function MultChip({ m }: { m: number }) {
  const hot = m >= 2;
  return (
    <span
      className="inline-block rounded-md px-1.5 py-0.5 text-xs font-extrabold text-white tabular-nums"
      style={{ backgroundColor: hot ? 'hsl(21 90% 52%)' : 'hsl(240 16% 45%)' }}
    >
      {m.toFixed(2)}x
    </span>
  );
}

function amountOf(bet: Player): string {
  return bet.currency
    ? fromMinor(bet.amountMinor ?? bet.amount, bet.currency)
    : bet.amount.toFixed(2);
}

export default function PlayerList({ bets, youPlayerId }: PlayerListProps) {
  const sorted = [...bets].sort((a, b) => {
    const aIsYou = a.playerId === youPlayerId ? 1 : 0;
    const bIsYou = b.playerId === youPlayerId ? 1 : 0;
    if (aIsYou !== bIsYou) return bIsYou - aIsYou;
    if (a.cashedOut !== b.cashedOut) return a.cashedOut ? -1 : 1;
    if (a.cashedOut && b.cashedOut) return (b.profit || 0) - (a.profit || 0);
    return b.amount - a.amount;
  });

  return (
    <div className="bg-space-800 border border-white/5 rounded-panel flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-extrabold text-white">Live Bets</h2>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-400 tabular-nums">
            <UserIcon /> {bets.length}
          </span>
        </div>
        <span className="text-xs font-bold text-neutral-500 border border-white/10 rounded-lg px-2.5 py-1 select-none">
          Previous Round
        </span>
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-[1.1fr_1fr_auto_1fr] gap-2 px-4 py-2 text-[11px] font-bold text-neutral-500 border-b border-white/5">
        <span>User</span>
        <span>Bet</span>
        <span className="text-center">X</span>
        <span className="text-right">Cash out</span>
      </div>

      {/* Rows */}
      <div className="overflow-y-auto max-h-[300px] lg:max-h-[calc(100vh-220px)]">
        {bets.length === 0 && (
          <div className="text-center py-10 text-neutral-600 text-xs">Awaiting pilots…</div>
        )}
        {sorted.map((bet) => {
          const isYou = bet.playerId === youPlayerId;
          return (
            <div
              key={bet.playerId}
              className={`grid grid-cols-[1.1fr_1fr_auto_1fr] gap-2 items-center px-4 py-2 text-sm border-b border-white/[0.04] ${
                bet.cashedOut ? 'bg-bet-500/[0.07]' : isYou ? 'bg-info-500/[0.07]' : ''
              }`}
            >
              <span className={`truncate ${isYou ? 'text-info-300 font-bold' : 'text-neutral-300'}`}>
                {isYou ? 'You' : bet.botName ?? bet.playerId.slice(0, 3)}
              </span>
              <span className="tabular-nums text-neutral-200">{amountOf(bet)}</span>
              <span className="text-center">
                {bet.cashedOut && bet.cashoutMultiplier ? (
                  <MultChip m={bet.cashoutMultiplier} />
                ) : bet.autoCashout ? (
                  <span className="text-xs font-bold text-info-400 tabular-nums">×{bet.autoCashout.toFixed(0)}</span>
                ) : (
                  <span className="text-neutral-600">–</span>
                )}
              </span>
              <span className="text-right tabular-nums text-neutral-300">
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

function UserIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
}
