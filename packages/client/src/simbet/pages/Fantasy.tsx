import { useEffect, useMemo, useState } from 'react';
import {
  BUDGET_TENTHS, CAPTAIN_MULTIPLIER, MAX_PER_CLUB, MIN_ENTRANTS, POSITIONS, SQUAD_SIZE, formatMillions, payouts,
} from '@crash/shared/fantasy';
import { api } from '../lib/api';
import { fromMinor, money, moneyShort } from '../lib/format';
import { navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Empty, PageHeader, SectionTitle, Spinner } from '../components/ui';
import { Ball, Check, Headset, Ranking, Star, Users } from '../components/glyphs';
import {
  prizePool, useCatalog, useJoined, useLeagues, type CatalogPlayer, type League, type LeagueDetail, type MyEntry, type Standing,
} from '../fantasy/api';
import { LeagueCard, LeagueCardSkeleton } from '../fantasy/LeagueCard';
import { PositionTag, SquadBuilder } from '../fantasy/SquadBuilder';

// ─── Landing ─────────────────────────────────────────────────────────────────

export function FantasyHome() {
  const { token } = useSession();
  const { leagues, error } = useLeagues();
  const joined = useJoined(token);
  const catalog = useCatalog();
  const open = leagues?.filter((l) => l.phase === 'open') ?? null;
  const past = leagues?.filter((l) => l.phase !== 'open') ?? [];
  // The landing leaderboard follows the most recent league that has a table.
  const featured = past.find((l) => l.phase === 'live') ?? past.find((l) => l.phase === 'settled') ?? null;

  return (
    <div className="mx-auto max-w-[1440px] px-3 pt-4 sm:px-[22px] sm:pt-6">
      <div className="relative h-[200px] overflow-hidden rounded-2xl sm:h-[300px]">
        <img src="/simbet/hero-fantasy.jpg" alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
          <h1 className="font-sb-display text-[38px] leading-none text-white sm:text-[48px]">Fantasy Sports</h1>
          <p className="mt-2 max-w-xl text-[14px] text-white/90">
            Join a league and build your dream team in the ultimate fantasy football experience — real Premier League players, official FPL points.
          </p>
          {catalog?.gameweek && (
            <p className="mt-2 text-[13px] text-white/80">{catalog.gameweek.name} deadline: {new Date(catalog.gameweek.deadline).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
          )}
        </div>
      </div>

      <section className="mt-8" aria-labelledby="sb-rec">
        <SectionTitle icon={<Ranking className="h-7 w-7" />}><span id="sb-rec">Recommended Leagues</span></SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {open == null ? [0, 1, 2].map((i) => <LeagueCardSkeleton key={i} />)
            : open.length === 0
              ? <div className="col-span-full"><Empty title={error ? 'Leagues didn’t load' : 'No leagues open right now'} body="Leagues for the next Premier League gameweek open automatically." /></div>
              : open.map((l) => <LeagueCard key={l.leagueId} league={l} entered={joined.has(l.leagueId)} />)}
        </div>
      </section>

      {featured && <FeaturedLeaderboard league={featured} />}

      {past.length > 0 && (
        <section className="mt-10" aria-labelledby="sb-past">
          <SectionTitle icon={<Star className="h-7 w-7" />}><span id="sb-past">Live &amp; Results</span></SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {past.slice(0, 6).map((l) => <LeagueCard key={l.leagueId} league={l} entered={joined.has(l.leagueId)} />)}
          </div>
        </section>
      )}

      <HowToPlay />
    </div>
  );
}

function FeaturedLeaderboard({ league }: { league: League }) {
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  useEffect(() => {
    api<LeagueDetail>(`/api/fantasy-league/leagues/${encodeURIComponent(league.leagueId)}`).then(setDetail).catch(() => {});
  }, [league.leagueId]);
  if (!detail || detail.standings.length === 0) return null;
  return (
    <section className="mt-10" aria-labelledby="sb-lb">
      <SectionTitle icon={<Ranking className="h-7 w-7" />}
        action={<Button variant="outline" size="sm" onClick={() => navigate(`/fantasy/${encodeURIComponent(league.leagueId)}`)}>Open league</Button>}>
        <span id="sb-lb">Leaderboard</span>
      </SectionTitle>
      <p className="-mt-2 mb-3 text-[14px] text-sb-muted">{league.name} · Gameweek {league.gameweek} · {league.phase === 'live' ? 'live points' : 'final'}</p>
      <StandingsTable rows={detail.standings.slice(0, 10)} currency={league.currency} />
    </section>
  );
}

// ─── League details ──────────────────────────────────────────────────────────

export function FantasyLeaguePage({ leagueId }: { leagueId: string }) {
  const { token, requireAuth, setSupportOpen } = useSession();
  const { query } = useLocation();
  const catalog = useCatalog();
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [entry, setEntry] = useState<MyEntry | null>(null);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    let live = true;
    api<LeagueDetail>(`/api/fantasy-league/leagues/${encodeURIComponent(leagueId)}`)
      .then((d) => { if (live) setDetail(d); })
      .catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [leagueId, reload]);

  useEffect(() => {
    if (!token) { setEntry(null); return; }
    let live = true;
    api<{ entry: MyEntry | null }>(`/api/fantasy-league/leagues/${encodeURIComponent(leagueId)}/me`, { auth: true })
      .then((r) => { if (live) setEntry(r.entry); })
      .catch(() => {});
    return () => { live = false; };
  }, [leagueId, token, reload]);

  const league = detail?.league;
  const startJoin = () => requireAuth(() => setBuilding(true));

  // Arriving from a "Join Now" button: open the builder once the league loads.
  useEffect(() => {
    if (query.get('join') === '1' && league?.phase === 'open') {
      navigate(`/fantasy/${encodeURIComponent(leagueId)}`, { replace: true, scroll: false });
      startJoin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league?.phase]);

  if (missing) return <div className="mx-auto max-w-[900px] px-4 py-16"><Empty title="League not found" body="It may have been removed." action={<Button onClick={() => navigate('/fantasy')}>All leagues</Button>} /></div>;
  if (!detail || !league) return <div className="grid place-items-center py-32"><Spinner className="h-10 w-10 text-sb-primary" /></div>;

  const pool = prizePool(league);
  const ranked = league.phase === 'live' || league.phase === 'settled';
  const places = Math.max(1, Math.min(league.payoutBps.length, league.memberCount || league.payoutBps.length));
  const placeAmounts = payouts(Array.from({ length: places }, (_, i) => ({ key: String(i), rank: i + 1 })), pool, league.payoutBps).byKey;
  const status = league.phase === 'open'
    ? `Locks ${new Date(league.deadline).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : league.phase === 'live' ? 'Live — points update as matches are played'
    : league.phase === 'settled' ? 'Final — prizes paid to winners’ wallets'
    : 'Cancelled — too few entries, every entry fee was refunded';

  return (
    <>
      <PageHeader title={league.name} back="/fantasy" icon={<Star className="h-7 w-7 shrink-0" />}
        action={entry ? <Badge tone="won">You’re in</Badge>
          : league.phase === 'open' ? <Button variant="outline" onClick={startJoin}>Join Group · {moneyShort(league.entryFeeMinor, league.currency)}</Button> : null} />

      <div className="mx-auto max-w-[1396px] px-3 pt-6 sm:px-[22px]">
        <p className="mb-4 text-[14px] text-sb-muted">Gameweek {league.gameweek} · Premier League · {status}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <StatCard label="Members" value={league.memberCount.toLocaleString()}
            foot={`Entry fee ${moneyShort(league.entryFeeMinor, league.currency)}${league.phase === 'open' && league.memberCount < MIN_ENTRANTS ? ` · needs ${MIN_ENTRANTS}+ entries to run` : ''}`} />
          <StatCard label={league.currency} value={fromMinor(pool, league.currency).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            foot={`Prize pool · after a ${league.rakeBps / 100}% fee · ${league.payoutBps.map((b, i) => `${ordinal(i + 1)} ${b / 100}%${placeAmounts.has(String(i)) && league.memberCount >= MIN_ENTRANTS ? ` (${moneyShort(placeAmounts.get(String(i))!, league.currency)})` : ''}`).join(' · ')}`} />
        </div>

        {entry && (
          <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl border border-sb-line bg-sb-surface p-4 text-center">
            <div><p className="text-[13px] text-sb-muted">Your rank</p><p className="font-sb-display text-[26px] text-sb-accent">{entry.rank ? `${ordinal(entry.rank)}` : '—'}</p></div>
            <div><p className="text-[13px] text-sb-muted">Your points</p><p className="font-sb-display text-[26px]">{entry.points ?? '—'}</p></div>
            <div><p className="text-[13px] text-sb-muted">{league.phase === 'settled' ? 'You won' : 'Projected prize'}</p><p className="font-sb-display text-[26px] text-sb-success">{money(entry.payoutMinor ?? 0, league.currency)}</p></div>
          </div>
        )}

        {entry && catalog && <YourXi entry={entry} players={catalog.players} clubs={new Map(catalog.teams.map((t) => [t.id, t.shortName]))} />}

        <section className="mt-10" aria-labelledby="sb-lb2">
          <SectionTitle icon={<Ranking className="h-7 w-7" />}><span id="sb-lb2">{ranked ? 'Leaderboard' : 'Entries so far'}</span></SectionTitle>
          {detail.standings.length === 0 ? (
            <Empty title="No one has entered yet" body="Be the first — pick your XI before the deadline."
              action={league.phase === 'open' ? <Button onClick={startJoin}>Join Now</Button> : undefined} />
          ) : (
            <>
              {ranked && <Podium rows={detail.standings.slice(0, 3)} />}
              <StandingsTable rows={detail.standings} currency={league.currency} showRank={ranked} />
              {detail.total > detail.standings.length && <p className="mt-2 text-[13px] text-sb-muted">Showing the top {detail.standings.length} of {detail.total}.</p>}
            </>
          )}
        </section>

        <HowToPlay onContact={() => requireAuth(() => setSupportOpen(true))} />
      </div>

      {building && (
        <SquadBuilder league={league} catalog={catalog} onClose={() => setBuilding(false)}
          onJoined={() => { setBuilding(false); setReload((r) => r + 1); }} />
      )}
    </>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

function StatCard({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-xl border border-sb-line bg-sb-surface p-5">
      <p className="text-[14px] text-sb-muted">{label}</p>
      <p className="mt-6 font-sb-form text-[44px] font-medium leading-none text-sb-accent sb-tabular sm:text-[56px]">{value}</p>
      <p className="mt-3 text-[13px] text-sb-text">{foot}</p>
    </div>
  );
}

function Medal({ rank }: { rank: number | null }) {
  const tone = rank === 1 ? 'bg-amber-400 text-amber-950' : rank === 2 ? 'bg-slate-300 text-slate-800' : rank === 3 ? 'bg-orange-400 text-orange-950' : '';
  if (!tone) return <span className="inline-block w-7 text-center sb-tabular">{rank ?? '–'}</span>;
  return <span className={`grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold ring-2 ring-white/60 ${tone}`} aria-label={`Rank ${rank}`}>{rank}</span>;
}

function Podium({ rows }: { rows: Standing[] }) {
  const order = [rows[1], rows[0], rows[2]];
  return (
    <div className="mb-4 grid grid-cols-3 items-end gap-3">
      {order.map((r, i) => r ? (
        <div key={r.playerId} className={`rounded-xl bg-sb-surface p-3 sm:p-5 ${i === 1 ? 'border-2 border-sb-primary pb-6 sm:pb-10' : 'border border-sb-line'}`}>
          <Medal rank={r.rank} />
          <p className="mt-4 truncate font-sb-form text-[16px] font-medium text-sb-accent sm:mt-8 sm:text-[26px]">{r.username}</p>
          <p className="mt-1 text-[13px] sb-tabular">{(r.points ?? 0).toLocaleString()} points</p>
        </div>
      ) : <div key={i} />)}
    </div>
  );
}

function StandingsTable({ rows, currency, showRank = true }: { rows: Standing[]; currency: string; showRank?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-sb-line bg-sb-surface p-2 sm:p-3">
      <table className="w-full text-left text-[14px]">
        <thead>
          <tr className="bg-sb-surface2 text-sb-text">
            <th className="w-16 rounded-l-md px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Player</th>
            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Prize</th>
            <th className="rounded-r-md px-3 py-2 text-right font-medium">Points</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.playerId}>
              <td className="px-3 py-2.5">{showRank ? <Medal rank={r.rank} /> : <span className="sb-tabular">{i + 1}</span>}</td>
              <td className="truncate px-3 py-2.5">{r.username}</td>
              <td className="hidden px-3 py-2.5 text-right text-sb-success sb-tabular sm:table-cell">{r.payoutMinor ? moneyShort(r.payoutMinor, currency) : ''}</td>
              <td className="px-3 py-2.5 text-right text-sb-accent sb-tabular">{r.points != null ? r.points.toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function YourXi({ entry, players, clubs }: { entry: MyEntry; players: CatalogPlayer[]; clubs: Map<number, string> }) {
  const xi = useMemo(() => {
    const byId = new Map(players.map((p) => [p.id, p]));
    return entry.squad.playerIds.map((id) => byId.get(id)).filter((p): p is CatalogPlayer => !!p)
      .sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));
  }, [entry, players]);
  return (
    <section className="mt-8" aria-labelledby="sb-xi">
      <SectionTitle icon={<Users className="h-7 w-7" />}><span id="sb-xi">Your XI</span></SectionTitle>
      <div className="grid gap-px overflow-hidden rounded-xl border border-sb-line bg-sb-line sm:grid-cols-2">
        {xi.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 bg-sb-surface px-4 py-2.5">
            <PositionTag position={p.position} />
            <span className="min-w-0 flex-1 truncate text-[14px]">{p.name}</span>
            <span className="text-[12px] text-sb-muted">{clubs.get(p.teamId)}</span>
            {p.id === entry.squad.captainId && <Badge tone="active">C</Badge>}
            {p.id === entry.squad.viceCaptainId && <Badge tone="neutral">V</Badge>}
          </div>
        ))}
      </div>
    </section>
  );
}

function HowToPlay({ onContact }: { onContact?: () => void }) {
  const steps = [
    { icon: Ball, title: 'Choose your team', body: `Pick ${SQUAD_SIZE} real Premier League players within ${formatMillions(BUDGET_TENTHS)}, max ${MAX_PER_CLUB} from one club. Link your FPL team to import your XI.` },
    { icon: Users, title: 'Compete with peers', body: `Your captain scores ${CAPTAIN_MULTIPLIER}×. The table runs live on official Fantasy Premier League points through the gameweek.` },
    { icon: Ranking, title: 'Win the bounty', body: 'When the gameweek is final, the top three split the prize pool — winnings land straight in your wallet.' },
  ];
  return (
    <section className="mt-12 rounded-2xl bg-sb-primary px-4 py-10 text-white sm:px-10 sm:py-14" aria-labelledby="sb-how">
      <h2 id="sb-how" className="text-center font-sb-display text-[32px] sm:text-[40px]">How to play</h2>
      <p className="mt-2 text-center text-[15px] text-white/85">Everything you need to know to enter a league.</p>
      <div className="mt-10 grid gap-8 md:grid-cols-3">
        {steps.map((s) => (
          <div key={s.title} className="text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white/15"><s.icon className="h-6 w-6" /></span>
            <h3 className="mt-4 text-[18px] font-semibold">{s.title}</h3>
            <p className="mx-auto mt-2 max-w-xs text-[14px] leading-relaxed text-white/85">{s.body}</p>
          </div>
        ))}
      </div>
      {onContact && (
        <div className="mx-auto mt-10 max-w-[860px] rounded-2xl bg-sb-surface px-6 py-8 text-center text-sb-text">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-sb-primary/10 text-sb-accent"><Headset className="h-6 w-6" /></span>
          <h3 className="mt-3 font-sb-display text-[28px] text-sb-accent">Still have questions?</h3>
          <p className="mt-1 text-[15px]">Can’t find the answer you’re looking for? Please chat to our friendly team.</p>
          <Button variant="outline" className="mt-5" onClick={onContact}>Get in Touch</Button>
        </div>
      )}
      <ul className="mx-auto mt-8 flex max-w-[860px] flex-wrap justify-center gap-x-6 gap-y-2 text-[13px] text-white/80">
        <li className="flex items-center gap-1.5"><Check className="h-4 w-4" /> Official FPL points</li>
        <li className="flex items-center gap-1.5"><Check className="h-4 w-4" /> Needs {MIN_ENTRANTS}+ entries or fees are refunded</li>
        <li className="flex items-center gap-1.5"><Check className="h-4 w-4" /> Top 3 paid automatically</li>
      </ul>
    </section>
  );
}
