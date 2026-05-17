interface Player {
  playerId: string;
  amount: number;
  autoCashout?: number;
  cashedOut: boolean;
  isBot: boolean;
  botName?: string;
  profit?: number;
  cashoutMultiplier?: number;
}

interface PlayerListProps {
  bets: Player[];
}

export default function PlayerList({ bets }: PlayerListProps) {
  // Separate real players and bots
  const realPlayers = bets.filter((b) => !b.isBot);
  const bots = bets.filter((b) => b.isBot);

  // Sort by cashout (cashed out first, then by profit desc)
  const sortedBots = [...bots].sort((a, b) => {
    if (a.cashedOut && !b.cashedOut) return -1;
    if (!a.cashedOut && b.cashedOut) return 1;
    if (a.cashedOut && b.cashedOut) return (b.profit || 0) - (a.profit || 0);
    return b.amount - a.amount;
  });

  return (
    <div className="bg-black/30 backdrop-blur-sm border border-white/10 rounded-xl p-4 flex-1 min-h-0 flex flex-col">
      <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
        Players ({bets.length})
      </h2>

      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1" style={{ maxHeight: '300px' }}>
        {bets.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-xs">
            Waiting for players...
          </div>
        )}

        {/* Real player */}
        {realPlayers.map((bet) => (
          <div
            key={bet.playerId}
            className={`flex justify-between items-center px-3 py-2 rounded-lg transition-all ${
              bet.cashedOut
                ? 'bg-green-500/10 border border-green-500/20'
                : 'bg-white/5 border border-white/5'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-xs">
                👤
              </div>
              <span className="text-sm font-medium">You</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono">${bet.amount.toFixed(2)}</div>
              {bet.cashedOut && (
                <div className="text-xs text-green-400 font-mono">
                  ✓ {bet.cashoutMultiplier?.toFixed(2)}x → ${(bet.profit || 0).toFixed(2)}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Bots */}
        {sortedBots.map((bet) => (
          <div
            key={bet.playerId}
            className={`flex justify-between items-center px-3 py-2 rounded-lg transition-all ${
              bet.cashedOut
                ? 'bg-green-500/10 border border-green-500/20'
                : 'bg-white/5 border border-white/5'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center text-xs">
                🤖
              </div>
              <span className="text-sm text-gray-400">{bet.botName}</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono text-gray-400">${bet.amount.toFixed(2)}</div>
              {bet.cashedOut && (
                <div className="text-xs text-green-400 font-mono">
                  {bet.cashoutMultiplier?.toFixed(2)}x
                </div>
              )}
              {!bet.cashedOut && bet.autoCashout && (
                <div className="text-xs text-orange-400/60 font-mono">
                  auto {bet.autoCashout.toFixed(2)}x
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
