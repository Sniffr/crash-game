import { decimalsFor, symbolFor, toMinor } from '../lib/money';

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
  /** Operator max bet in minor units. When set, enforces an upper limit on bets. */
  maxBetMinor?: number;
  /** ISO-4217 currency code for operator sessions. */
  currency?: string;
  /** True when this is an operator-backed session (balance is in minor units). */
  isOperator?: boolean;
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
  maxBetMinor,
  currency,
  isOperator = false,
}: BetPanelProps) {
  const decimals = decimalsFor(currency);
  const symbol = symbolFor(currency);

  // For operator sessions: balance is in minor units, betAmount is in major units typed by user.
  // Convert betAmount to minor units for all comparisons.
  const betAmountMinor = isOperator ? toMinor(betAmount, currency) : betAmount;

  // Balance check: for operator sessions compare minor units; for legacy compare decimal credits.
  const hasEnoughBalance = isOperator
    ? balance >= betAmountMinor
    : balance >= betAmount;

  // Operator max-bet enforcement
  const exceedsMaxBet = isOperator && maxBetMinor != null && betAmountMinor > maxBetMinor;

  // Max allowed bet in major units (for the input's max attribute and double button)
  const maxBetMajor = isOperator && maxBetMinor != null
    ? maxBetMinor / Math.pow(10, decimals)
    : isOperator
    ? balance / Math.pow(10, decimals)
    : balance;

  const canBet = phase === 'BETTING' && !hasBet && hasEnoughBalance && !exceedsMaxBet;
  const canCashout = phase === 'FLYING' && hasBet;

  const seconds =
    phase === 'BETTING' && countdownMs != null
      ? Math.max(0, Math.ceil(countdownMs / 1000))
      : null;
  const progress =
    phase === 'BETTING' && countdownMs != null
      ? Math.max(0, Math.min(1, 1 - countdownMs / BETTING_TOTAL_MS))
      : 0;

  const step = 1 / Math.pow(10, decimals);

  return (
    <div className="bg-space-800 border border-white/5 rounded-panel p-4 shadow-panel">
      {/* Countdown */}
      {phase === 'BETTING' && seconds != null && (
        <div className="mb-4 rounded-control overflow-hidden border border-brand-500/25 bg-brand-500/5">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-brand-400 font-bold">
              Launch in
            </div>
            <div
              key={seconds}
              className="text-3xl font-mono font-extrabold text-brand-400 leading-none animate-countdown tabular-nums"
              style={{ textShadow: '0 0 16px rgba(251, 101, 20, 0.6)' }}
            >
              {seconds}
            </div>
          </div>
          <div className="h-[3px] bg-space-950/80">
            <div
              className="h-full bg-brand-500 transition-all duration-100 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-extrabold text-white tracking-tight">Place bet</h2>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Auto</span>
          <button
            onClick={() => setAutoCashoutEnabled(!autoCashoutEnabled)}
            className={`w-9 h-5 rounded-full transition-colors relative ${
              autoCashoutEnabled ? 'bg-brand-500' : 'bg-space-600'
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

      {/* Stake stepper: ½ · $input · 2×  (iMoon layout) */}
      <div className="flex items-center gap-1.5 mb-2.5 bg-space-950/60 border border-white/5 rounded-control p-1.5">
        <button
          onClick={() => setBetAmount(Math.max(step, betAmount / 2))}
          className="px-3 h-9 rounded-lg bg-space-700/70 border border-white/5 text-slate-300 hover:bg-space-600 hover:text-white transition font-bold text-xs shrink-0"
          aria-label="halve stake"
        >½</button>
        <div className="flex-1 flex items-center gap-1 px-2 h-9">
          <span className="text-slate-500 font-mono font-bold">{symbol}</span>
          <input
            type="number"
            value={betAmount}
            onChange={(e) => setBetAmount(Math.max(step, Number(e.target.value) || step))}
            className="w-full bg-transparent text-white text-lg font-mono font-extrabold focus:outline-none tabular-nums"
            min={step}
            max={maxBetMajor}
            inputMode="decimal"
            step={step}
          />
        </div>
        <button
          onClick={() => setBetAmount(Math.max(step, Math.min(maxBetMajor, betAmount * 2)))}
          className="px-3 h-9 rounded-lg bg-space-700/70 border border-white/5 text-slate-300 hover:bg-space-600 hover:text-white transition font-bold text-xs shrink-0"
          aria-label="double stake"
        >2×</button>
      </div>

      {/* Quick amounts */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {betAmounts.slice(0, 8).map((amt) => (
          <button
            key={amt}
            onClick={() => setBetAmount(amt)}
            className={`px-1 py-1.5 rounded-lg text-xs font-mono font-bold transition border tabular-nums ${
              betAmount === amt
                ? 'bg-brand-500/15 text-brand-400 border-brand-500/40'
                : 'bg-space-900/50 text-slate-400 border-white/5 hover:border-white/15 hover:text-slate-200'
            }`}
          >
            {symbol}{amt}
          </button>
        ))}
      </div>

      {/* Auto cashout target */}
      {autoCashoutEnabled && (
        <div className="mb-3">
          <div className="flex items-center gap-2 bg-space-950/60 border border-white/5 rounded-control px-3 h-10">
            <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Auto cash at</label>
            <input
              type="number"
              value={autoCashout}
              onChange={(e) => setAutoCashout(Math.max(1.01, Number(e.target.value) || 1.01))}
              className="flex-1 bg-transparent text-white text-sm font-mono font-bold focus:outline-none tabular-nums text-right"
              min={1.01}
              step={0.1}
            />
            <span className="text-xs text-cash-400 font-mono font-bold">×</span>
          </div>
        </div>
      )}

      {/* Primary action — Cashout while flying with a live bet; otherwise the
          Place Bet button is ALWAYS shown (disabled with a reason when you can't
          bet yet), so it never disappears between rounds. */}
      {canCashout ? (
        <button
          onClick={onCashout}
          className="w-full h-12 rounded-control bg-cash-500 hover:bg-cash-400 text-space-950 font-display font-extrabold text-base transition active:scale-[0.99]"
        >
          Cash out {symbol}{(betAmount * currentMultiplier).toFixed(Math.min(decimals, 8))}
        </button>
      ) : hasBet ? (
        <div className={`w-full h-12 rounded-control border font-bold text-sm flex items-center justify-center ${
          phase === 'BETTING'
            ? 'bg-bet-500/12 border-bet-500/40 text-bet-400'
            : 'bg-space-900/50 border-white/5 text-slate-400'
        }`}>
          {phase === 'BETTING' ? 'Bet locked in' : 'Round complete'}
        </div>
      ) : (
        <button
          onClick={onPlaceBet}
          disabled={!canBet}
          className="w-full h-12 rounded-control bg-bet-500 hover:bg-bet-400 text-white font-display font-extrabold text-base transition active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-bet-500"
        >
          {canBet
            ? `Bet ${symbol}${betAmount.toFixed(Math.min(decimals, 8))}${seconds != null ? ` · ${seconds}s` : ''}`
            : exceedsMaxBet
            ? 'Above operator limit'
            : !hasEnoughBalance
            ? 'Insufficient balance'
            : 'Bet · waiting for next round'}
        </button>
      )}
    </div>
  );
}
