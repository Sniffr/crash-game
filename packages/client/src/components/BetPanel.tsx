import { decimalsFor, symbolFor, toMinor } from '../lib/money';
import { MinusIcon, PlusIcon } from './ui';

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

/**
 * One bet slot: stake stepper + quick chips on the left, the action on the right.
 *
 * The action button is the highest-stakes control in the product — at 2.4× with
 * money on the table, a mis-tap is expensive. So BET and CASH OUT share exactly
 * the same box (w-36 h-[68px], same radius, same black label colour) and only
 * the fill and wording change. Nothing reflows at the moment you're reaching for
 * it. Amber is cash-out, matching the canvas multiplier ramp; ember is place-bet.
 */
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

  // Why the button is unavailable, said plainly rather than left to a tooltip.
  const blockedReason = canBet || hasBet || canCashout
    ? null
    : exceedsMaxBet ? 'Above your limit'
    : !hasEnoughBalance ? 'Not enough balance'
    : null;

  const ACTION_BOX =
    'flex h-[68px] w-32 shrink-0 flex-col items-center justify-center gap-0.5 rounded-btn font-semibold ' +
    'transition-[background-color,opacity,transform] duration-150 ease-snap active:scale-[0.97] sm:w-36';

  return (
    <div className="rounded-card border border-edge bg-space-850 p-3">
      {/* Slot options. These are toggles, not tabs — an active one is ember. */}
      <div className="mb-2.5 flex items-center gap-1.5">
        <Toggle on={autoBetEnabled} onClick={() => setAutoBetEnabled(!autoBetEnabled)} title="Re-place this bet every round">
          Auto bet
        </Toggle>
        <Toggle on={autoCashoutEnabled} onClick={() => setAutoCashoutEnabled(!autoCashoutEnabled)} title="Cash out automatically at a target">
          Auto cash out
        </Toggle>
      </div>

      {autoCashoutEnabled && (
        <label className="mb-2 flex h-10 items-center gap-2 rounded-btn border border-edge bg-space-950 px-3">
          <span className="shrink-0 text-[11px] font-medium text-neutral-500">Cash out at</span>
          <input
            type="number"
            value={autoCashout}
            onChange={(e) => setAutoCashout(Math.max(1.01, Number(e.target.value) || 1.01))}
            className="h-full min-w-0 flex-1 bg-transparent text-right text-[13px] font-semibold tabular-nums text-neutral-100 outline-none"
            min={1.01}
            step={0.1}
          />
          <span className="shrink-0 text-[13px] font-semibold text-cash-400">×</span>
        </label>
      )}

      <div className="flex gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex h-11 items-center overflow-hidden rounded-btn border border-edge bg-space-950">
            <button
              type="button"
              onClick={() => setClamped(betAmount - nudge)}
              className="grid h-full w-11 shrink-0 place-items-center text-neutral-400 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-neutral-100"
              aria-label="Decrease stake"
            >
              <MinusIcon className="h-4 w-4" />
            </button>
            <input
              type="number"
              value={betAmount}
              onChange={(e) => setClamped(Number(e.target.value) || step)}
              className="h-full min-w-0 flex-1 bg-transparent text-center text-[17px] font-bold tabular-nums text-neutral-100 outline-none"
              aria-label="Stake"
              min={step}
              max={maxBetMajor}
              inputMode="decimal"
              step={step}
            />
            <button
              type="button"
              onClick={() => setClamped(betAmount + nudge)}
              className="grid h-full w-11 shrink-0 place-items-center text-neutral-400 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-neutral-100"
              aria-label="Increase stake"
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {betAmounts.slice(0, 4).map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setClamped(amt)}
                className="h-10 rounded-btn border border-edge bg-space-950 text-[12px] font-semibold tabular-nums text-neutral-300 transition-[background-color,border-color,color,transform] duration-150 ease-snap hover:border-edge-strong hover:bg-white/[0.04] hover:text-neutral-100 active:scale-[0.97]"
              >
                {chip(amt)}
              </button>
            ))}
          </div>
        </div>

        {canCashout ? (
          <button type="button" onClick={onCashout} className={`${ACTION_BOX} bg-cash-500 text-black hover:bg-cash-400`}>
            <span className="text-[11px] font-semibold opacity-70">Cash out</span>
            <span className="text-[17px] font-bold tabular-nums">{money(betAmount * currentMultiplier)}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onPlaceBet}
            disabled={!canBet}
            // Disabled goes to a neutral surface rather than a dimmed ember —
            // 40%-opacity orange on near-black reads as a muddy brown smear,
            // which looks broken rather than inert.
            className={`${ACTION_BOX} bg-brand-500 text-black hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-neutral-600`}
          >
            <span className="text-[11px] font-semibold opacity-70">
              {hasBet ? (phase === 'BETTING' ? 'Placed' : 'In play') : 'Bet'}
            </span>
            <span className="text-[17px] font-bold tabular-nums">{money(betAmount)}</span>
          </button>
        )}
      </div>

      {blockedReason && (
        <p role="status" className="mt-2 text-right text-[11px] text-loss-400">{blockedReason}</p>
      )}
    </div>
  );
}

function Toggle({
  on, onClick, title, children,
}: {
  on: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`h-10 rounded-btn border px-3 text-[12px] font-semibold transition-[background-color,border-color,color,transform] duration-150 ease-snap active:scale-[0.97] ${
        on
          ? 'border-brand-500/60 bg-brand-500/12 text-brand-300'
          : 'border-edge bg-space-950 text-neutral-500 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}
