import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { clock, money, toMinor } from '../lib/format';
import { navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { BetDetailsBody, type SimBetView } from '../components/BetDetails';
import { Ball, Check, Close, Info, Trash } from '../components/glyphs';
import { Button, Checkbox, ErrorNote, Modal } from '../components/ui';
import { useSlip, type SlipLeg } from './slip';

const QUICK = [50, 100, 500, 1000];

interface Limits { minStakeMinor: number; maxStakeMinor: number; maxPayoutMinor: number }
let limitsCache: Limits | null = null;
let maxLegsCache: number | null = null;

function useLimits(): { limits: Limits | null; maxLegs: number } {
  const [limits, setLimits] = useState(limitsCache);
  const [maxLegs, setMaxLegs] = useState(maxLegsCache ?? 20);
  useEffect(() => {
    if (!limitsCache) api<Limits>('/api/account/limits').then((l) => { limitsCache = l; setLimits(l); }).catch(() => {});
    if (maxLegsCache == null) api<{ maxLegs: number }>('/api/simulate/config').then((c) => { maxLegsCache = c.maxLegs; setMaxLegs(c.maxLegs); }).catch(() => {});
  }, []);
  return { limits, maxLegs };
}

/**
 * The bet slip. Real money: stakes come out of the KES wallet, and each bet
 * settles the moment it's placed (provably fair), so placing opens the result.
 */
export function Betslip({ onPlaced }: { onPlaced?: () => void }) {
  const slip = useSlip();
  const { account, token, requireAuth, setBalance, openModal } = useSession();
  const { limits, maxLegs } = useLimits();
  const currency = account?.currency ?? 'KES';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; deposit?: boolean } | null>(null);
  const [result, setResult] = useState<{ bets: SimBetView[]; legs: SlipLeg[] } | null>(null);
  const [lastPick, setLastPick] = useState<number | null>(null);

  const legs = slip.legs;
  const stakeMinor = toMinor(Number(slip.stake), currency);
  const multi = slip.mode === 'multi';
  const totalOdds = useMemo(() => legs.reduce((a, l) => a * l.odds, 1), [legs]);
  const betCount = multi ? (legs.length > 0 ? 1 : 0) : legs.length;
  const totalStake = stakeMinor == null ? 0 : stakeMinor * betCount;
  const rawWin = stakeMinor == null ? 0 : multi ? Math.floor(stakeMinor * totalOdds) : legs.reduce((a, l) => a + Math.floor(stakeMinor * l.odds), 0);
  const cap = limits?.maxPayoutMinor;
  const possibleWin = cap && multi ? Math.min(rawWin, cap) : rawWin;

  useEffect(() => { setError(null); }, [legs.length, slip.mode, slip.stake]);

  const problem = (): string | null => {
    if (legs.length === 0) return 'Add a selection first.';
    if (stakeMinor == null) return 'Enter your stake.';
    if (limits && stakeMinor < limits.minStakeMinor) return `The minimum stake is ${money(limits.minStakeMinor, currency)}.`;
    if (limits && stakeMinor > limits.maxStakeMinor) return `The maximum stake is ${money(limits.maxStakeMinor, currency)}.`;
    if (legs.length > maxLegs) return `A slip can hold up to ${maxLegs} selections.`;
    if (account && totalStake > account.balanceMinor) return 'deposit';
    return null;
  };

  const place = () => {
    const p = problem();
    if (p === 'deposit') { setError({ text: `Your balance is ${money(account!.balanceMinor, currency)} — top up to place this bet.`, deposit: true }); return; }
    if (p) { setError({ text: p }); return; }
    requireAuth(async () => {
      setBusy(true);
      setError(null);
      const placing = [...legs];
      try {
        const r = await api<{ balanceMinor: number; currency: string; bets: SimBetView[] }>('/api/simulate/bets', {
          auth: true,
          body: {
            mode: slip.mode,
            stakeMinor,
            acceptOddsChanges: slip.acceptOddsChanges,
            selections: placing.map((l) => ({ eventId: l.eventId, market: l.market, pick: l.pick, odds: l.odds })),
          },
        });
        setBalance(r.balanceMinor);
        setResult({ bets: r.bets.map((b) => ({ ...b, currency: r.currency })), legs: placing });
        slip.clear();
        onPlaced?.();
      } catch (err) {
        if (!(err instanceof ApiError)) { setError({ text: 'Something went wrong — please try again.' }); return; }
        if (err.code === 'ODDS_CHANGED' && Array.isArray(err.details.changes)) {
          slip.reprice(err.details.changes as Array<{ eventId: string; market: string; pick: string; odds: number }>);
          setError({ text: 'Odds changed on your slip — the new prices are shown. Place again to accept them.' });
        } else if (err.code === 'EVENT_STARTED' || err.code === 'UNKNOWN_EVENT' || err.code === 'INVALID_PICK') {
          const gone = placing.find((l) => err.message.includes(l.eventId));
          if (gone) slip.remove(gone.eventId);
          setError({ text: gone ? `${gone.home} v ${gone.away} is no longer available and was removed from your slip.` : 'A match on your slip is no longer available.' });
        } else if (err.code === 'INSUFFICIENT_FUNDS') {
          setError({ text: err.message, deposit: true });
        } else if (err.code === 'STAKE_TOO_SMALL' || err.code === 'STAKE_TOO_LARGE') {
          setError({ text: limits ? `Stakes run from ${money(limits.minStakeMinor, currency)} to ${money(limits.maxStakeMinor, currency)}.` : err.message });
        } else {
          setError({ text: err.message });
        }
      } finally {
        setBusy(false);
      }
    });
  };

  const addQuick = (v: number) => {
    setLastPick(v);
    slip.setStake(String((Number(slip.stake) || 0) + v));
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-sb-primary bg-sb-surface">
      <div className="flex items-center justify-center gap-3 bg-sb-primary py-2.5 text-white">
        <h2 className="font-sb-display text-[20px]">Betslip</h2>
        <span className="grid h-7 min-w-7 place-items-center rounded-full bg-white px-1.5 text-[14px] font-semibold text-sb-primary sb-tabular">{legs.length}</span>
      </div>
      <div className="grid grid-cols-2 border-b border-sb-line text-[16px]">
        {(['single', 'multi'] as const).map((m) => (
          <button key={m} type="button" onClick={() => slip.setMode(m)} aria-pressed={slip.mode === m}
            className={`border-b-2 py-2 ${slip.mode === m ? 'border-sb-primary font-semibold text-sb-accent' : 'border-transparent text-sb-text'}`}>
            {m === 'single' ? 'Singles' : 'Multi'}
          </button>
        ))}
      </div>

      {legs.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sb-primary/10 text-sb-accent"><Ball className="h-7 w-7" /></span>
          <p className="mt-4 font-sb-display text-[20px]">Your betslip is empty</p>
          <p className="mt-1 text-[14px] text-sb-muted">Tap any odds to add a selection.</p>
          {!token && <p className="mt-4 text-[13px] text-sb-muted">You can build a slip now and log in to place it.</p>}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-sb-line px-4 py-2.5">
            <Checkbox checked={slip.acceptOddsChanges} onChange={slip.setAcceptOddsChanges} label="Accept odd changes" />
            <button type="button" onClick={slip.clear} className="flex items-center gap-1 text-[15px] text-sb-text hover:text-sb-error">
              Clear Bet Slip <Trash className="h-4 w-4 text-sb-error" />
            </button>
          </div>
          <ul className="sb-scroll max-h-[40vh] divide-y divide-sb-line overflow-y-auto lg:max-h-[320px]">
            {legs.map((l) => (
              <li key={l.eventId} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Ball className="h-4 w-4 shrink-0 text-sb-muted" />
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{l.label}</span>
                  <span className="font-semibold text-sb-accent sb-tabular">{l.odds.toFixed(2)}</span>
                  <button type="button" onClick={() => slip.remove(l.eventId)} aria-label={`Remove ${l.home} v ${l.away}`}
                    className="-mr-2 grid h-8 w-8 place-items-center rounded-full text-sb-muted hover:bg-sb-surface2 hover:text-sb-error">
                    <Close className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-0.5 text-[13px] text-sb-muted">{l.marketName}</p>
                <p className="text-[15px]">{l.home} - {l.away}</p>
                <p className="text-[13px] text-sb-muted">{clock(l.kickoff)}</p>
              </li>
            ))}
          </ul>

          <div className="border-t border-sb-line px-4 py-4">
            <div className="flex items-center justify-between text-[16px]">
              <span>{multi ? 'Total Odds' : 'Bets'}</span>
              <span className="font-semibold sb-tabular">{multi ? totalOdds.toFixed(2) : betCount}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[16px]">
              <span className="flex items-center gap-1.5">
                Possible Win
                <span title={multi ? 'Stake × total odds, if every selection wins.' : 'If every single wins: the sum of stake × odds for each.'}>
                  <Info className="h-4 w-4 text-sb-accent" />
                </span>
              </span>
              <span className="font-semibold sb-tabular">{money(possibleWin, currency)}</span>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2">
              {QUICK.map((v) => (
                <button key={v} type="button" onClick={() => addQuick(v)}
                  className={`h-10 rounded-md border text-[15px] sb-tabular ${lastPick === v ? 'border-sb-primary bg-sb-primary text-white' : 'border-sb-line bg-sb-surface2/60 text-sb-text hover:border-sb-primary'}`}>
                  +{v}
                </button>
              ))}
            </div>

            <label htmlFor="sb-stake" className="mt-4 block text-[16px] font-medium">{multi ? 'Your Stake' : 'Stake per bet'}</label>
            <div className="mt-1.5 flex h-11 items-center rounded-md border border-sb-line bg-sb-surface2/60 focus-within:ring-2 focus-within:ring-sb-primary/40">
              <span className="pl-3 text-[15px] text-sb-muted">{currency}</span>
              <input id="sb-stake" type="number" inputMode="decimal" min="1" step="any" value={slip.stake}
                onChange={(e) => { slip.setStake(e.target.value); setLastPick(null); }}
                className="h-full min-w-0 flex-1 bg-transparent px-2 text-[16px] outline-none sb-tabular" />
            </div>

            {error && (
              <div className="mt-3">
                <ErrorNote>{error.text}</ErrorNote>
                {error.deposit && <Button size="sm" variant="outline" className="mt-2" onClick={() => openModal('deposit')}>Deposit</Button>}
              </div>
            )}

            <Button size="lg" busy={busy} onClick={place} className="mt-4 w-full !text-[19px]">
              {token ? `Place Bet (${money(totalStake, currency)})` : 'Log in to Place Bet'}
            </Button>
          </div>
        </>
      )}

      {result && (
        <ResultModal result={result} currency={currency} onClose={() => setResult(null)}
          onRebet={() => { result.legs.forEach((l) => slip.toggle(l)); setResult(null); }} />
      )}
    </div>
  );
}

function ResultModal({ result, currency, onClose, onRebet }: {
  result: { bets: SimBetView[]; legs: SlipLeg[] }; currency: string; onClose: () => void; onRebet: () => void;
}) {
  const won = result.bets.filter((b) => b.won);
  const paid = won.reduce((a, b) => a + b.payoutMinor, 0);
  return (
    <Modal onClose={onClose} width="max-w-[800px]" labelledBy="sb-result-title">
      <div className="mb-6 text-center">
        <span className={`mx-auto grid h-16 w-16 place-items-center rounded-full ${won.length ? 'bg-sb-success/15 text-sb-success' : 'bg-sb-primary/10 text-sb-accent'}`}>
          {won.length ? <Check className="h-8 w-8" strokeWidth={2.5} /> : <Ball className="h-8 w-8" />}
        </span>
        <h2 id="sb-result-title" className="mt-3 font-sb-display text-[30px]">
          {won.length === 0 ? 'Not this time'
            : won.length === result.bets.length ? `You won ${money(paid, currency)}!`
            : `${won.length} of ${result.bets.length} won · ${money(paid, currency)} returned`}
        </h2>
        <p className="mt-1 text-[15px] text-sb-muted">
          {result.bets.length === 1 ? 'Your bet has been placed and played out.'
            : `${result.bets.length} bets placed · ${money(result.bets.reduce((a, b) => a + b.stakeMinor, 0), currency)} staked`}
        </p>
      </div>
      <div className="flex flex-col gap-6">
        {result.bets.map((b) => (
          <section key={b.betId} aria-label={`Bet ${b.betId}`}>
            <p className="mb-2 text-[14px] font-semibold">{b.betId}</p>
            <BetDetailsBody bet={b} currency={currency} />
          </section>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button variant="outline" onClick={() => { onClose(); navigate('/account/bets'); }}>Go to Bet History</Button>
        <Button onClick={onRebet}>Bet again</Button>
      </div>
    </Modal>
  );
}

/**
 * Where the slip lives when it isn't a column: a bar above the bottom nav on
 * phones, and a floating button + drawer on desktop pages other than Matches.
 */
export function SlipDock() {
  const slip = useSlip();
  const { path } = useLocation();
  const onMatches = path === '/matches';
  const n = slip.legs.length;
  if (n === 0 && !slip.open) return null;
  return (
    <>
      {n > 0 && !slip.open && (
        <button type="button" onClick={() => slip.setOpen(true)}
          className={`sb-rise fixed bottom-[calc(env(safe-area-inset-bottom)+76px)] right-4 z-30 flex items-center gap-2 rounded-full bg-sb-primary py-2.5 pl-4 pr-3 font-sb-display text-[18px] text-white shadow-lg lg:bottom-6 ${onMatches ? 'lg:hidden' : ''}`}>
          Betslip <span className="grid h-7 min-w-7 place-items-center rounded-full bg-white px-1.5 font-sb-body text-[14px] font-semibold text-sb-primary">{n}</span>
        </button>
      )}
      {slip.open && (
        <div className="sb-fade fixed inset-0 z-50 flex justify-end bg-slate-900/30 dark:bg-black/60" onMouseDown={(e) => { if (e.target === e.currentTarget) slip.setOpen(false); }}>
          <div className="sb-scroll flex h-full w-full max-w-[400px] flex-col overflow-y-auto bg-sb-bg p-3" role="dialog" aria-modal="true" aria-label="Betslip">
            <button type="button" onClick={() => slip.setOpen(false)} className="mb-2 ml-auto grid h-10 w-10 place-items-center rounded-full hover:bg-sb-surface2" aria-label="Close betslip">
              <Close className="h-5 w-5" />
            </button>
            <Betslip />
          </div>
        </div>
      )}
    </>
  );
}
