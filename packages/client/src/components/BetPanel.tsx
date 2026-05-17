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
  countdownMs?: number;
  betAmounts: number[];
  onPlaceBet: () => void;
  onCashout: () => void;
}

const BETTING_TOTAL_MS = 5000;

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
  countdownMs,
  betAmounts,
  onPlaceBet,
  onCashout,
}: BetPanelProps) {
  const canBet = phase === 'BETTING' && !hasBet && balance >= betAmount;
  const canCashout = phase === 'FLYING' && hasBet;
  const isCashedOut = hasBet && phase !== 'FLYING' && phase !== 'BETTING';

  const seconds =
    phase === 'BETTING' && countdownMs != null
      ? Math.max(0, Math.ceil(countdownMs / 1000))
      : null;
  const progress =
    phase === 'BETTING' && countdownMs != null
      ? Math.max(0, Math.min(1, 1 - countdownMs / BETTING_TOTAL_MS))
      : 0;

  return (
    <div className="bg-space-900/70 backdrop-blur-md border border-space-500/40 rounded-panel p-4 shadow-panel">
      {/* Countdown */}
      {phase === 'BETTING' && seconds != null && (
        <div className="mb-4 rounded-control overflow-hidden border border-plasma-500/30 bg-plasma-500/5">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.22em] text-plasma-400/80 font-semibold">
              Launch in
            </div>
            <div
              key={seconds}
              className="text-3xl font-display font-bold text-plasma-400 leading-none animate-countdown tabular-nums"
              style={{ textShadow: '0 0 14px rgba(34, 211, 238, 0.55)' }}
            >
              {seconds}
            </div>
          </div>
          <div className="h-[3px] bg-space-700/80">
            <div
              className="h-full bg-gradient-to-r from-plasma-500 to-cosmos-400 transition-all duration-100 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.22em]">Place bet</h2>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Auto</span>
          <button
            onClick={() => setAutoCashoutEnabled(!autoCashoutEnabled)}
            className={`w-9 h-5 rounded-full transition-colors relative ${
              autoCashoutEnabled ? 'bg-plasma-500' : 'bg-space-600'
            }`}
            aria-pressed={autoCashoutEnabled}
            aria-label="Toggle auto cashout"
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                autoCashoutEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </label>
      </div>

      {/* Stake input */}
      <div className="flex items-center gap-2 mb-2.5">
        <button
          onClick={() => setBetAmount(Math.max(1, Math.floor(betAmount / 2)))}
          className="w-9 h-10 rounded-control bg-space-800/80 border border-space-500/40 text-slate-300 hover:bg-space-700 hover:text-white transition font-mono"
          aria-label="halve"
        >−</button>
        <input
          type="number"
          value={betAmount}
          onChange={(e) => setBetAmount(Math.max(1, Number(e.target.value) || 1))}
          className="flex-1 bg-space-800/80 border border-space-500/40 rounded-control px-3 h-10 text-white text-base font-mono font-semibold focus:outline-none focus:border-plasma-500/60 focus:ring-1 focus:ring-plasma-500/30 tabular-nums text-center"
          min={1}
          max={balance}
          inputMode="decimal"
        />
        <button
          onClick={() => setBetAmount(Math.max(1, Math.min(balance, betAmount * 2)))}
          className="w-9 h-10 rounded-control bg-space-800/80 border border-space-500/40 text-slate-300 hover:bg-space-700 hover:text-white transition font-mono"
          aria-label="double"
        >+</button>
      </div>

      {/* Quick amounts */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {betAmounts.slice(0, 8).map((amt) => (
          <button
            key={amt}
            onClick={() => setBetAmount(amt)}
            className={`px-1 py-1.5 rounded-control text-xs font-mono font-semibold transition border tabular-nums ${
              betAmount === amt
                ? 'bg-plasma-500/15 text-plasma-400 border-plasma-500/40'
                : 'bg-space-800/40 text-slate-400 border-space-500/30 hover:border-space-500/60 hover:text-slate-200'
            }`}
          >
            ${amt}
          </button>
        ))}
      </div>

      {/* Auto cashout target */}
      {autoCashoutEnabled && (
        <div className="mb-3">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-[0.18em] text-slate-400 w-16">Target</label>
            <input
              type="number"
              value={autoCashout}
              onChange={(e) => setAutoCashout(Math.max(1.01, Number(e.target.value) || 1.01))}
              className="flex-1 bg-space-800/80 border border-space-500/40 rounded-control px-3 h-9 text-white text-sm font-mono focus:outline-none focus:border-solar-500/60 tabular-nums"
              min={1.01}
              step={0.1}
            />
            <span className="text-xs text-slate-500 font-mono">x</span>
          </div>
        </div>
      )}

      {/* Primary action */}
      {canBet && (
        <button
          onClick={onPlaceBet}
          className="w-full h-12 rounded-control bg-gradient-to-r from-aurora-500 to-plasma-500 text-space-950 font-display font-bold text-sm uppercase tracking-[0.18em] hover:brightness-110 transition active:scale-[0.99] shadow-lg shadow-aurora-500/20"
        >
          Place Bet · ${betAmount.toFixed(2)}
          {seconds != null && (
            <span className="ml-2 opacity-60">({seconds}s)</span>
          )}
        </button>
      )}

      {canCashout && (
        <button
          onClick={onCashout}
          className="w-full h-12 rounded-control bg-gradient-to-r from-solar-500 to-nebula-500 text-space-950 font-display font-bold text-sm uppercase tracking-[0.18em] hover:brightness-110 transition active:scale-[0.99] btn-pulse-cashout"
        >
          Cash Out · ${(betAmount * currentMultiplier).toFixed(2)}
        </button>
      )}

      {isCashedOut && (
        <div className="w-full h-12 rounded-control bg-space-800/50 border border-space-500/30 text-slate-400 font-semibold text-sm uppercase tracking-[0.18em] flex items-center justify-center">
          Round complete
        </div>
      )}

      {hasBet && phase === 'BETTING' && (
        <div className="w-full h-12 rounded-control bg-cosmos-500/15 border border-cosmos-500/40 text-cosmos-400 font-semibold text-sm uppercase tracking-[0.18em] flex items-center justify-center">
          Bet locked in
        </div>
      )}

      {!canBet && !canCashout && !isCashedOut && !hasBet && phase === 'BETTING' && balance < betAmount && (
        <div className="w-full h-12 rounded-control bg-space-800/50 border border-nebula-500/30 text-nebula-400/80 font-semibold text-sm uppercase tracking-[0.18em] flex items-center justify-center">
          Insufficient balance
        </div>
      )}

      {phase !== 'BETTING' && phase !== 'FLYING' && !hasBet && (
        <div className="w-full h-12 rounded-control bg-space-800/40 border border-space-500/30 text-slate-500 font-semibold text-sm uppercase tracking-[0.18em] flex items-center justify-center">
          Waiting for next launch…
        </div>
      )}
    </div>
  );
}
