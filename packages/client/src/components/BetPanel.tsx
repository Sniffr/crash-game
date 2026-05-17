import { useState } from 'react';

interface BetPanelProps {
  phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';
  hasBet: boolean;
  balance: number;
  betAmount: number;
  setBetAmount: (v: number) => void;
  autoCashoutEnabled: boolean;
  setAutoCashoutEnabled: (v: boolean) => void;
  autoCashout: number;
  setAutoCashout: (v: number) => void;
  currentMultiplier: number;
  betAmounts: number[];
  onPlaceBet: () => void;
  onCashout: () => void;
}

export default function BetPanel({
  phase,
  hasBet,
  balance,
  betAmount,
  setBetAmount,
  autoCashoutEnabled,
  setAutoCashoutEnabled,
  autoCashout,
  setAutoCashout,
  currentMultiplier,
  betAmounts,
  onPlaceBet,
  onCashout,
}: BetPanelProps) {
  const [showAutoCashout, setShowAutoCashout] = useState(false);

  const canBet = phase === 'BETTING' && !hasBet && balance >= betAmount;
  const canCashout = phase === 'FLYING' && hasBet;
  const isCashedOut = hasBet && phase !== 'FLYING' && phase !== 'BETTING';

  return (
    <div className="bg-black/30 backdrop-blur-sm border border-white/10 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Bet</h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Auto Cashout</label>
          <button
            onClick={() => setAutoCashoutEnabled(!autoCashoutEnabled)}
            className={`w-10 h-5 rounded-full transition-colors relative ${
              autoCashoutEnabled ? 'bg-green-500' : 'bg-gray-600'
            }`}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                autoCashoutEnabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Quick amount buttons */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {betAmounts.map((amt) => (
          <button
            key={amt}
            onClick={() => setBetAmount(amt)}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              betAmount === amt
                ? 'bg-green-500/30 text-green-400 border border-green-500/50'
                : 'bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 hover:text-white'
            }`}
          >
            ${amt}
          </button>
        ))}
      </div>

      {/* Amount input */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="number"
          value={betAmount}
          onChange={(e) => setBetAmount(Math.max(1, Number(e.target.value)))}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-green-500/50"
          min={1}
          max={balance}
        />
        <button
          onClick={() => setBetAmount(Math.max(1, Math.floor(betAmount / 2)))}
          className="px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 hover:text-white transition-colors font-bold"
        >
          ½
        </button>
        <button
          onClick={() => setBetAmount(Math.min(balance, betAmount * 2))}
          className="px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 hover:text-white transition-colors font-bold"
        >
          2×
        </button>
      </div>

      {/* Auto cashout input */}
      {autoCashoutEnabled && (
        <div className="mb-3">
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={autoCashout}
              onChange={(e) => setAutoCashout(Math.max(1.01, Number(e.target.value)))}
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-orange-500/50"
              min={1.01}
              step={0.1}
            />
            <span className="text-xs text-gray-400">x</span>
          </div>
        </div>
      )}

      {/* Action button */}
      {canBet && (
        <button
          onClick={onPlaceBet}
          className="w-full py-3.5 rounded-xl bg-gradient-to-r from-green-500 to-green-400 text-black font-bold text-sm uppercase tracking-wider hover:from-green-400 hover:to-green-300 transition-all active:scale-[0.98] shadow-lg shadow-green-500/20"
        >
          Bet ${betAmount.toFixed(2)}
        </button>
      )}

      {canCashout && (
        <button
          onClick={onCashout}
          className="w-full py-3.5 rounded-xl bg-gradient-to-r from-orange-500 to-amber-400 text-black font-bold text-sm uppercase tracking-wider hover:from-orange-400 hover:to-amber-300 transition-all active:scale-[0.98] shadow-lg shadow-orange-500/20 animate-pulse"
        >
          Cash Out ${(betAmount * currentMultiplier).toFixed(2)}
        </button>
      )}

      {isCashedOut && (
        <button
          disabled
          className="w-full py-3.5 rounded-xl bg-white/10 text-gray-400 font-bold text-sm uppercase tracking-wider cursor-not-allowed"
        >
          Bet Placed
        </button>
      )}

      {!canBet && !canCashout && !isCashedOut && phase === 'BETTING' && balance < betAmount && (
        <button
          disabled
          className="w-full py-3.5 rounded-xl bg-white/10 text-gray-500 font-bold text-sm uppercase tracking-wider cursor-not-allowed"
        >
          Insufficient Balance
        </button>
      )}
    </div>
  );
}
