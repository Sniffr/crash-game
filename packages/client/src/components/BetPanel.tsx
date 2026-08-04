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
  autoBetEnabled: boolean;
  setAutoBetEnabled: (v: boolean) => void;
  currentMultiplier: number;
  /** Quick-stake chip values; first 4 are shown (e.g. 10 / 100 / 1K / 10K). */
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

/** OdiBets-style bet section: Auto tabs + Bonus, a − value + stepper with quick
 *  chips, and a big BET / CASH OUT button. Rendered twice for the dual-bet UI. */
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
  autoBetEnabled,
  setAutoBetEnabled,
  currentMultiplier,
  betAmounts,
  onPlaceBet,
  onCashout,
  maxBetMinor,
  currency,
  isOperator = false,
}: BetPanelProps) {
  const decimals = decimalsFor(currency);
  const symbol = symbolFor(currency);
  const step = 1 / Math.pow(10, decimals);
  const nudge = 1; // + / − adjust by one unit

  const betAmountMinor = isOperator ? toMinor(betAmount, currency) : betAmount;
  const hasEnoughBalance = isOperator ? balance >= betAmountMinor : balance >= betAmount;
  const exceedsMaxBet = isOperator && maxBetMinor != null && betAmountMinor > maxBetMinor;
  const maxBetMajor = isOperator && maxBetMinor != null
    ? maxBetMinor / Math.pow(10, decimals)
    : isOperator
    ? balance / Math.pow(10, decimals)
    : balance;

  const canBet = phase === 'BETTING' && !hasBet && hasEnoughBalance && !exceedsMaxBet;
  const canCashout = phase === 'FLYING' && hasBet;
  const money = (v: number) => `${symbol}${v.toFixed(Math.min(decimals, 2))}`;
  const chip = (v: number) => (v >= 1000 ? `${v / 1000}K` : String(v));

  const setClamped = (v: number) => setBetAmount(Math.max(step, Math.min(maxBetMajor, v)));

  return (
    <div className="bg-space-800 border border-white/5 rounded-panel p-3">
      {/* Tabs + Bonus */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setAutoBetEnabled(!autoBetEnabled)}
            className={`text-sm font-bold transition ${autoBetEnabled ? 'text-brand-400' : 'text-neutral-500 hover:text-neutral-300'}`}
            title="Auto-rebet each round"
          >
            Auto Bet
          </button>
          <button
            onClick={() => setAutoCashoutEnabled(!autoCashoutEnabled)}
            className={`text-sm font-bold transition ${autoCashoutEnabled ? 'text-brand-400' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            Auto Cashout
          </button>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-info-500/60 text-info-500 px-2.5 py-1 text-xs font-bold select-none">
          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          Bonus
        </span>
      </div>

      {/* Auto-cashout target */}
      {autoCashoutEnabled && (
        <div className="flex items-center gap-2 bg-space-950 border border-white/5 rounded-control px-3 h-9 mb-2.5">
          <label className="text-[11px] font-bold text-neutral-400">Auto cash at</label>
          <input
            type="number"
            value={autoCashout}
            onChange={(e) => setAutoCashout(Math.max(1.01, Number(e.target.value) || 1.01))}
            className="flex-1 bg-transparent text-white text-sm font-bold focus:outline-none tabular-nums text-right"
            min={1.01}
            step={0.1}
          />
          <span className="text-xs text-cash-400 font-bold">×</span>
        </div>
      )}

      {/* Stepper + chips (left) · BET/CASH OUT (right) */}
      <div className="flex gap-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center bg-space-950 border border-white/5 rounded-control h-11 mb-1.5 overflow-hidden">
            <button
              onClick={() => setClamped(betAmount - nudge)}
              className="w-11 h-full grid place-items-center text-2xl leading-none text-neutral-300 hover:text-white hover:bg-space-700/60"
              aria-label="decrease stake"
            >−</button>
            <input
              type="number"
              value={betAmount}
              onChange={(e) => setClamped(Number(e.target.value) || step)}
              className="flex-1 min-w-0 bg-transparent text-center text-white text-lg font-extrabold focus:outline-none tabular-nums"
              min={step}
              max={maxBetMajor}
              inputMode="decimal"
              step={step}
            />
            <button
              onClick={() => setClamped(betAmount + nudge)}
              className="w-11 h-full grid place-items-center text-2xl leading-none text-neutral-300 hover:text-white hover:bg-space-700/60"
              aria-label="increase stake"
            >+</button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {betAmounts.slice(0, 4).map((amt) => (
              <button
                key={amt}
                onClick={() => setClamped(amt)}
                className="bg-space-950 border border-white/5 rounded-lg py-1.5 text-xs font-bold text-neutral-300 hover:text-white hover:border-white/15 tabular-nums transition"
              >
                {chip(amt)}
              </button>
            ))}
          </div>
        </div>

        {canCashout ? (
          <button
            onClick={onCashout}
            className="w-32 sm:w-36 shrink-0 rounded-control bg-cash-500 hover:bg-cash-400 text-space-950 font-extrabold flex flex-col items-center justify-center leading-tight transition active:scale-[0.99]"
          >
            <span className="text-xs tracking-wide">CASH OUT</span>
            <span className="text-base tabular-nums">{money(betAmount * currentMultiplier)}</span>
          </button>
        ) : (
          <button
            onClick={onPlaceBet}
            disabled={!canBet}
            className="w-32 sm:w-36 shrink-0 rounded-control bg-brand-500 hover:bg-brand-400 disabled:opacity-45 disabled:cursor-not-allowed text-white font-extrabold flex flex-col items-center justify-center leading-tight transition active:scale-[0.99]"
            title={
              !canBet && !hasBet
                ? exceedsMaxBet ? 'Above operator limit'
                : !hasEnoughBalance ? 'Insufficient balance'
                : 'Waiting for the next round'
                : undefined
            }
          >
            <span className="text-xs tracking-wide">{hasBet ? (phase === 'BETTING' ? 'PLACED' : 'ROUND OVER') : 'BET'}</span>
            <span className="text-base tabular-nums">{money(betAmount)}</span>
          </button>
        )}
      </div>
    </div>
  );
}
