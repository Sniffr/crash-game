import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clock, dayHeader, dayKey } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { Button, Dropdown, Empty, Tabs } from '../components/ui';
import { CaretDown, CaretRight, ChevronDown, ChevronRight, StatsBadge } from '../components/glyphs';
import {
  DATE_OPTIONS, gameCode, inRange, marketOf, pickLabel, useBoard, useFixtures, useMarkets,
  type DateRange, type Fixture, type LeagueGroup, type MarketBlock, type Option,
} from './data';
import { useSlip } from './slip';

type MarketTab = 'main' | 'dc' | 'ggng' | 'oddeven';
const MARKET_TABS: ReadonlyArray<{ key: MarketTab; label: string }> = [
  { key: 'main', label: '3 Way & O/U' },
  { key: 'dc', label: 'Double Chance' },
  { key: 'ggng', label: 'GG/NG' },
  { key: 'oddeven', label: 'Odd / Even' },
];
/** Market + column headings for the single-market tabs. */
const TAB_MARKET: Record<Exclude<MarketTab, 'main'>, { market: string; heads: Record<string, string> }> = {
  dc: { market: 'double_chance', heads: { home_draw: '1X', home_away: '12', draw_away: 'X2' } },
  ggng: { market: 'btts', heads: { yes: 'GG', no: 'NG' } },
  oddeven: { market: 'odd_even', heads: { odd: 'Odd', even: 'Even' } },
};
const OU_LINES = ['0_5', '1_5', '2_5', '3_5', '4_5'];
const PAGE = 20;

/**
 * The fixtures board: Highlights/Upcoming + date filter, then one accordion
 * per league. Home shows the first few leagues; Simulated Matches shows all.
 */
export function FixturesBoard({ limitLeagues, league = null, afterFirst }: {
  limitLeagues?: number;
  league?: string | null;
  /** Rendered after the first league (the design's deposit banner). */
  afterFirst?: ReactNode;
}) {
  const { fixtures, error, retry } = useFixtures();
  const [order, setOrder] = useState<'highlights' | 'upcoming'>('highlights');
  const [range, setRange] = useState<DateRange | null>(null);

  // Start on "Today" like the design, unless nothing is left today.
  useEffect(() => {
    if (range == null && fixtures) {
      const now = Date.now();
      setRange(fixtures.some((f) => new Date(f.kickoff).getTime() > now && inRange(f.kickoff, 'today', now)) ? 'today' : 'all');
    }
  }, [fixtures, range]);

  const groups = useBoard(fixtures, range ?? 'all', order, league);
  const shown = limitLeagues ? groups?.slice(0, limitLeagues) : groups;

  return (
    <section aria-label="Matches">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Tabs size="sm" items={[{ key: 'highlights', label: 'Highlights' }, { key: 'upcoming', label: 'Upcoming' }] as const} value={order} onChange={setOrder} />
        <Dropdown label="Match dates" value={range} options={DATE_OPTIONS} onChange={setRange} />
      </div>

      {error && !fixtures ? (
        <Empty title="Matches didn’t load" body={error} action={<Button onClick={retry}>Try again</Button>} />
      ) : !shown ? (
        <BoardSkeleton />
      ) : shown.length === 0 ? (
        <Empty title="No matches in this window"
          body={league ? `Nothing left to play in ${league} for these dates.` : 'Try another date range — new fixtures arrive with every odds update.'}
          action={range !== 'all' ? <Button variant="outline" onClick={() => setRange('all')}>Show all dates</Button> : undefined} />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((g, i) => (
            <Fragment key={g.league}>
              <LeagueAccordion group={g} defaultOpen={i === 0 || !!league} showViewAll={!league} />
              {i === 0 && afterFirst}
            </Fragment>
          ))}
          {limitLeagues && groups && groups.length > limitLeagues && (
            <Button variant="outline" className="mx-auto mt-2" onClick={() => navigate('/matches')}>
              All {groups.length} leagues <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-sb-line bg-sb-surface p-4">
          <div className="h-7 w-56 animate-pulse rounded bg-sb-surface2" />
          {i === 0 && Array.from({ length: 4 }, (_, j) => <div key={j} className="mt-4 h-10 animate-pulse rounded bg-sb-surface2" />)}
        </div>
      ))}
    </div>
  );
}

// ─── League accordion ────────────────────────────────────────────────────────

function LeagueAccordion({ group, defaultOpen, showViewAll }: { group: LeagueGroup; defaultOpen: boolean; showViewAll: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<MarketTab>('main');
  const [limit, setLimit] = useState(PAGE);
  const visible = group.fixtures.slice(0, limit);
  const count = group.fixtures.length;

  return (
    <div className={`rounded-xl border bg-sb-surface ${open ? 'border-sb-primary' : 'border-sb-primary/60'}`}>
      <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-sb-surface2 text-sb-accent">
            {open ? <CaretDown className="h-5 w-5" /> : <CaretRight className="h-5 w-5" />}
          </span>
          <span className="truncate font-sb-display text-[20px] leading-tight text-sb-text sm:text-[26px]">{group.league}</span>
          <span className="shrink-0 rounded-sm bg-sb-primary px-1.5 text-[12px] font-semibold leading-5 text-white sb-tabular">{count}</span>
        </button>
        {showViewAll && (
          <Link to={`/matches?league=${encodeURIComponent(group.league)}`}
            className="flex shrink-0 items-center gap-1.5 font-sb-display text-[14px] uppercase text-sb-muted hover:text-sb-accent">
            <span className="hidden sm:inline">View all</span>
            <span className="hidden rounded-sm bg-sb-primary px-1.5 font-sb-body text-[12px] font-semibold leading-5 text-white sb-tabular sm:inline">{count}</span>
            <ChevronRight className="h-4 w-4 text-sb-text" />
          </Link>
        )}
      </div>

      {open && (
        <div className="px-2 pb-3 sm:px-4">
          <Tabs size="sm" className="mb-2 border-b border-sb-line" items={MARKET_TABS} value={tab} onChange={setTab} />
          <LeagueFixtures fixtures={visible} tab={tab} />
          {count > limit && (
            <button type="button" onClick={() => setLimit((l) => l + PAGE)}
              className="mx-auto mt-3 flex items-center gap-1 text-[14px] font-semibold text-sb-accent hover:underline">
              Show more matches ({count - limit}) <ChevronDown className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LeagueFixtures({ fixtures, tab }: { fixtures: Fixture[]; tab: MarketTab }) {
  const ids = useMemo(() => fixtures.map((f) => f.eventId), [fixtures]);
  const markets = useMarkets(ids);
  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; items: Fixture[] }> = [];
    for (const f of fixtures) {
      const k = dayKey(f.kickoff);
      const last = out[out.length - 1];
      if (last?.key === k) last.items.push(f); else out.push({ key: k, label: dayHeader(f.kickoff), items: [f] });
    }
    return out;
  }, [fixtures]);

  return (
    <div className="flex flex-col gap-2">
      {days.map((d) => (
        <div key={d.key}>
          <DayHeader label={d.label} tab={tab} />
          <ul className="divide-y divide-sb-line">
            {d.items.map((fx) => <FixtureRow key={fx.eventId} fx={fx} tab={tab} markets={markets} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

// Column widths shared by the day header and the rows so headings sit over cells.
const CELL = 'min-w-0 flex-1 md:w-[60px] md:flex-none';
const HEAD = 'w-[60px]';
/** Cells share the row on phones; groups grow by how many cells they hold. */
const GROW: Record<number, string> = { 1: 'flex-1', 2: 'flex-[2]', 3: 'flex-[3]' };

function DayHeader({ label, tab }: { label: string; tab: MarketTab }) {
  const heads = tab === 'main' ? null : Object.values(TAB_MARKET[tab].heads);
  return (
    <div className="flex items-center gap-3 rounded-sm bg-sb-surface2 px-2 py-2 text-[14px] text-sb-text sm:px-4 sm:text-[16px]">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <div className="hidden items-center gap-4 text-center text-sb-muted md:flex">
        {tab === 'main' ? (
          <>
            <div className="flex">{['1', 'X', '2'].map((h) => <span key={h} className={HEAD}>{h}</span>)}</div>
            <div className="flex">{['Goals', 'Over', 'Under'].map((h) => <span key={h} className={HEAD}>{h}</span>)}</div>
          </>
        ) : (
          <div className="flex">{heads!.map((h) => <span key={h} className={HEAD}>{h}</span>)}</div>
        )}
        <span className="w-[52px]" />
      </div>
    </div>
  );
}

// ─── Fixture row ─────────────────────────────────────────────────────────────

function FixtureRow({ fx, tab, markets }: { fx: Fixture; tab: MarketTab; markets: Map<string, MarketBlock[]> }) {
  const [line, setLine] = useState('2_5');
  const [more, setMore] = useState(false);
  const priced = markets.get(fx.eventId);
  const main = marketOf(fx, markets, '1x2');
  const ou = marketOf(fx, markets, `over_under_${line}`);
  const shownMarkets = tab === 'main' ? ['1x2', `over_under_${line}`] : [TAB_MARKET[tab].market];
  const extra = priced ? priced.filter((m) => !shownMarkets.includes(m.market)) : null;
  const extraCount = extra?.reduce((n, m) => n + m.options.length, 0);

  return (
    <li className="py-2.5">
      <div className="flex flex-col gap-2 px-2 sm:px-4 md:flex-row md:items-center md:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="w-12 shrink-0 text-[12px] leading-tight text-sb-muted sm:w-14">
            <div className="text-sb-text sb-tabular">{clock(fx.kickoff)}</div>
            <div className="sb-tabular">{gameCode(fx.eventId)}</div>
          </div>
          <div className="min-w-0 flex-1 text-[15px] leading-snug text-sb-text sm:text-[16px]">
            <div className="truncate">{fx.home}</div>
            <div className="truncate">{fx.away}</div>
          </div>
          <span title="Simulated on real odds — provably fair" className="shrink-0 text-sb-accent"><StatsBadge className="h-4 w-4" /></span>
        </div>

        <div className="flex w-full items-center gap-2 sm:gap-3 md:w-auto md:gap-4">
          {tab === 'main' ? (
            <>
              <OddsGroup fx={fx} block={main} picks={['home', 'draw', 'away']} />
              <div className="flex flex-[3] overflow-hidden rounded-[4px] md:flex-none">
                <label className="sr-only" htmlFor={`ou-${fx.eventId}`}>Goals line</label>
                <span className={`relative flex h-9 items-center justify-center bg-sb-odds/20 text-[14px] text-sb-text ${CELL}`}>
                  {line.replace('_', '.')} <ChevronDown className="ml-0.5 h-3.5 w-3.5" />
                  <select id={`ou-${fx.eventId}`} value={line} onChange={(e) => setLine(e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0">
                    {OU_LINES.map((l) => <option key={l} value={l}>{l.replace('_', '.')} goals</option>)}
                  </select>
                </span>
                <OddsGroup fx={fx} block={ou} picks={['over', 'under']} flat loading={!priced} />
              </div>
            </>
          ) : (
            <OddsGroup fx={fx} block={marketOf(fx, markets, TAB_MARKET[tab].market)} picks={Object.keys(TAB_MARKET[tab].heads)}
              loading={!priced} />
          )}
          <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} disabled={!extra || extra.length === 0}
            className="flex h-9 w-12 shrink-0 items-center justify-end gap-0.5 text-[14px] font-semibold text-sb-text disabled:opacity-40 md:w-[52px]">
            {extraCount != null ? `+${extraCount}` : '+'}
            <ChevronRight className={`h-4 w-4 transition-transform ${more ? 'rotate-90' : ''}`} />
          </button>
        </div>
      </div>

      {more && extra && (
        <div className="mx-2 mt-3 grid gap-3 rounded-lg bg-sb-surface2/60 p-3 sm:mx-4 lg:grid-cols-2">
          {extra.map((m) => (
            <div key={m.market}>
              <div className="mb-1.5 text-[13px] font-medium text-sb-muted">{m.name}</div>
              <div className={`grid gap-1.5 ${m.options.length > 6 ? 'grid-cols-4 sm:grid-cols-6' : m.options.length === 2 ? 'grid-cols-2' : m.options.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
                {m.options.map((o) => <OddsCell key={o.pick} fx={fx} block={m} option={o} labelled />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function OddsGroup({ fx, block, picks, flat = false, loading = false }: {
  fx: Fixture; block: MarketBlock | undefined; picks: string[]; flat?: boolean; loading?: boolean;
}) {
  return (
    <div className={`flex gap-px md:flex-none ${GROW[picks.length] ?? 'flex-1'} ${flat ? '' : 'overflow-hidden rounded-[4px]'}`}>
      {picks.map((pick) => {
        const option = block?.options.find((o) => o.pick === pick);
        return option && block
          ? <OddsCell key={pick} fx={fx} block={block} option={option} />
          : <span key={pick} className={`flex h-9 items-center justify-center bg-sb-odds/10 text-[13px] text-sb-muted ${CELL} ${loading ? 'animate-pulse' : ''}`}
              aria-label={loading ? 'Loading odds' : 'Not offered'}>{loading ? '' : '–'}</span>;
      })}
    </div>
  );
}

function OddsCell({ fx, block, option, labelled = false }: { fx: Fixture; block: MarketBlock; option: Option; labelled?: boolean }) {
  const slip = useSlip();
  const active = slip.isPicked(fx.eventId, block.market, option.pick);
  const add = () => slip.toggle({
    eventId: fx.eventId, league: fx.league, home: fx.home, away: fx.away, kickoff: fx.kickoff,
    market: block.market, marketName: block.name, pick: option.pick, label: pickLabel(fx, block.market, option), odds: option.odds,
  });
  return (
    <button type="button" onClick={add} aria-pressed={active}
      aria-label={`${fx.home} v ${fx.away}: ${block.name} ${option.label} at ${option.odds.toFixed(2)}`}
      className={`flex h-9 items-center justify-center gap-1.5 text-[14px] sb-tabular transition-colors ${labelled ? 'rounded-[4px] px-2' : CELL} ${
        active ? 'bg-sb-primary font-semibold text-white' : 'bg-sb-odds/20 text-sb-text hover:bg-sb-odds/35'}`}>
      {labelled && <span className={`truncate text-[12px] ${active ? 'text-white/80' : 'text-sb-muted'}`}>{option.label}</span>}
      {option.odds.toFixed(2)}
    </button>
  );
}
