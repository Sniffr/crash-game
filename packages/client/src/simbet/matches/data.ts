import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { dayKey } from '../lib/format';

// Fixtures and priced markets for Simulated Matches, from the same feed as
// Game Hub's Simulate (real harvested fixtures and 1X2 odds).

export interface Option { pick: string; label: string; odds: number }
export interface MarketBlock { market: string; name: string; options: Option[] }
export interface Fixture {
  eventId: string;
  league: string;
  home: string;
  away: string;
  kickoff: string;
  markets: MarketBlock[];
}

// ─── Fixtures (one shared, periodically refreshed list) ─────────────────────

const FIXTURES_TTL_MS = 2 * 60_000;
let fixturesCache: { at: number; items: Fixture[] } | null = null;
let fixturesInFlight: Promise<Fixture[]> | null = null;

function loadFixtures(): Promise<Fixture[]> {
  if (fixturesCache && Date.now() - fixturesCache.at < FIXTURES_TTL_MS) return Promise.resolve(fixturesCache.items);
  fixturesInFlight ??= api<{ fixtures: Fixture[] }>('/api/simulate/fixtures?window=all')
    .then((r) => {
      fixturesCache = { at: Date.now(), items: r.fixtures };
      return r.fixtures;
    })
    .finally(() => { fixturesInFlight = null; });
  return fixturesInFlight;
}

export function useFixtures(): { fixtures: Fixture[] | null; error: string | null; retry: () => void } {
  const [fixtures, setFixtures] = useState<Fixture[] | null>(fixturesCache?.items ?? null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => loadFixtures()
      .then((f) => { if (live) { setFixtures(f); setError(null); } })
      .catch(() => { if (live) setError('We couldn’t load matches right now.'); });
    void load();
    // Kicked-off fixtures drop out of the feed; keep the board current.
    const id = window.setInterval(load, FIXTURES_TTL_MS);
    return () => { live = false; window.clearInterval(id); };
  }, [attempt]);
  return { fixtures, error, retry: () => setAttempt((a) => a + 1) };
}

// ─── Priced markets (everything beyond 1X2), fetched in batches ─────────────

const MAX_BATCH = 20;
const marketsCache = new Map<string, MarketBlock[]>();
const marketsInFlight = new Set<string>();
const marketListeners = new Set<() => void>();

async function fetchMarkets(ids: string[]): Promise<void> {
  const todo = ids.filter((id) => !marketsCache.has(id) && !marketsInFlight.has(id));
  if (todo.length === 0) return;
  todo.forEach((id) => marketsInFlight.add(id));
  try {
    // Sequential batches: each cold fixture costs the server a model fit.
    for (let i = 0; i < todo.length; i += MAX_BATCH) {
      const chunk = todo.slice(i, i + MAX_BATCH);
      const r = await api<{ items: Array<{ eventId: string; markets: MarketBlock[] }> }>(
        `/api/simulate/fixtures/markets?ids=${chunk.map(encodeURIComponent).join(',')}`,
      );
      for (const item of r.items) marketsCache.set(item.eventId, item.markets);
      // Fixtures the feed no longer prices: remember as empty so we don't refetch forever.
      for (const id of chunk) if (!marketsCache.has(id)) marketsCache.set(id, []);
      marketListeners.forEach((l) => l());
    }
  } finally {
    todo.forEach((id) => marketsInFlight.delete(id));
  }
}

/** Priced markets for these fixtures; missing entries are still loading. */
export function useMarkets(eventIds: string[]): Map<string, MarketBlock[]> {
  const [, bump] = useState(0);
  const key = eventIds.join(',');
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    marketListeners.add(l);
    void fetchMarkets(eventIds).catch(() => { /* cells stay as placeholders; next open retries */ });
    return () => { marketListeners.delete(l); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return marketsCache;
}

export function marketOf(fx: Fixture, markets: Map<string, MarketBlock[]>, market: string): MarketBlock | undefined {
  return (markets.get(fx.eventId) ?? fx.markets).find((m) => m.market === market)
    ?? fx.markets.find((m) => m.market === market);
}

// ─── Date filter & league ordering ───────────────────────────────────────────

export type DateRange = 'all' | 'today' | 'tomorrow' | '48h' | 'week' | 'month';

export const DATE_OPTIONS: ReadonlyArray<{ key: DateRange; label: string }> = [
  { key: 'all', label: 'All Time' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: '48h', label: 'Next 48 Hrs' },
  { key: 'week', label: 'Next Week' },
  { key: 'month', label: 'Next Month' },
];

export function inRange(iso: string, range: DateRange, now = Date.now()): boolean {
  if (range === 'all') return true;
  const t = new Date(iso).getTime();
  const today = dayKey(new Date(now).toISOString());
  if (range === 'today') return dayKey(iso) === today;
  if (range === 'tomorrow') return dayKey(iso) === dayKey(new Date(now + 86_400_000).toISOString());
  const span = range === '48h' ? 2 : range === 'week' ? 7 : 31;
  return t <= now + span * 86_400_000;
}

/** Big competitions first on Highlights; everything else by how many fixtures it has. */
const FEATURED = [/premier league/i, /champions league/i, /la ?liga/i, /serie a/i, /bundesliga/i, /ligue 1/i, /europa league/i, /kenya/i];
const featuredRank = (league: string) => {
  const i = FEATURED.findIndex((re) => re.test(league));
  return i < 0 ? FEATURED.length : i;
};

export interface LeagueGroup { league: string; fixtures: Fixture[] }

export function groupByLeague(fixtures: Fixture[], order: 'highlights' | 'upcoming'): LeagueGroup[] {
  const map = new Map<string, Fixture[]>();
  for (const f of [...fixtures].sort((a, b) => a.kickoff.localeCompare(b.kickoff))) {
    const list = map.get(f.league);
    if (list) list.push(f); else map.set(f.league, [f]);
  }
  const groups = [...map].map(([league, items]) => ({ league, fixtures: items }));
  if (order === 'upcoming') return groups.sort((a, b) => a.fixtures[0]!.kickoff.localeCompare(b.fixtures[0]!.kickoff));
  return groups.sort((a, b) => featuredRank(a.league) - featuredRank(b.league) || b.fixtures.length - a.fixtures.length);
}

export function useBoard(fixtures: Fixture[] | null, range: DateRange, order: 'highlights' | 'upcoming', league: string | null) {
  return useMemo(() => {
    if (!fixtures) return null;
    const now = Date.now();
    const visible = fixtures.filter((f) => new Date(f.kickoff).getTime() > now && inRange(f.kickoff, range, now) && (!league || f.league === league));
    return groupByLeague(visible, order);
  }, [fixtures, range, order, league]);
}

/** A short numeric game code for display ("19724"), from the feed's event id. */
export function gameCode(eventId: string): string {
  const digits = eventId.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(-5);
  // Ids without a number of their own get a stable 5-digit code instead.
  let h = 0;
  for (let i = 0; i < eventId.length; i++) h = (h * 31 + eventId.charCodeAt(i)) >>> 0;
  return String(h % 100_000).padStart(5, '0');
}

/** How a pick reads on the slip and in history: "Chelsea", "Draw", "Over 2.5", "GG". */
export function pickLabel(fx: { home: string; away: string }, market: string, option: { pick: string; label: string }): string {
  if (market === '1x2') return option.pick === 'home' ? fx.home : option.pick === 'away' ? fx.away : 'Draw';
  if (market === 'btts') return option.pick === 'yes' ? 'GG (both score)' : 'NG (not both)';
  return option.label;
}

/** A stored pick ("home", "over", "3_1") as the player reads it, without the option list. */
export function describePick(market: string, pick: string, home: string | null, away: string | null): string {
  if (market === '1x2') return pick === 'home' ? (home ?? 'Home') : pick === 'away' ? (away ?? 'Away') : 'Draw';
  if (market === 'double_chance') return ({ home_draw: '1X', home_away: '12', draw_away: 'X2' } as Record<string, string>)[pick] ?? pick;
  if (market === 'btts') return pick === 'yes' ? 'GG' : 'NG';
  if (market === 'odd_even') return pick === 'odd' ? 'Odd' : 'Even';
  if (market.startsWith('over_under_')) return `${pick === 'over' ? 'Over' : 'Under'} ${market.slice(11).replace('_', '.')}`;
  if (market === 'total_goals') return pick === '7_plus' ? '7+ goals' : `${pick.replace('_', '-')} goals`;
  if (market === 'correct_score') return pick === 'other' ? 'Any other score' : pick.replace('_', '-');
  return pick;
}

/** The design's short market names ("1 x 2", "Double Chance", "GG/NG", ...). */
export function marketLabel(market: string, fallback?: string): string {
  if (market === '1x2') return '1 x 2';
  if (market === 'double_chance') return 'Double Chance';
  if (market === 'btts') return 'GG/NG';
  if (market === 'odd_even') return 'Odd/Even';
  if (market.startsWith('over_under_')) return `Over/Under ${market.slice(11).replace('_', '.')}`;
  if (market === 'total_goals') return 'Total Goals';
  if (market === 'correct_score') return 'Correct Score';
  return fallback ?? market;
}
