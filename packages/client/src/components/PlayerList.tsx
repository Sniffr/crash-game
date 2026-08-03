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
    <div className="bg-space-900/70 backdrop-blur-md border border-space-500/40 rounded-panel p-4 flex-1 min-h-0 flex flex-col shadow-panel">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.22em]">
          Pilots in this round
        </h2>
        <span className="text-xs text-slate-500 font-mono tabular-nums">{bets.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 max-h-[420px] lg:max-h-none">
        {bets.length === 0 && (
          <div className="text-center py-10 text-slate-600 text-xs">
            Awaiting pilots…
          </div>
        )}

        {sorted.map((bet) => {
          const isYou = bet.playerId === youPlayerId;
          return (
            <div
              key={bet.playerId}
              className={`flex justify-between items-center px-3 py-2 rounded-control transition border ${
                bet.cashedOut
                  ? 'bg-aurora-500/10 border-aurora-500/25'
                  : isYou
                  ? 'bg-cosmos-500/10 border-cosmos-500/30'
                  : 'bg-space-800/40 border-space-500/30'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Avatar isYou={isYou} />
                <span className={`text-sm truncate ${isYou ? 'text-cosmos-300 font-semibold' : 'text-slate-300'}`}>
                  {isYou ? 'You' : bet.botName ?? bet.playerId.slice(0, 6)}
                </span>
              </div>
              <div className="text-right shrink-0 leading-tight">
                <div className={`text-sm font-mono tabular-nums ${isYou ? 'text-slate-100' : 'text-slate-400'}`}>
                  {bet.currency
                    ? fromMinor(bet.amountMinor ?? bet.amount, bet.currency)
                    : `$${bet.amount.toFixed(2)}`}
                </div>
                {bet.cashedOut ? (
                  <div className="text-[11px] text-aurora-400 font-mono tabular-nums">
                    {bet.cashoutMultiplier?.toFixed(2)}x · +{bet.currency
                      ? fromMinor(bet.profit ?? 0, bet.currency)
                      : `$${(bet.profit ?? 0).toFixed(2)}`}
                  </div>
                ) : bet.autoCashout ? (
                  <div className="text-[11px] text-solar-500/80 font-mono tabular-nums">
                    auto {bet.autoCashout.toFixed(2)}x
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-600 font-mono">
                    manual
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Avatar({ isYou }: { isYou: boolean }) {
  return (
    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
      isYou
        ? 'bg-gradient-to-br from-cosmos-500 to-plasma-500'
        : 'bg-gradient-to-br from-space-600 to-space-800 border border-space-500/40'
    }`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/85">
        {isYou ? (
          <>
            <circle cx="12" cy="8" r="4"/>
            <path d="M4 21v-1a8 8 0 0 1 16 0v1"/>
          </>
        ) : (
          <>
            <rect x="4" y="6" width="16" height="12" rx="2"/>
            <circle cx="9" cy="12" r="1.2" fill="currentColor"/>
            <circle cx="15" cy="12" r="1.2" fill="currentColor"/>
            <path d="M12 2v4"/>
          </>
        )}
      </svg>
    </div>
  );
}
