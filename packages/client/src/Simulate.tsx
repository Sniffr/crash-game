import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Simulate — a casino-style sports game.
 *
 * Players build a bet slip from REAL harvested fixtures (today / tomorrow / this
 * week) and *simulate* the outcome. A provably-fair RNG at a configured RTP
 * decides win/loss — not the real match — so it plays like a casino game while
 * the fixtures and odds stay real. Play-money only.
 */

// ─── Types (mirror the /api/simulate responses) ─────────────────────────────
type Pick = 'home' | 'draw' | 'away';
type WindowKey = 'today' | 'tomorrow' | 'week' | 'all';

interface Option {
  pick: Pick;
  label: string; // '1' | 'X' | '2'
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
  pick: Pick;
  label: string;
  odds: number;
}
interface PlayResult {
  won: boolean;
  stake: number;
  combinedOdds: number;
  payout: number;
  profit: number;
  balance: number;
  legs: { eventId: string; pick: Pick; odds: number; won: boolean }[];
  fair: { serverSeed: string; commit: string; nonce: string; rtp: number };
}

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'week', label: 'This week' },
  { key: 'all', label: 'All' },
];

function fmtKickoff(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function Simulate() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [rtp, setRtp] = useState<number>(0.95);
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
        if (typeof c.rtp === 'number') setRtp(c.rtp);
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

  const slipIds = useMemo(() => new Map(slip.map((l) => [l.eventId, l.pick])), [slip]);

  const toggle = useCallback((fx: Fixture, opt: Option) => {
    setResult(null);
    setPlayError(null);
    setSlip((prev) => {
      const existing = prev.find((l) => l.eventId === fx.eventId);
      if (existing && existing.pick === opt.pick) return prev.filter((l) => l.eventId !== fx.eventId); // unselect
      const without = prev.filter((l) => l.eventId !== fx.eventId); // one pick per event
      return [...without, { eventId: fx.eventId, home: fx.home, away: fx.away, pick: opt.pick, label: opt.label, odds: opt.odds }];
    });
  }, []);

  const removeLeg = (eventId: string) => setSlip((p) => p.filter((l) => l.eventId !== eventId));
  const clearSlip = () => { setSlip([]); setResult(null); setPlayError(null); };

  const combined = useMemo(() => slip.reduce((a, l) => a * l.odds, 1), [slip]);
  const stakeNum = Number(stake);
  const potential = Number.isFinite(stakeNum) && stakeNum > 0 ? stakeNum * combined : 0;

  const play = async () => {
    if (!sessionId || slip.length === 0) return;
    if (!Number.isFinite(stakeNum) || stakeNum <= 0) { setPlayError('Enter a stake greater than zero.'); return; }
    setPlaying(true); setPlayError(null); setResult(null);
    try {
      const res = await fetch('/api/simulate/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, stake: stakeNum, selections: slip.map((l) => ({ eventId: l.eventId, market: '1x2', pick: l.pick })) }),
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

  return (
    <div className="min-h-screen text-neutral-100 relative overflow-x-hidden">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 -left-32 w-[38rem] h-[38rem] rounded-full bg-brand-500/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 w-[34rem] h-[34rem] rounded-full bg-bet-400/10 blur-[130px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-20 flex items-center justify-between px-4 sm:px-6 h-16 border-b border-white/5 bg-space-950/60 backdrop-blur-xl">
        <div className="flex items-center gap-3 min-w-0">
          <a href="/" className="text-neutral-400 hover:text-white transition text-sm font-bold">← Lobby</a>
          <div className="flex flex-col leading-none">
            <h1 className="font-display font-extrabold text-lg tracking-tight">
              <span className="text-brand-500">Simulate</span><span className="ml-1 text-white">Bets</span>
            </h1>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 mt-1">
              Real odds · simulated outcomes · {Math.round(rtp * 100)}% RTP
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 bg-space-900/70 border border-white/5 rounded-control px-3 py-1.5">
          <div className="leading-tight text-right">
            <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-neutral-500">Play balance</div>
            <div className="text-base sm:text-lg font-bold text-bet-400 tabular-nums">
              {balance == null ? '—' : `${balance.toLocaleString()} cr`}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 grid lg:grid-cols-[1fr_360px] gap-6">
        {/* Fixtures column */}
        <section>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => setWin(w.key)}
                className={`px-4 py-2 rounded-control text-xs font-bold uppercase tracking-wide transition border ${
                  win === w.key ? 'bg-brand-500 text-space-950 border-brand-500' : 'bg-space-900/70 text-neutral-300 border-white/10 hover:text-white'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          {loadError && (
            <div className="mb-4 text-xs text-loss-500 bg-loss-500/10 border border-loss-500/30 rounded-control px-4 py-3">{loadError}</div>
          )}

          {fixtures == null ? (
            <FixtureSkeleton />
          ) : fixtures.length === 0 ? (
            <div className="rounded-panel border border-dashed border-white/10 bg-space-800/50 px-6 py-16 text-center">
              <h3 className="font-display font-extrabold text-lg text-neutral-200">No fixtures in this window</h3>
              <p className="text-sm text-neutral-500 mt-1">Try another window, or wait for the next odds harvest.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {fixtures.map((fx) => (
                <FixtureRow key={fx.eventId} fx={fx} selectedPick={slipIds.get(fx.eventId) ?? null} onToggle={toggle} />
              ))}
            </div>
          )}
        </section>

        {/* Bet slip column */}
        <aside className="lg:sticky lg:top-20 self-start">
          <div className="rounded-panel border border-white/10 bg-space-800/70 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <h2 className="font-display font-extrabold tracking-tight">Bet slip <span className="text-neutral-500 text-sm">({slip.length})</span></h2>
              {slip.length > 0 && <button onClick={clearSlip} className="text-[11px] font-bold text-neutral-400 hover:text-loss-500 transition">Clear</button>}
            </div>

            {slip.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-neutral-500">Tap odds to add selections.</p>
            ) : (
              <div className="divide-y divide-white/5">
                {slip.map((l) => (
                  <div key={l.eventId} className="px-4 py-3 flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{l.home} v {l.away}</div>
                      <div className="text-[11px] text-neutral-400 mt-0.5">
                        Pick <span className="font-bold text-brand-300">{l.label}</span> · <span className="tabular-nums">{l.odds.toFixed(2)}</span>
                      </div>
                    </div>
                    <button onClick={() => removeLeg(l.eventId)} className="text-neutral-500 hover:text-loss-500 text-lg leading-none">×</button>
                  </div>
                ))}
              </div>
            )}

            {slip.length > 0 && (
              <div className="px-4 py-4 border-t border-white/5 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-400">Combined odds</span>
                  <span className="font-bold tabular-nums text-bet-400">{combined.toFixed(2)}×</span>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 mb-1.5">Stake (max {maxStake})</label>
                  <input
                    type="number" min="1" step="any" inputMode="decimal" value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    className="w-full rounded-control bg-space-950 border border-white/10 px-3 py-2.5 text-lg font-bold tabular-nums outline-none focus:border-brand-500/60 transition"
                  />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-400">Potential payout</span>
                  <span className="font-bold tabular-nums text-brand-300">{potential.toLocaleString(undefined, { maximumFractionDigits: 2 })} cr</span>
                </div>
                {playError && <p className="text-xs text-loss-500">{playError}</p>}
                <button
                  onClick={play}
                  disabled={playing || !sessionId}
                  className="w-full py-3 rounded-control font-black bg-brand-500 text-space-950 hover:bg-brand-400 transition disabled:opacity-50"
                >
                  {playing ? 'Simulating…' : `Simulate ${slip.length} ${slip.length === 1 ? 'pick' : 'picks'}`}
                </button>
              </div>
            )}
          </div>

          {result && <ResultCard result={result} showFair={showFair} onToggleFair={() => setShowFair((s) => !s)} />}
        </aside>
      </main>

      <footer className="text-center py-5 text-[11px] text-neutral-500 border-t border-white/5 bg-space-950/60 mt-6">
        Simulate · play-money only · outcomes are RNG-drawn, not real match results.
      </footer>
    </div>
  );
}

// ─── Fixture row ─────────────────────────────────────────────────────────────
function FixtureRow({ fx, selectedPick, onToggle }: { fx: Fixture; selectedPick: Pick | null; onToggle: (fx: Fixture, o: Option) => void }) {
  const block = fx.markets.find((m) => m.market === '1x2');
  return (
    <div className="rounded-panel border border-white/10 bg-space-800/70 p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500 truncate">{fx.league}</div>
          <div className="font-semibold text-sm mt-0.5 truncate">{fx.home} <span className="text-neutral-500">v</span> {fx.away}</div>
        </div>
        <div className="text-[11px] text-neutral-400 shrink-0 ml-3 text-right">{fmtKickoff(fx.kickoff)}</div>
      </div>
      {block && (
        <div className="grid grid-cols-3 gap-2">
          {block.options.map((o) => {
            const active = selectedPick === o.pick;
            return (
              <button
                key={o.pick}
                onClick={() => onToggle(fx, o)}
                className={`rounded-control px-2 py-2.5 text-sm font-bold tabular-nums transition border ${
                  active ? 'bg-brand-500 text-space-950 border-brand-500' : 'bg-space-950/60 text-neutral-200 border-white/10 hover:border-brand-500/50'
                }`}
              >
                <span className="block text-[10px] font-semibold uppercase tracking-wide opacity-70">{o.label}</span>
                {o.odds.toFixed(2)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Result card ─────────────────────────────────────────────────────────────
function ResultCard({ result, showFair, onToggleFair }: { result: PlayResult; showFair: boolean; onToggleFair: () => void }) {
  return (
    <div className={`mt-4 rounded-panel border p-4 ${result.won ? 'border-bet-400/40 bg-bet-400/5' : 'border-loss-500/40 bg-loss-500/5'}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-display font-black text-xl">{result.won ? 'You won! 🎉' : 'No win'}</h3>
        <span className={`text-lg font-black tabular-nums ${result.won ? 'text-bet-400' : 'text-loss-500'}`}>
          {result.won ? `+${result.payout.toLocaleString()}` : `-${result.stake.toLocaleString()}`} cr
        </span>
      </div>
      <div className="mt-3 space-y-1.5">
        {result.legs.map((l, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-neutral-400 truncate">Leg {i + 1} · pick {l.pick} @ {l.odds.toFixed(2)}</span>
            <span className={l.won ? 'text-bet-400 font-bold' : 'text-loss-500 font-bold'}>{l.won ? 'won' : 'lost'}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between text-xs text-neutral-400">
        <span>Combined {result.combinedOdds.toFixed(2)}× · new balance {result.balance.toLocaleString()} cr</span>
      </div>
      <button onClick={onToggleFair} className="mt-3 text-[11px] font-bold text-brand-300 hover:text-brand-200 transition">
        {showFair ? 'Hide' : 'Show'} provably-fair proof
      </button>
      {showFair && (
        <div className="mt-2 rounded-control bg-space-950/70 border border-white/10 p-3 text-[10px] font-mono break-all text-neutral-400 space-y-1">
          <div><span className="text-neutral-500">commit </span>{result.fair.commit}</div>
          <div><span className="text-neutral-500">seed </span>{result.fair.serverSeed}</div>
          <div><span className="text-neutral-500">nonce </span>{result.fair.nonce}</div>
          <div className="text-neutral-500 pt-1">Recompute with HMAC-SHA256(seed, `${'{'}nonce{'}'}:{'{'}i{'}'}:{'{'}eventId{'}'}:{'{'}pick{'}'}`) — each leg wins iff u &lt; {result.fair.rtp.toFixed(2)}^(1/legs)/odds.</div>
        </div>
      )}
    </div>
  );
}

function FixtureSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="rounded-panel border border-white/5 bg-space-800/60 p-3.5">
          <div className="h-3 w-1/3 rounded bg-space-700/70 animate-pulse mb-2" />
          <div className="h-4 w-2/3 rounded bg-space-700/70 animate-pulse mb-3" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((__, j) => <div key={j} className="h-11 rounded bg-space-700/70 animate-pulse" />)}
          </div>
        </div>
      ))}
    </div>
  );
}
