import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BUDGET_TENTHS,
  CAPTAIN_MULTIPLIER,
  MAX_PER_CLUB,
  MIN_ENTRANTS,
  POSITIONS,
  POSITION_LIMITS,
  SQUAD_SIZE,
  formatMillions,
  payouts,
  splitPool,
  squadCost,
  squadIssues,
  type Position,
  type SquadPick,
  type SquadPlayer,
} from '@crash/shared/fantasy';
import AuthModal, { type AuthSuccess } from './components/AuthModal';
import {
  AppBar, ArrowLeftIcon, Button, CheckIcon, Chip, Eyebrow, LogOutIcon, Modal, Panel,
  Readout, Spinner, Stat, TextInput, TrophyGlyph, Wordmark, XIcon,
} from './components/ui';
import { fromMinor } from './lib/money';

/**
 * Fantasy League — classic fantasy football on the official Premier League
 * fantasy data. Pick an 11-man XI for a gameweek, captain doubles; the league
 * table runs live on official FPL points and the pool pays the top three once
 * the gameweek is final. Needs a player account (shared with the Lobby).
 */

const TOKEN_KEY = 'casino_player_token';
const USERNAME_KEY = 'casino_player_username';

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function readUsername(): string | null {
  try { return localStorage.getItem(USERNAME_KEY); } catch { return null; }
}

// ─── Types (mirror /api/fantasy-league) ────────────────────────────────────

type Phase = 'open' | 'live' | 'settled' | 'cancelled';

interface League {
  leagueId: string;
  name: string;
  blurb: string;
  gameweek: number;
  deadline: string;
  entryFeeMinor: number;
  currency: string;
  rakeBps: number;
  payoutBps: number[];
  poolMinor: number | null;
  rakeMinor: number | null;
  memberCount: number;
  phase: Phase;
}
interface Standing {
  rank: number | null;
  playerId: string;
  username: string;
  points: number | null;
  payoutMinor: number | null;
}
interface LeagueDetail {
  league: League;
  standings: Standing[];
  total: number;
}
interface MyEntry {
  squad: SquadPick;
  rank: number | null;
  points: number | null;
  payoutMinor: number | null;
}
interface CatalogPlayer extends SquadPlayer {
  name: string;
  status: string;
  news: string;
}
interface Catalog {
  gameweek: { id: number; name: string; deadline: string } | null;
  teams: Array<{ id: number; name: string; shortName: string }>;
  players: CatalogPlayer[];
}
interface FplLink {
  entryId: number;
  teamName: string;
  managerName: string;
}

const ACCENTS = ['#fb6514', 'hsl(211 90% 45%)', 'hsl(138 61% 47%)', 'hsl(37 91% 55%)', 'hsl(263 62% 58%)', 'hsl(187 71% 44%)'];

const POSITION_STYLE: Record<Position, string> = {
  GKP: 'bg-cash-500/15 text-cash-400 border-cash-500/30',
  DEF: 'bg-info-500/15 text-info-300 border-info-500/30',
  MID: 'bg-bet-500/15 text-bet-400 border-bet-500/30',
  FWD: 'bg-brand-500/15 text-brand-300 border-brand-500/30',
};

const STATUS_LABEL: Record<string, string> = { d: 'Doubtful', i: 'Injured', s: 'Suspended' };

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

function fmtDeadline(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const abs = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const ms = d.getTime() - nowMs;
  if (ms <= 0) return abs;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${abs} · in ${days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}`;
}

/** Prize pool after rake — the stored result once settled, else projected from current entries. */
function prizePool(l: League): number {
  if (l.poolMinor != null && l.rakeMinor != null) return l.poolMinor - l.rakeMinor;
  return splitPool(l.entryFeeMinor, l.memberCount, l.rakeBps).prizePoolMinor;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

async function getJson<T>(url: string, token?: string | null): Promise<T> {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<T>;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function FantasyLeague() {
  const now = useNow(30_000);

  const [token, setToken] = useState<string | null>(() => readToken());
  const [username, setUsername] = useState<string | null>(() => readUsername());
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingJoin, setPendingJoin] = useState<League | null>(null);

  const [leagues, setLeagues] = useState<League[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('league'));
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [myEntry, setMyEntry] = useState<MyEntry | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [builderLeague, setBuilderLeague] = useState<League | null>(null);
  // Bumped after a join so every view refetches (leagues, table, my entry).
  const [reload, setReload] = useState(0);

  const logout = useCallback(() => {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USERNAME_KEY); } catch { /* ignore */ }
    setToken(null); setUsername(null); setBalanceMinor(null); setCurrency(null);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch('/api/lobby/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.status === 401) { if (!cancelled) logout(); return; }
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as { balanceMinor: number; currency: string };
        setBalanceMinor(j.balanceMinor);
        setCurrency(j.currency);
      })
      .catch(() => { /* keep last known balance */ });
    return () => { cancelled = true; };
  }, [token, reload, logout]);

  useEffect(() => {
    let cancelled = false;
    getJson<{ items: League[] }>('/api/fantasy-league/leagues')
      .then((j) => { if (!cancelled) { setLeagues(j.items); setLoadError(null); } })
      .catch(() => { if (!cancelled) { setLeagues([]); setLoadError('Could not load leagues — is the server running?'); } });
    return () => { cancelled = true; };
  }, [reload]);

  useEffect(() => {
    if (!token) { setJoined(new Set()); return; }
    let cancelled = false;
    getJson<{ leagueIds: string[] }>('/api/fantasy-league/my-leagues', token)
      .then((j) => { if (!cancelled) setJoined(new Set(j.leagueIds)); })
      .catch(() => { /* cards just won't mark entered leagues */ });
    return () => { cancelled = true; };
  }, [token, reload]);

  useEffect(() => {
    let cancelled = false;
    getJson<Catalog>('/api/fantasy-league/catalog')
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch(() => { /* builder shows its own error */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); setMyEntry(null); return; }
    let cancelled = false;
    getJson<LeagueDetail>(`/api/fantasy-league/leagues/${encodeURIComponent(selectedId)}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setLoadError('Could not load that league.'); });
    if (token) {
      getJson<{ entry: MyEntry | null }>(`/api/fantasy-league/leagues/${encodeURIComponent(selectedId)}/me`, token)
        .then((j) => { if (!cancelled) setMyEntry(j.entry); })
        .catch(() => { if (!cancelled) setMyEntry(null); });
    } else {
      setMyEntry(null);
    }
    return () => { cancelled = true; };
  }, [selectedId, token, reload]);

  const onAuthSuccess = useCallback((result: AuthSuccess) => {
    try { localStorage.setItem(TOKEN_KEY, result.token); localStorage.setItem(USERNAME_KEY, result.username); } catch { /* ignore */ }
    setToken(result.token);
    setUsername(result.username);
    setBalanceMinor(result.balanceMinor);
    setAuthOpen(false);
    if (pendingJoin) { setBuilderLeague(pendingJoin); setPendingJoin(null); }
  }, [pendingJoin]);

  const startJoin = (league: League) => {
    if (!readToken()) { setPendingJoin(league); setAuthOpen(true); return; }
    setBuilderLeague(league);
  };

  const onJoined = (league: League) => {
    setBuilderLeague(null);
    setSelectedId(league.leagueId);
    setReload((r) => r + 1);
  };

  const openLeague = (id: string | null) => {
    setSelectedId(id);
    setDetail(null);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="min-h-screen bg-space-950 text-neutral-100">
      <AppBar
        left={
          <>
            <a
              href={selectedId ? '/fantasy-league' : '/'}
              onClick={selectedId ? (e) => { e.preventDefault(); openLeague(null); } : undefined}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-btn text-neutral-500 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-neutral-100"
              aria-label={selectedId ? 'Back to leagues' : 'Back to lobby'}
            >
              <ArrowLeftIcon className="h-4 w-4" />
            </a>
            <Wordmark caption="Fantasy League" />
          </>
        }
        right={
          token ? (
            <>
              <Readout label={username ?? 'Player'} value={balanceMinor == null || !currency ? '—' : fromMinor(balanceMinor, currency)} />
              <Button variant="ghost" size="sm" onClick={logout} className="hidden sm:inline-flex">Log out</Button>
              <Button variant="ghost" size="sm" onClick={logout} aria-label="Log out" className="px-2 sm:hidden">
                <LogOutIcon className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => { setPendingJoin(null); setAuthOpen(true); }}>Log in</Button>
          )
        }
      />

      <main className="mx-auto max-w-[1080px] px-4 pb-16 pt-6 sm:px-6 sm:pt-8">
        {loadError && (
          <div className="mb-6 rounded-card border border-loss-500/30 bg-loss-500/10 px-4 py-3 text-[13px] text-loss-400">{loadError}</div>
        )}
        {selectedId ? (
          detail ? (
            <LeagueDetails
              detail={detail}
              myEntry={myEntry}
              catalog={catalog}
              now={now}
              onJoin={() => startJoin(detail.league)}
            />
          ) : (
            <div className="h-64 animate-pulse rounded-card bg-white/[0.04]" />
          )
        ) : (
          <LeagueHome leagues={leagues} joined={joined} catalog={catalog} now={now} onOpen={openLeague} onJoin={startJoin} />
        )}
      </main>

      <footer className="border-t border-edge-soft">
        <div className="mx-auto max-w-[1080px] px-4 py-5 text-[11px] text-neutral-600 sm:px-6">
          Game Hub · Fantasy League · player data and points from the official Fantasy Premier League.
        </div>
      </footer>

      {authOpen && <AuthModal onClose={() => { setAuthOpen(false); setPendingJoin(null); }} onSuccess={onAuthSuccess} />}
      {builderLeague && token && (
        <SquadBuilder
          league={builderLeague}
          token={token}
          accountCurrency={currency}
          catalog={catalog}
          onClose={() => setBuilderLeague(null)}
          onJoined={() => onJoined(builderLeague)}
        />
      )}
    </div>
  );
}

// ─── Landing ─────────────────────────────────────────────────────────────────

function LeagueHome({
  leagues, joined, catalog, now, onOpen, onJoin,
}: {
  leagues: League[] | null;
  joined: Set<string>;
  catalog: Catalog | null;
  now: number;
  onOpen: (id: string) => void;
  onJoin: (league: League) => void;
}) {
  const open = (leagues ?? []).filter((l) => l.phase === 'open');
  const past = (leagues ?? []).filter((l) => l.phase !== 'open');

  return (
    <>
      <Panel className="animate-rise p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-chip bg-cash-500">
            <TrophyGlyph className="h-3.5 w-3.5 text-black" />
          </span>
          <h1 className="text-[15px] font-semibold tracking-tight text-neutral-100">Fantasy Premier League</h1>
          <Chip className="ml-auto">Official FPL points</Chip>
        </div>
        <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-neutral-400">
          Pick {SQUAD_SIZE} real Premier League players within {formatMillions(BUDGET_TENTHS)}, max {MAX_PER_CLUB} from one
          club. Your captain scores {CAPTAIN_MULTIPLIER}×. Every league is one gameweek: the table runs live on official
          FPL points, and the top three split the pool when the gameweek is final.
        </p>
        {catalog?.gameweek && (
          <p className="mt-3 text-[12px] text-neutral-500">
            <span className="font-semibold text-neutral-300">{catalog.gameweek.name}</span> deadline: {fmtDeadline(catalog.gameweek.deadline, now)}
          </p>
        )}
      </Panel>

      <LeagueSection title={catalog?.gameweek ? `Open for ${catalog.gameweek.name}` : 'Open leagues'} leagues={leagues == null ? null : open} joined={joined} now={now} onOpen={onOpen} onJoin={onJoin}
        empty="No leagues are open right now — the next gameweek's leagues open automatically." />
      {past.length > 0 && <LeagueSection title="Live & results" leagues={past} joined={joined} now={now} onOpen={onOpen} onJoin={onJoin} empty="" />}
    </>
  );
}

function LeagueSection({
  title, leagues, joined, now, onOpen, onJoin, empty,
}: {
  title: string;
  leagues: League[] | null;
  joined: Set<string>;
  now: number;
  onOpen: (id: string) => void;
  onJoin: (league: League) => void;
  empty: string;
}) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-3 px-0.5">
        <Eyebrow>{title}</Eyebrow>
        {leagues && <span className="text-[11px] tabular-nums text-neutral-600">{leagues.length}</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {leagues == null
          ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-64 animate-pulse rounded-card bg-white/[0.04]" />)
          : leagues.length === 0
            ? <Panel className="col-span-full px-6 py-12 text-center text-[13px] text-neutral-500">{empty}</Panel>
            : leagues.map((l, i) => (
              <LeagueCard key={l.leagueId} league={l} accent={ACCENTS[i % ACCENTS.length]!} now={now} entered={joined.has(l.leagueId)}
                onOpen={() => onOpen(l.leagueId)} onJoin={() => onJoin(l)} />
            ))}
      </div>
    </section>
  );
}

function PhaseChip({ phase }: { phase: Phase }) {
  if (phase === 'open') return <Chip tone="up">Open</Chip>;
  if (phase === 'live') {
    return <Chip tone="accent"><span className="mr-0.5 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand-400" />Live</Chip>;
  }
  if (phase === 'settled') return <Chip>Final</Chip>;
  return <Chip>Cancelled · refunded</Chip>;
}

function LeagueCard({ league, accent, now, entered, onOpen, onJoin }: {
  league: League; accent: string; now: number; entered: boolean; onOpen: () => void; onJoin: () => void;
}) {
  return (
    <Panel className="flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="relative grid h-24 shrink-0 place-items-center transition-[filter] duration-150 ease-snap hover:brightness-110"
        style={{ backgroundColor: accent }}
        aria-label={`Open ${league.name}`}
      >
        <TrophyGlyph className="h-8 w-8 text-black/70" />
        <span className="absolute left-3 top-3 rounded-chip bg-black/25 px-1.5 py-0.5 text-[10px] font-bold text-black/80">GW {league.gameweek}</span>
      </button>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            <div className="truncate text-[13px] font-semibold text-neutral-100">{league.name}</div>
            <div className="truncate text-[11px] text-neutral-500">{league.blurb}</div>
          </button>
          <Chip tone="accent" className="shrink-0">{fromMinor(league.entryFeeMinor, league.currency)}</Chip>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <PhaseChip phase={league.phase} />
          {entered && <Chip tone="up"><CheckIcon className="h-3 w-3" />You're in</Chip>}
          <span className="tabular-nums">{league.memberCount.toLocaleString()} {league.memberCount === 1 ? 'entry' : 'entries'}</span>
          <span className="tabular-nums">Prize {fromMinor(prizePool(league), league.currency)}</span>
        </div>
        {league.phase === 'open' && <div className="text-[11px] text-neutral-600">Locks {fmtDeadline(league.deadline, now)}</div>}
        {league.phase === 'open' && !entered
          ? <Button variant="primary" onClick={onJoin} className="mt-auto w-full">Join Now</Button>
          : <Button variant="secondary" onClick={onOpen} className="mt-auto w-full">{entered && league.phase === 'open' ? 'View your entry' : 'View table'}</Button>}
      </div>
    </Panel>
  );
}

// ─── League details ──────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number | null }) {
  const tone =
    rank === 1 ? 'bg-cash-500 text-black' :
    rank === 2 ? 'bg-neutral-300 text-black' :
    rank === 3 ? 'bg-brand-600 text-black' :
    'bg-white/[0.06] text-neutral-400';
  return (
    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold tabular-nums ${tone}`}>
      {rank ?? '–'}
    </span>
  );
}

function LeagueDetails({
  detail, myEntry, catalog, now, onJoin,
}: {
  detail: LeagueDetail;
  myEntry: MyEntry | null;
  catalog: Catalog | null;
  now: number;
  onJoin: () => void;
}) {
  const { league, standings, total } = detail;
  const ranked = league.phase === 'live' || league.phase === 'settled';
  const podium = ranked ? standings.slice(0, 3) : [];
  const table = ranked ? standings.slice(podium.length) : standings;
  const pool = prizePool(league);
  const places = Math.max(1, Math.min(league.payoutBps.length, league.memberCount || league.payoutBps.length));
  const placeAmounts = payouts(Array.from({ length: places }, (_, i) => ({ key: String(i), rank: i + 1 })), pool, league.payoutBps).byKey;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Eyebrow>Gameweek {league.gameweek} · Premier League</Eyebrow>
            <PhaseChip phase={league.phase} />
          </div>
          <h1 className="mt-1 truncate text-[20px] font-bold tracking-tight text-neutral-100">{league.name}</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            {league.phase === 'open' ? `Locks ${fmtDeadline(league.deadline, now)}` : league.phase === 'live' ? 'Points update live as matches are played' : league.phase === 'settled' ? 'Final — prizes paid to winners’ wallets' : 'Too few entries — every entry fee was refunded'}
          </p>
        </div>
        {myEntry ? (
          <Chip tone="up" className="shrink-0 !px-3 !py-1.5 !text-[12px]"><CheckIcon className="h-3.5 w-3.5" /> You're in</Chip>
        ) : league.phase === 'open' ? (
          <Button variant="primary" size="lg" onClick={onJoin} className="shrink-0">
            Join · {fromMinor(league.entryFeeMinor, league.currency)}
          </Button>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-btn bg-white/[0.06] sm:grid-cols-4">
        {[
          { label: 'Your rank', value: myEntry?.rank ? `${ordinal(myEntry.rank)} of ${total}` : myEntry ? 'At deadline' : '—', tone: 'accent' as const },
          { label: 'Your points', value: myEntry?.points != null ? myEntry.points.toLocaleString() : '—', tone: 'default' as const },
          { label: league.phase === 'settled' ? 'You won' : league.phase === 'live' ? 'Projected prize' : 'Prize pool', value: league.phase === 'settled' || league.phase === 'live' ? fromMinor(myEntry?.payoutMinor ?? 0, league.currency) : fromMinor(pool, league.currency), tone: 'up' as const },
          { label: 'Entries', value: league.memberCount.toLocaleString(), tone: 'default' as const },
        ].map((s) => (
          <div key={s.label} className="bg-space-850 px-4 py-3.5"><Stat label={s.label} value={s.value} tone={s.tone} /></div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-neutral-500">
        {league.payoutBps.map((bps, i) => (
          <span key={i} className="rounded-chip border border-edge-soft px-2 py-1 tabular-nums">
            {ordinal(i + 1)} · {bps / 100}%{placeAmounts.has(String(i)) && league.memberCount >= MIN_ENTRANTS ? ` · ${fromMinor(placeAmounts.get(String(i))!, league.currency)}` : ''}
          </span>
        ))}
        <span className="px-1 py-1">after a {league.rakeBps / 100}% house fee</span>
        {league.phase === 'open' && league.memberCount < MIN_ENTRANTS && (
          <span className="px-1 py-1 text-cash-400">Needs {MIN_ENTRANTS}+ entries by the deadline, or every entry is refunded.</span>
        )}
      </div>

      {myEntry && catalog && <YourTeam entry={myEntry} catalog={catalog} />}

      {podium.length > 0 && (
        <section className="mt-10">
          <Eyebrow className="mb-4 block px-0.5">Top of the table</Eyebrow>
          <div className="grid grid-cols-3 items-end gap-3">
            {[podium[1], podium[0], podium[2]].map((e, i) => e ? (
              <Panel key={e.playerId} className={`flex flex-col items-center gap-1.5 px-2 ${i === 1 ? 'py-6' : 'py-4'}`}>
                <RankBadge rank={e.rank} />
                <span className="max-w-full truncate text-[12px] font-semibold text-neutral-200">{e.username}</span>
                <span className="text-[13px] font-bold tabular-nums text-brand-400">{e.points ?? 0} pts</span>
                {e.payoutMinor ? <span className="text-[11px] tabular-nums text-bet-400">{fromMinor(e.payoutMinor, league.currency)}</span> : null}
              </Panel>
            ) : <div key={i} />)}
          </div>
        </section>
      )}

      <section className="mt-6">
        <div className="mb-3 flex items-baseline justify-between px-0.5">
          <Eyebrow>{ranked ? 'Leaderboard' : 'Entries so far'}</Eyebrow>
          {!ranked && league.phase === 'open' && <span className="text-[11px] text-neutral-600">Points start at the deadline</span>}
        </div>
        {standings.length === 0 ? (
          <Panel className="px-6 py-10 text-center text-[13px] text-neutral-400">No one has entered yet — be the first.</Panel>
        ) : table.length > 0 && (
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-white/[0.05]">
              {table.map((e) => (
                <li key={e.playerId} className="flex items-center gap-3 px-4 py-2.5">
                  <RankBadge rank={e.rank} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-200">{e.username}</span>
                  {e.payoutMinor ? <span className="shrink-0 text-[12px] tabular-nums text-bet-400">{fromMinor(e.payoutMinor, league.currency)}</span> : null}
                  {e.points != null && (
                    <span className="w-16 shrink-0 text-right text-[13px] font-semibold tabular-nums text-neutral-100">
                      {e.points} <span className="text-[10px] font-medium text-neutral-600">pts</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {total > standings.length && <div className="border-t border-edge-soft px-4 py-2 text-[11px] text-neutral-600">Showing top {standings.length} of {total}</div>}
          </Panel>
        )}
      </section>

      <section className="mt-10">
        <Eyebrow className="mb-3 block px-0.5">How it works</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['Pick your XI', `${SQUAD_SIZE} players in a legal formation, ${formatMillions(BUDGET_TENTHS)} budget, max ${MAX_PER_CLUB} per club. Import your FPL team to start fast.`],
            ['Captain scores double', 'Your captain’s points count twice. If they don’t play, your vice-captain’s do.'],
            ['Top three get paid', 'Official FPL points decide the table. When the gameweek is final, prizes land in your wallet.'],
          ].map(([title, body]) => (
            <div key={title} className="rounded-card border border-edge-soft px-4 py-3.5">
              <div className="flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 shrink-0 text-bet-400" />
                <span className="text-[13px] font-semibold text-neutral-200">{title}</span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-500">{body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function PositionTag({ position }: { position: Position }) {
  return <span className={`inline-flex w-9 shrink-0 justify-center rounded-chip border py-0.5 text-[10px] font-bold ${POSITION_STYLE[position]}`}>{position}</span>;
}

function YourTeam({ entry, catalog }: { entry: MyEntry; catalog: Catalog }) {
  const byId = new Map(catalog.players.map((p) => [p.id, p]));
  const clubs = new Map(catalog.teams.map((t) => [t.id, t.shortName]));
  const xi = entry.squad.playerIds
    .map((id) => byId.get(id))
    .filter((p): p is CatalogPlayer => !!p)
    .sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));
  return (
    <section className="mt-10">
      <Eyebrow className="mb-3 block px-0.5">Your XI</Eyebrow>
      <Panel className="grid gap-px overflow-hidden bg-white/[0.04] sm:grid-cols-2">
        {xi.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 bg-space-850 px-4 py-2.5">
            <PositionTag position={p.position} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-200">{p.name}</span>
            <span className="text-[11px] text-neutral-500">{clubs.get(p.teamId)}</span>
            {p.id === entry.squad.captainId && <Chip tone="accent">C</Chip>}
            {p.id === entry.squad.viceCaptainId && <Chip>V</Chip>}
          </div>
        ))}
      </Panel>
    </section>
  );
}

// ─── Squad builder ───────────────────────────────────────────────────────────

function SquadBuilder({
  league, token, accountCurrency, catalog, onClose, onJoined,
}: {
  league: League;
  token: string;
  accountCurrency: string | null;
  catalog: Catalog | null;
  onClose: () => void;
  onJoined: () => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [captainId, setCaptainId] = useState<number | null>(null);
  const [viceId, setViceId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Position | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pool = useMemo(() => new Map((catalog?.players ?? []).map((p) => [p.id, p])), [catalog]);
  const clubs = useMemo(() => new Map((catalog?.teams ?? []).map((t) => [t.id, t.shortName])), [catalog]);
  const currencyMismatch = accountCurrency != null && accountCurrency !== league.currency;

  const counts = useMemo(() => {
    const c: Record<Position, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const id of picked) { const p = pool.get(id); if (p) c[p.position] += 1; }
    return c;
  }, [picked, pool]);
  const clubCounts = useMemo(() => {
    const c = new Map<number, number>();
    for (const id of picked) { const p = pool.get(id); if (p) c.set(p.teamId, (c.get(p.teamId) ?? 0) + 1); }
    return c;
  }, [picked, pool]);
  const spent = squadCost(picked, pool);
  const pick: SquadPick = { playerIds: picked, captainId: captainId ?? -1, viceCaptainId: viceId ?? -1 };
  const issues = squadIssues(pick, pool);

  const setSquad = (ids: number[], captain: number | null, vice: number | null) => {
    setPicked(ids);
    const cap = captain != null && ids.includes(captain) ? captain : ids[0] ?? null;
    const vc = vice != null && ids.includes(vice) && vice !== cap ? vice : ids.find((id) => id !== cap) ?? null;
    setCaptainId(cap);
    setViceId(vc);
    setSubmitError(null);
  };

  const toggle = (id: number) => {
    if (picked.includes(id)) setSquad(picked.filter((x) => x !== id), captainId, viceId);
    else setSquad([...picked, id], captainId, viceId);
  };

  const blockedReason = (p: CatalogPlayer): string | null => {
    if (picked.includes(p.id)) return null;
    if (picked.length >= SQUAD_SIZE) return 'XI full';
    if (counts[p.position] >= POSITION_LIMITS[p.position].max) return `Max ${POSITION_LIMITS[p.position].max} ${p.position}`;
    if ((clubCounts.get(p.teamId) ?? 0) >= MAX_PER_CLUB) return `Max ${MAX_PER_CLUB} per club`;
    return null;
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.players ?? [])
      .filter((p) => filter === 'ALL' || p.position === filter)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (clubs.get(p.teamId) ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.cost - a.cost);
  }, [catalog, filter, query, clubs]);

  const importXi = (xi: SquadPick) => {
    const available = xi.playerIds.filter((id) => pool.has(id));
    const dropped = xi.playerIds.length - available.length;
    setSquad(available, xi.captainId, xi.viceCaptainId);
    setNotice(dropped > 0
      ? `Imported ${available.length} players — ${dropped} ${dropped === 1 ? 'is' : 'are'} no longer available, pick replacements.`
      : 'Imported your FPL starting XI — check the budget and club limits before confirming.');
  };

  const submit = async () => {
    if (issues.length > 0 || submitting || currencyMismatch) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/fantasy-league/leagues/${encodeURIComponent(league.leagueId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(pick),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = j?.error?.code;
        setSubmitError(
          code === 'INSUFFICIENT_FUNDS' ? "Your balance is too low for this entry fee — top up from the lobby, then try again."
          : code === 'ALREADY_JOINED' ? 'You have already entered this league.'
          : code === 'LEAGUE_LOCKED' ? 'This league has passed its deadline.'
          : j?.error?.message ?? 'Could not join — please try again.',
        );
        return;
      }
      onJoined();
    } catch {
      setSubmitError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const grouped = POSITIONS.map((pos) => ({ pos, players: picked.map((id) => pool.get(id)).filter((p): p is CatalogPlayer => p?.position === pos) }));

  return (
    <Modal title={`Pick your XI — ${league.name}`} onClose={onClose} width="max-w-5xl" padded={false}>
      {!catalog ? (
        <div className="grid place-items-center px-5 py-16"><Spinner className="h-6 w-6" /></div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* ─── Player pool ─── */}
          <div className="min-w-0 border-b border-edge-soft lg:border-b-0 lg:border-r">
            <div className="flex flex-col gap-3 px-5 py-4">
              <div className="inline-flex self-start rounded-btn border border-edge bg-space-950 p-1" role="tablist">
                {(['ALL', ...POSITIONS] as const).map((f) => (
                  <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                    className={`h-9 min-w-[44px] rounded-chip px-2.5 text-[12px] font-semibold transition-[background-color,color] duration-150 ease-snap ${filter === f ? 'bg-white/[0.10] text-neutral-100' : 'text-neutral-500 hover:text-neutral-200'}`}>
                    {f === 'ALL' ? 'All' : f}
                  </button>
                ))}
              </div>
              <TextInput placeholder="Search player or club (e.g. Saka, ARS)" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <ul className="max-h-[46vh] divide-y divide-white/[0.05] overflow-y-auto border-t border-edge-soft lg:max-h-[60vh]">
              {visible.map((p) => {
                const isPicked = picked.includes(p.id);
                const blocked = blockedReason(p);
                return (
                  <li key={p.id} className={`flex items-center gap-2.5 px-5 py-2 ${isPicked ? 'bg-brand-500/[0.06]' : ''}`}>
                    <PositionTag position={p.position} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-neutral-100">{p.name}</div>
                      <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                        <span>{clubs.get(p.teamId)}</span>
                        {STATUS_LABEL[p.status] && <span className="text-cash-400" title={p.news}>· {STATUS_LABEL[p.status]}</span>}
                      </div>
                    </div>
                    <span className="w-14 shrink-0 text-right text-[12px] font-semibold tabular-nums text-neutral-300">{formatMillions(p.cost)}</span>
                    <Button size="sm" variant={isPicked ? 'secondary' : 'quiet'} disabled={!!blocked} title={blocked ?? undefined}
                      onClick={() => toggle(p.id)} className="w-[76px] shrink-0">
                      {isPicked ? 'Remove' : blocked ?? 'Add'}
                    </Button>
                  </li>
                );
              })}
              {visible.length === 0 && <li className="px-5 py-10 text-center text-[12px] text-neutral-500">No players match.</li>}
            </ul>
          </div>

          {/* ─── Your XI ─── */}
          <div className="flex flex-col">
            <FplLinkPanel token={token} onImport={importXi} />

            <div className="border-b border-edge-soft px-5 py-3">
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="font-semibold text-neutral-200">{picked.length} / {SQUAD_SIZE} players</span>
                <span className={`tabular-nums ${spent > BUDGET_TENTHS ? 'text-loss-400' : 'text-neutral-400'}`}>
                  {formatMillions(spent)} / {formatMillions(BUDGET_TENTHS)}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className={`h-full rounded-full ${spent > BUDGET_TENTHS ? 'bg-loss-500' : 'bg-brand-500'}`} style={{ width: `${Math.min(100, (spent / BUDGET_TENTHS) * 100)}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] tabular-nums text-neutral-500">
                {POSITIONS.map((pos) => {
                  const { min, max } = POSITION_LIMITS[pos];
                  return <span key={pos} className={counts[pos] >= min && counts[pos] <= max ? 'text-bet-400' : ''}>{pos} {counts[pos]}/{min === max ? min : `${min}–${max}`}</span>;
                })}
              </div>
            </div>

            <div className="max-h-[32vh] flex-1 overflow-y-auto px-5 py-3 lg:max-h-none">
              {notice && <p className="mb-3 rounded-btn border border-edge bg-white/[0.03] px-3 py-2 text-[11px] text-neutral-400">{notice}</p>}
              {picked.length === 0 ? (
                <p className="py-6 text-center text-[12px] text-neutral-500">Add players from the list, or import your FPL team.</p>
              ) : grouped.map(({ pos, players }) => players.length > 0 && (
                <div key={pos} className="mb-2">
                  {players.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 py-1">
                      <PositionTag position={pos} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">{p.name}</span>
                      <button type="button" onClick={() => setSquad(picked, p.id, viceId === p.id ? captainId : viceId)} aria-pressed={captainId === p.id}
                        className={`h-7 w-7 rounded-chip border text-[10px] font-bold ${captainId === p.id ? 'border-brand-500 bg-brand-500 text-black' : 'border-edge text-neutral-500 hover:text-neutral-200'}`} title="Captain">C</button>
                      <button type="button" onClick={() => setSquad(picked, captainId === p.id ? viceId : captainId, p.id)} aria-pressed={viceId === p.id}
                        className={`h-7 w-7 rounded-chip border text-[10px] font-bold ${viceId === p.id ? 'border-neutral-300 bg-neutral-300 text-black' : 'border-edge text-neutral-500 hover:text-neutral-200'}`} title="Vice-captain">V</button>
                      <button type="button" onClick={() => toggle(p.id)} aria-label={`Remove ${p.name}`}
                        className="grid h-7 w-7 place-items-center rounded-chip text-neutral-600 hover:text-loss-400"><XIcon className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="border-t border-edge-soft px-5 py-4">
              {currencyMismatch ? (
                <p className="mb-3 text-[12px] text-loss-400">This league is played in {league.currency}; your account is in {accountCurrency}.</p>
              ) : picked.length === SQUAD_SIZE && issues.length > 0 ? (
                <ul className="mb-3 space-y-1 text-[11px] text-loss-400">{issues.map((i) => <li key={i}>· {i}</li>)}</ul>
              ) : null}
              {submitError && <p role="alert" className="mb-3 text-[12px] text-loss-400">{submitError}</p>}
              <Button variant="primary" size="lg" onClick={submit} disabled={issues.length > 0 || submitting || currencyMismatch} className="w-full">
                {submitting ? <><Spinner /> Entering…</> : `Confirm XI · ${fromMinor(league.entryFeeMinor, league.currency)}`}
              </Button>
              <p className="mt-2 text-center text-[11px] text-neutral-600">Entry fee is charged when you confirm. Locks {new Date(league.deadline).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function FplLinkPanel({ token, onImport }: { token: string; onImport: (xi: SquadPick) => void }) {
  const [link, setLink] = useState<FplLink | null | undefined>(undefined);
  const [entryId, setEntryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<{ link: FplLink | null }>('/api/fantasy-league/fpl-link', token)
      .then((j) => { if (!cancelled) setLink(j.link); })
      .catch(() => { if (!cancelled) setLink(null); });
    return () => { cancelled = true; };
  }, [token]);

  const call = async (method: 'PUT' | 'DELETE', body?: unknown) => {
    const res = await fetch('/api/fantasy-league/fpl-link', {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { res, j: res.status === 204 ? {} : await res.json().catch(() => ({})) };
  };

  const doLink = async () => {
    setBusy(true); setError(null);
    try {
      const { res, j } = await call('PUT', { entryId: Number(entryId) });
      if (!res.ok) { setError(j?.error?.message ?? 'Could not link that team.'); return; }
      setLink(j.link);
      setEntryId('');
    } catch { setError('Network error — please try again.'); } finally { setBusy(false); }
  };

  const doImport = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/fantasy-league/fpl-link/xi', { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? 'Could not import your team.'); return; }
      onImport(j as SquadPick);
    } catch { setError('Network error — please try again.'); } finally { setBusy(false); }
  };

  const doUnlink = async () => {
    setBusy(true); setError(null);
    try { await call('DELETE'); setLink(null); } catch { setError('Network error — please try again.'); } finally { setBusy(false); }
  };

  return (
    <div className="border-b border-edge-soft px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">Your FPL team</div>
      {link === undefined ? (
        <div className="mt-2 h-9 animate-pulse rounded-btn bg-white/[0.04]" />
      ) : link ? (
        <div className="mt-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-neutral-100">{link.teamName}</div>
            <div className="truncate text-[11px] text-neutral-500">{link.managerName} · ID {link.entryId}</div>
          </div>
          <Button size="sm" variant="primary" onClick={doImport} disabled={busy}>{busy ? <Spinner /> : 'Import XI'}</Button>
          <Button size="sm" variant="ghost" onClick={doUnlink} disabled={busy}>Unlink</Button>
        </div>
      ) : (
        <>
          <div className="mt-2 flex gap-2">
            <div className="flex-1">
              <TextInput placeholder="FPL Team ID, e.g. 1234567" inputMode="numeric" value={entryId}
                onChange={(e) => setEntryId(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && entryId) doLink(); }} />
            </div>
            <Button variant="secondary" onClick={doLink} disabled={busy || !entryId}>{busy ? <Spinner /> : 'Link'}</Button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-600">
            Find it in your FPL Points page URL: fantasy.premierleague.com/entry/<span className="text-neutral-400">1234567</span>/event/…
          </p>
        </>
      )}
      {error && <p className="mt-2 text-[11px] text-loss-400">{error}</p>}
    </div>
  );
}
