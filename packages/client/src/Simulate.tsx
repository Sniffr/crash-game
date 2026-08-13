import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LegResult } from '@crash/shared/simulate';
import {
  AppBar, ArrowLeftIcon, Button, ChevronDownIcon, Eyebrow, Modal, Panel,
  Readout, Spinner, TextInput, Wordmark, XIcon,
} from './components/ui';

/**
 * Simulate — a casino-style sports game.
 *
 * Players build a bet slip from REAL harvested fixtures (today / tomorrow / this
 * week) and *simulate* the outcome. A provably-fair RNG at a configured RTP
 * decides win/loss — not the real match — so it plays like a casino game while
 * the fixtures and odds stay real. Play-money only.
 *
 * Laid out as a betting terminal: fixtures are one dense divided list (grouped
 * by league), and the slip is a sticky instrument whose focal readout is
 * the potential payout — the number the player is actually here for. On phones
 * the slip collapses to a bottom bar that opens as a sheet, so the fixture list
 * keeps the full screen while you build.
 */

// ─── Types (mirror the /api/simulate responses) ─────────────────────────────
type WindowKey = 'today' | 'tomorrow' | 'week' | 'all';

interface Option {
  /** Outcome token within the market, e.g. 'home', 'over', '3_2'. */
  pick: string;
  /** Button label, e.g. '1', 'Over 2.5', '3-2'. */
  label: string;
  odds: number;
}
interface MarketBlock {
  market: string;
  name: string;
  options: Option[];
}
interface Fixture {
  eventId: string;
  league: string;
  home: string;
  away: string;
  kickoff: string;
  window: 'today' | 'tomorrow' | 'week' | 'later';
  markets: MarketBlock[];
}
interface SlipLeg {
  eventId: string;
  home: string;
  away: string;
  market: string;
  /** Market display name, for the slip line. */
  marketName: string;
  pick: string;
  label: string;
  odds: number;
}
/** A settled leg as /play returns it: the shared result minus the draw
 *  internals the endpoint withholds, plus the team names it adds for display. */
type ResultLeg = Omit<LegResult, 'u' | 'winProbability'> & { home?: string; away?: string };
interface PlayResult {
  won: boolean;
  stake: number;
  combinedOdds: number;
  payout: number;
  profit: number;
  balance: number;
  legs: ResultLeg[];
  fair: { serverSeed: string; commit: string; nonce: string; rtp: number };
}

/** The market shown up-front on each fixture; the rest sit behind "More". */
const PRIMARY_MARKET = '1x2';

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'week', label: 'This week' },
  { key: 'all', label: 'All' },
];

const STAKE_STEPS = [10, 50, 100, 500];

/** Time only — paired with fmtDay on the row, since groups are leagues. */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** "Today" / "Tomorrow" / "Sat 14 Sep" — the day shown on each fixture row. */
function fmtDay(iso: string): string {
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (sameDay(d, today)) return 'Today';
    if (sameDay(d, tomorrow)) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return 'Upcoming';
  }
}

function fmtCredits(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function Simulate() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [maxStake, setMaxStake] = useState<number>(1000);

  const [win, setWin] = useState<WindowKey>('all');
  const [fixtures, setFixtures] = useState<Fixture[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [slip, setSlip] = useState<SlipLeg[]>([]);
  const [stake, setStake] = useState<string>('10');
  const [result, setResult] = useState<PlayResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [showFair, setShowFair] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // ─── Bootstrap: session + config ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, c] = await Promise.all([
          fetch('/api/simulate/session', { method: 'POST' }).then((r) => r.json()),
          fetch('/api/simulate/config').then((r) => r.json()),
        ]);
        if (cancelled) return;
        setSessionId(s.sessionId);
        setBalance(s.balance);
        if (typeof c.maxStake === 'number') setMaxStake(c.maxStake);
      } catch {
        if (!cancelled) setLoadError('Could not start a Simulate session — is the server running?');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Fixtures for the active window ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setFixtures(null);
    fetch(`/api/simulate/fixtures?window=${win}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (!cancelled) setFixtures(Array.isArray(j.fixtures) ? j.fixtures : []); })
      .catch(() => { if (!cancelled) { setFixtures([]); setLoadError('Could not load fixtures.'); } });
    return () => { cancelled = true; };
  }, [win]);

  // eventId -> "market:pick" of the current selection, so a fixture's buttons
  // can highlight the exact outcome chosen across any market.
  const slipIds = useMemo(
    () => new Map(slip.map((l) => [l.eventId, `${l.market}:${l.pick}`])),
    [slip],
  );

  const toggle = useCallback((fx: Fixture, block: MarketBlock, opt: Option) => {
    setResult(null);
    setPlayError(null);
    setSlip((prev) => {
      const existing = prev.find((l) => l.eventId === fx.eventId);
      // Tapping the same outcome again clears it.
      if (existing && existing.market === block.market && existing.pick === opt.pick) {
        return prev.filter((l) => l.eventId !== fx.eventId);
      }
      // Still one pick per fixture — the engine rejects duplicate events, and
      // two markets on one match could demand contradictory scorelines.
      const without = prev.filter((l) => l.eventId !== fx.eventId);
      return [...without, {
        eventId: fx.eventId,
        home: fx.home,
        away: fx.away,
        market: block.market,
        marketName: block.name,
        pick: opt.pick,
        label: opt.label,
        odds: opt.odds,
      }];
    });
  }, []);

  const removeLeg = (eventId: string) => setSlip((p) => p.filter((l) => l.eventId !== eventId));
  const clearSlip = () => { setSlip([]); setResult(null); setPlayError(null); };

  const combined = useMemo(() => slip.reduce((a, l) => a * l.odds, 1), [slip]);
  const stakeNum = Number(stake);
  const stakeValid = Number.isFinite(stakeNum) && stakeNum > 0;
  const potential = stakeValid ? stakeNum * combined : 0;

  const play = async () => {
    if (!sessionId || slip.length === 0) return;
    if (!stakeValid) { setPlayError('Enter a stake greater than zero.'); return; }
    setPlaying(true); setPlayError(null); setResult(null);
    try {
      const res = await fetch('/api/simulate/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, stake: stakeNum, selections: slip.map((l) => ({ eventId: l.eventId, market: l.market, pick: l.pick })) }),
      });
      const j = await res.json();
      if (!res.ok) { setPlayError(j?.error?.message ?? 'Could not simulate the slip.'); setPlaying(false); return; }
      setResult(j);
      setBalance(j.balance);
    } catch {
      setPlayError('Network error — please try again.');
    }
    setPlaying(false);
  };

  // Fixtures arrive flat and kickoff-ordered. Group by league — the way a
  // sportsbook reads — rather than by day: the window tabs already scope the
  // time range, so league is the axis left worth scanning. A Map (not the
  // run-length trick a sorted key allows) because leagues interleave in
  // kickoff order; insertion order then puts the soonest league first, and
  // each row carries its own day since a league can span the window.
  const groups = useMemo(() => {
    if (!fixtures) return null;
    const byLeague = new Map<string, Fixture[]>();
    for (const fx of fixtures) {
      const items = byLeague.get(fx.league);
      if (items) items.push(fx);
      else byLeague.set(fx.league, [fx]);
    }
    return [...byLeague].map(([league, items]) => ({ league, items }));
  }, [fixtures]);

  const slipPanel = (
    <SlipPanel
      slip={slip}
      stake={stake}
      onStake={setStake}
      maxStake={maxStake}
      combined={combined}
      potential={potential}
      playing={playing}
      playError={playError}
      disabled={!sessionId}
      onRemove={removeLeg}
      onClear={clearSlip}
      onPlay={play}
    />
  );

  return (
    <div className="min-h-screen bg-space-950 text-neutral-100">
      <AppBar
        left={
          <>
            <a
              href="/"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-btn text-neutral-500 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-neutral-100"
              aria-label="Back to lobby"
            >
              <ArrowLeftIcon className="h-4 w-4" />
            </a>
            <Wordmark caption="Simulate · real odds" />
          </>
        }
        right={<Readout label="Play balance" value={balance == null ? '—' : `${fmtCredits(balance)} cr`} />}
      />

      <main className="mx-auto grid max-w-[1080px] gap-6 px-4 pb-28 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:pb-16">
        {/* ─── Fixtures ─────────────────────────────────────────────────── */}
        <section className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <WindowTabs value={win} onChange={setWin} />
            {fixtures && fixtures.length > 0 && (
              <span className="text-[11px] tabular-nums text-neutral-600">{fixtures.length} matches</span>
            )}
          </div>

          {loadError && (
            <div className="mb-4 rounded-card border border-loss-500/30 bg-loss-500/10 px-4 py-3 text-[13px] text-loss-400">
              {loadError}
            </div>
          )}

          {groups == null ? (
            <FixtureSkeleton />
          ) : groups.length === 0 ? (
            <Panel className="px-6 py-16 text-center">
              <h3 className="text-[15px] font-semibold text-neutral-200">No fixtures in this window</h3>
              <p className="mx-auto mt-1.5 max-w-xs text-[13px] text-neutral-500">
                Try another window, or wait for the next odds harvest to land.
              </p>
              {win !== 'all' && (
                <Button variant="secondary" className="mt-5" onClick={() => setWin('all')}>Show all fixtures</Button>
              )}
            </Panel>
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <div key={group.league}>
                  <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
                    <Eyebrow className="min-w-0 truncate">{group.league}</Eyebrow>
                    <span className="shrink-0 text-[11px] tabular-nums text-neutral-600">{group.items.length}</span>
                  </div>
                  <Panel className="overflow-hidden">
                    <ul className="divide-y divide-white/[0.05]">
                      {group.items.map((fx) => (
                        <FixtureRow
                          key={fx.eventId}
                          fx={fx}
                          selectedKey={slipIds.get(fx.eventId) ?? null}
                          onToggle={toggle}
                        />
                      ))}
                    </ul>
                  </Panel>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ─── Slip (desktop) ───────────────────────────────────────────── */}
        <aside className="hidden self-start lg:sticky lg:top-[72px] lg:block">
          {result ? (
            <ResultTicket
              result={result}
              showFair={showFair}
              onToggleFair={() => setShowFair((s) => !s)}
              onAgain={() => { setResult(null); setPlayError(null); }}
              onClear={clearSlip}
            />
          ) : (
            slipPanel
          )}
        </aside>
      </main>

      {/* ─── Slip (phone): a bar you can always see, a sheet when you need it ── */}
      {(slip.length > 0 || result) && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-edge bg-space-900/95 px-4 py-3 backdrop-blur-xl lg:hidden">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex w-full items-center gap-3 text-left"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-btn bg-white/[0.06] text-[13px] font-semibold tabular-nums text-neutral-100">
              {result ? result.legs.length : slip.length}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-neutral-500">
                {result ? (result.won ? 'You won' : 'No win') : `Combined ${combined.toFixed(2)}×`}
              </span>
              <span className={`block truncate text-[15px] font-semibold tabular-nums ${result ? (result.won ? 'text-bet-400' : 'text-loss-400') : 'text-neutral-100'}`}>
                {result
                  ? `${result.won ? '+' : '−'}${fmtCredits(result.won ? result.payout : result.stake)} cr`
                  : `${fmtCredits(potential)} cr`}
              </span>
            </span>
            <span className="shrink-0 rounded-btn bg-brand-500 px-4 py-2.5 text-[13px] font-semibold text-black">
              {result ? 'View' : 'Open slip'}
            </span>
          </button>
        </div>
      )}

      {sheetOpen && (
        <Modal title={result ? 'Result' : 'Bet slip'} onClose={() => setSheetOpen(false)} width="max-w-md" padded={false}>
          {result ? (
            <ResultTicket
              result={result}
              showFair={showFair}
              onToggleFair={() => setShowFair((s) => !s)}
              onAgain={() => { setResult(null); setPlayError(null); }}
              onClear={() => { clearSlip(); setSheetOpen(false); }}
              bare
            />
          ) : (
            <SlipPanel
              slip={slip}
              stake={stake}
              onStake={setStake}
              maxStake={maxStake}
              combined={combined}
              potential={potential}
              playing={playing}
              playError={playError}
              disabled={!sessionId}
              onRemove={removeLeg}
              onClear={() => { clearSlip(); setSheetOpen(false); }}
              onPlay={play}
              bare
            />
          )}
        </Modal>
      )}

      <footer className="border-t border-edge-soft">
        <div className="mx-auto max-w-[1080px] px-4 py-5 text-[11px] text-neutral-600 sm:px-6">
          Game Hub · real odds, provably fair · let's roll, win big.
        </div>
      </footer>
    </div>
  );
}

// ─── Window tabs ─────────────────────────────────────────────────────────────
// A segmented control, not four competing buttons: one track, and the active
// segment is the only thing that carries a surface.

function WindowTabs({ value, onChange }: { value: WindowKey; onChange: (k: WindowKey) => void }) {
  return (
    <div className="inline-flex rounded-btn border border-edge bg-space-950 p-1" role="tablist">
      {WINDOWS.map((w) => {
        const active = value === w.key;
        return (
          <button
            key={w.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(w.key)}
            className={`h-10 min-w-[44px] rounded-chip px-3 text-[12px] font-semibold transition-[background-color,color] duration-150 ease-snap ${
              active ? 'bg-white/[0.10] text-neutral-100' : 'text-neutral-500 hover:text-neutral-200'
            }`}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Fixture row ─────────────────────────────────────────────────────────────

function OddsButton({ o, active, onClick }: { o: Option; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-11 flex-col items-center justify-center rounded-btn border px-1 transition-[background-color,border-color,color,transform] duration-150 ease-snap active:scale-[0.97] ${
        active
          ? 'border-brand-500 bg-brand-500 text-black'
          : 'border-edge bg-space-950 text-neutral-200 hover:border-edge-strong hover:bg-white/[0.04]'
      }`}
    >
      <span className={`w-full truncate text-center text-[10px] font-medium leading-none ${active ? 'text-black/60' : 'text-neutral-500'}`}>
        {o.label}
      </span>
      <span className="mt-1 text-[13px] font-semibold leading-none tabular-nums">{o.odds.toFixed(2)}</span>
    </button>
  );
}

function FixtureRow({ fx, selectedKey, onToggle }: {
  fx: Fixture;
  /** "market:pick" currently selected on this fixture, if any. */
  selectedKey: string | null;
  onToggle: (fx: Fixture, block: MarketBlock, o: Option) => void;
}) {
  const [open, setOpen] = useState(false);
  // /fixtures carries 1x2 only — pricing the rest costs a fit per fixture, so
  // they load on demand and stay cached on the row for the session.
  const [extras, setExtras] = useState<MarketBlock[] | null>(null);
  const [loadingExtras, setLoadingExtras] = useState(false);
  const [extrasError, setExtrasError] = useState(false);
  const primary = fx.markets.find((m) => m.market === PRIMARY_MARKET);
  // Keep the extra markets visible if the current pick lives in one of them,
  // otherwise selecting "Over 2.5" then collapsing would hide the highlight.
  const pickedInExtras = selectedKey != null && !selectedKey.startsWith(`${PRIMARY_MARKET}:`);
  const showExtras = open || pickedInExtras;
  const picked = selectedKey != null;

  // Loads once; a failure leaves `extras` null and parks on `extrasError`, so
  // tapping the expander (which clears the flag) retries.
  useEffect(() => {
    if (!showExtras || extras || extrasError) return;
    let cancelled = false;
    setLoadingExtras(true);
    setExtrasError(false);
    fetch(`/api/simulate/fixtures/${encodeURIComponent(fx.eventId)}/markets`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (!cancelled) {
          setExtras(Array.isArray(j.markets)
            ? (j.markets as MarketBlock[]).filter((m) => m.market !== PRIMARY_MARKET)
            : []);
        }
      })
      .catch(() => { if (!cancelled) setExtrasError(true); })
      // Unconditional: collapsing mid-flight sets cancelled, and the effect
      // won't run again to clear a spinner left stuck under the chevron.
      .finally(() => setLoadingExtras(false));
    return () => { cancelled = true; };
  }, [showExtras, extras, extrasError, fx.eventId]);

  return (
    <li className={`px-3 py-3 transition-colors duration-150 ease-snap sm:px-4 ${picked ? 'bg-brand-500/[0.05]' : ''}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
            {/* League is the section header now, so the row carries the day. */}
            <span className="truncate">{fmtDay(fx.kickoff)}</span>
            <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-white/25" aria-hidden />
            <span className="shrink-0 tabular-nums">{fmtTime(fx.kickoff)}</span>
          </div>
          <div className="mt-1 truncate text-[13px] font-semibold text-neutral-100">
            {fx.home} <span className="font-normal text-neutral-600">v</span> {fx.away}
          </div>
        </div>

        {primary && (
          // The market expander rides alongside the odds rather than sitting on
          // its own line under every row: it reclaims ~26px of height on each of
          // 265 rows, and turns a 96×17 text link into a 44×44 target.
          <div className="flex w-full shrink-0 items-stretch gap-1.5 sm:w-[252px]">
            <div className="grid flex-1 grid-cols-3 gap-1.5">
              {primary.options.map((o) => (
                <OddsButton
                  key={o.pick}
                  o={o}
                  active={selectedKey === `${primary.market}:${o.pick}`}
                  onClick={() => onToggle(fx, primary, o)}
                />
              ))}
            </div>
            {/* Always rendered: a row pinned open by its own pick still needs a
                control to retry a failed load, or the pick's odds button never
                appears and the row is stuck.
                ponytail: while pinned open the tap only retries, it can't
                collapse — track an explicit user-collapse flag if that matters. */}
            <button
              type="button"
              onClick={() => { setOpen((v) => !v); setExtrasError(false); }}
              aria-expanded={showExtras}
              aria-label={showExtras ? 'Fewer markets' : extras ? `${extras.length} more markets` : 'More markets'}
              className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-btn border border-edge bg-space-950 text-neutral-500 transition-[background-color,border-color,color,transform] duration-150 ease-snap hover:border-edge-strong hover:bg-white/[0.04] hover:text-neutral-200 active:scale-[0.97]"
            >
              <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform duration-150 ease-snap ${showExtras ? 'rotate-180' : ''}`} />
              {loadingExtras
                ? <Spinner className="h-3 w-3" />
                : <span className="text-[10px] font-semibold leading-none tabular-nums">{extras ? extras.length : '+'}</span>}
            </button>
          </div>
        )}
      </div>

      {showExtras && (extras || extrasError) && (
        <div className="mt-3 flex flex-col gap-3 border-t border-edge-soft pt-3">
          {extrasError && (
            <p className="text-[11px] text-loss-400">Could not load more markets — tap the chevron to retry.</p>
          )}
          {extras?.map((block) => (
            <div key={block.market}>
              <div className="mb-1.5 text-[11px] font-medium text-neutral-500">{block.name}</div>
              <div className={`grid gap-1.5 ${block.options.length > 6 ? 'grid-cols-5' : block.options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {block.options.map((o) => (
                  <OddsButton
                    key={o.pick}
                    o={o}
                    active={selectedKey === `${block.market}:${o.pick}`}
                    onClick={() => onToggle(fx, block, o)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// ─── Bet slip ────────────────────────────────────────────────────────────────
// The focal element of this page is the potential payout: it is the largest,
// heaviest, only tier-coloured number in the panel. Everything above it —
// legs, combined odds, stake — is deliberately 11–13px supporting detail.

function SlipPanel({
  slip, stake, onStake, maxStake, combined, potential, playing, playError, disabled,
  onRemove, onClear, onPlay, bare = false,
}: {
  slip: SlipLeg[];
  stake: string;
  onStake: (v: string) => void;
  maxStake: number;
  combined: number;
  potential: number;
  playing: boolean;
  playError: string | null;
  disabled: boolean;
  onRemove: (eventId: string) => void;
  onClear: () => void;
  onPlay: () => void;
  /** Rendered inside a sheet, which already supplies the frame and title. */
  bare?: boolean;
}) {
  const body = (
    <>
      {!bare && (
        <div className="flex items-center justify-between gap-3 border-b border-edge-soft px-4 py-3">
          <h2 className="text-[13px] font-semibold text-neutral-100">
            Bet slip <span className="ml-1 font-normal tabular-nums text-neutral-600">{slip.length}</span>
          </h2>
          {slip.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] font-semibold text-neutral-500 transition-colors duration-150 ease-snap hover:text-loss-400"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {slip.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-[13px] font-medium text-neutral-300">Your slip is empty</p>
          <p className="mt-1 text-[12px] text-neutral-600">Tap any odds to add a selection.</p>
        </div>
      ) : (
        <>
          <ul className={`divide-y divide-white/[0.05] ${bare ? '' : 'max-h-[38vh] overflow-y-auto'}`}>
            {slip.map((l) => (
              <li key={l.eventId} className="flex items-start gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-neutral-100">{l.home} v {l.away}</div>
                  <div className="mt-0.5 truncate text-[11px] text-neutral-500">
                    {l.marketName} · <span className="font-semibold text-brand-400">{l.label}</span>
                  </div>
                </div>
                <span className="shrink-0 pt-0.5 text-[13px] font-semibold tabular-nums text-neutral-300">
                  {l.odds.toFixed(2)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(l.eventId)}
                  aria-label={`Remove ${l.home} v ${l.away}`}
                  className="-mr-1.5 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-btn text-neutral-600 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-loss-400"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t border-edge-soft px-4 py-4">
            <TextInput
              label="Stake"
              hint={`max ${fmtCredits(maxStake)} cr`}
              type="number"
              min="1"
              step="any"
              inputMode="decimal"
              value={stake}
              onChange={(e) => onStake(e.target.value)}
              className="tabular-nums"
            />
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {STAKE_STEPS.map((v) => (
                <Button key={v} size="sm" onClick={() => onStake(String(v))} className="tabular-nums">
                  {v}
                </Button>
              ))}
            </div>

            <div className="mt-4 flex items-end justify-between gap-3">
              <div className="min-w-0">
                <Eyebrow>To return</Eyebrow>
                <div className="mt-1 text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-brand-400">
                  {fmtCredits(potential)}
                  <span className="ml-1 text-[13px] font-semibold text-neutral-600">cr</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-600">Combined</div>
                <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-neutral-200">{combined.toFixed(2)}×</div>
              </div>
            </div>

            {playError && <p role="alert" className="mt-3 text-[12px] text-loss-400">{playError}</p>}

            <Button
              variant="primary"
              size="lg"
              onClick={onPlay}
              disabled={playing || disabled}
              className="mt-4 w-full"
            >
              {playing ? <><Spinner /> Simulating…</> : `Simulate ${slip.length} ${slip.length === 1 ? 'pick' : 'picks'}`}
            </Button>
          </div>
        </>
      )}
    </>
  );

  if (bare) return <>{body}</>;
  return <Panel className="overflow-hidden">{body}</Panel>;
}

// ─── Result ──────────────────────────────────────────────────────────────────

function ResultTicket({
  result, showFair, onToggleFair, onAgain, onClear, bare = false,
}: {
  result: PlayResult;
  showFair: boolean;
  onToggleFair: () => void;
  onAgain: () => void;
  onClear: () => void;
  bare?: boolean;
}) {
  const won = result.won;
  const body = (
    <>
      <div className={`px-4 py-5 ${won ? 'bg-bet-500/[0.07]' : 'bg-loss-500/[0.06]'}`}>
        <Eyebrow>{won ? 'Slip won' : 'Slip lost'}</Eyebrow>
        <div className={`mt-1 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums ${won ? 'text-bet-400' : 'text-loss-400'}`}>
          {won ? '+' : '−'}{fmtCredits(won ? result.payout : result.stake)}
          <span className="ml-1 text-[13px] font-semibold text-neutral-600">cr</span>
        </div>
        <div className="mt-2 text-[11px] text-neutral-500">
          {fmtCredits(result.stake)} cr at {result.combinedOdds.toFixed(2)}× · balance {fmtCredits(result.balance)} cr
        </div>
      </div>

      <ul className="divide-y divide-white/[0.05] border-t border-edge-soft">
        {result.legs.map((l, i) => <LegPlaythrough key={`${l.eventId}-${i}`} leg={l} index={i} />)}
      </ul>

      <div className="border-t border-edge-soft px-4 py-4">
        <div className="flex gap-2">
          <Button variant="primary" size="lg" onClick={onAgain} className="flex-1">Same slip again</Button>
          <Button variant="secondary" size="lg" onClick={onClear}>New slip</Button>
        </div>
        <button
          type="button"
          onClick={onToggleFair}
          className="mt-3 text-[11px] font-semibold text-neutral-500 transition-colors duration-150 ease-snap hover:text-neutral-200"
        >
          {showFair ? 'Hide' : 'Show'} provably-fair proof
        </button>
        {showFair && (
          <div className="mt-2 space-y-1 break-all rounded-btn border border-edge bg-space-950 p-3 text-[10px] leading-relaxed text-neutral-400">
            <div><span className="text-neutral-600">commit </span>{result.fair.commit}</div>
            <div><span className="text-neutral-600">seed </span>{result.fair.serverSeed}</div>
            <div><span className="text-neutral-600">nonce </span>{result.fair.nonce}</div>
            <div className="pt-1 text-neutral-600">
              Recompute with HMAC-SHA256(seed, `{'{'}nonce{'}'}:{'{'}i{'}'}:{'{'}eventId{'}'}:{'{'}pick{'}'}`) — each leg wins iff
              u &lt; {result.fair.rtp.toFixed(2)}^(1/legs)/odds.
            </div>
          </div>
        )}
      </div>
    </>
  );

  if (bare) return <>{body}</>;
  return <Panel className="animate-rise overflow-hidden">{body}</Panel>;
}

/**
 * One leg of the slip, shown as the simulated match behind it.
 *
 * The scoreline is drawn to agree with the leg's result, so the goals listed
 * here always explain the won/lost badge — a leg backing "Over 2.5" that won
 * will show 3+ goals.
 */
function LegPlaythrough({ leg, index }: { leg: ResultLeg; index: number }) {
  const [open, setOpen] = useState(false);
  const hasPlay = !!leg.score;
  const teams = leg.home && leg.away ? { home: leg.home, away: leg.away } : null;

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${leg.won ? 'bg-bet-400' : 'bg-loss-500'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-neutral-200">
            {teams ? `${teams.home} v ${teams.away}` : `Leg ${index + 1}`}
          </div>
          <div className="truncate text-[11px] text-neutral-600">
            {leg.pick.replace(/_/g, ' ')} at {leg.odds.toFixed(2)}
          </div>
        </div>
        {leg.score && (
          <span className="shrink-0 text-[15px] font-semibold tabular-nums text-neutral-100">
            {leg.score.home}<span className="mx-0.5 text-neutral-700">:</span>{leg.score.away}
          </span>
        )}
        {/* The dot alone would carry this in colour only. */}
        <span className={`w-8 shrink-0 text-right text-[11px] font-medium ${leg.won ? 'text-bet-400' : 'text-loss-400'}`}>
          {leg.won ? 'won' : 'lost'}
        </span>
      </div>

      {hasPlay && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 text-[11px] text-neutral-600 transition-colors duration-150 ease-snap hover:text-neutral-300"
          >
            {open ? 'Hide' : 'Show'} how it played
          </button>
          {open && (
            <div className="mt-2 border-t border-edge-soft pt-2">
              {leg.timeline && leg.timeline.length > 0 ? (
                <ol className="space-y-1">
                  {leg.timeline.map((g, i) => (
                    <li key={i} className="flex items-center gap-2 text-[11px]">
                      <span className="w-7 shrink-0 tabular-nums text-neutral-600">{g.minute}'</span>
                      <span className="truncate text-neutral-300">
                        {g.team === 'home' ? (teams?.home ?? 'Home') : (teams?.away ?? 'Away')}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums font-medium text-neutral-500">
                        {g.score.home}-{g.score.away}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[11px] text-neutral-600">No goals — it finished goalless.</p>
              )}
              {leg.halfTimeScore && (
                <p className="mt-1.5 text-[11px] tabular-nums text-neutral-600">
                  Half time {leg.halfTimeScore.home}-{leg.halfTimeScore.away}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

// ─── Loading state ───────────────────────────────────────────────────────────

function FixtureSkeleton() {
  return (
    <Panel className="overflow-hidden">
      <ul className="divide-y divide-white/[0.05]">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="h-2.5 w-28 animate-pulse rounded bg-white/[0.05]" />
              <div className="mt-2 h-3 w-48 max-w-full animate-pulse rounded bg-white/[0.07]" />
            </div>
            <div className="flex w-full shrink-0 items-stretch gap-1.5 sm:w-[252px]">
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                {Array.from({ length: 3 }).map((__, j) => (
                  <div key={j} className="h-11 animate-pulse rounded-btn bg-white/[0.05]" />
                ))}
              </div>
              <div className="h-11 w-11 shrink-0 animate-pulse rounded-btn bg-white/[0.05]" />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
