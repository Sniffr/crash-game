import { moneyShort } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { Button } from '../components/ui';
import type { League } from './api';

/** The design's league card: photo, entry-fee chip, name, members, Join Now. */
export function LeagueCard({ league, entered }: { league: League; entered: boolean }) {
  const href = `/fantasy/${encodeURIComponent(league.leagueId)}`;
  const open = league.phase === 'open';
  return (
    <article className="flex flex-col rounded-2xl border-2 border-sb-primary bg-sb-surface p-3 sm:p-4">
      <Link to={href} className="block overflow-hidden rounded-2xl" tabIndex={-1} aria-hidden>
        <img src="/simbet/league-card.jpg" alt="" loading="lazy" className="aspect-[16/9] w-full object-cover transition-transform duration-300 hover:scale-[1.03]" />
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-sb-primary px-2.5 py-0.5 text-[12px] font-semibold text-sb-accent sb-tabular">
          {moneyShort(league.entryFeeMinor, league.currency)}
        </span>
        <span className="text-[12px] text-sb-muted">GW {league.gameweek}</span>
        {!open && <span className="text-[12px] font-semibold text-sb-muted">{league.phase === 'live' ? '· Live' : league.phase === 'settled' ? '· Final' : '· Cancelled'}</span>}
      </div>
      <h3 className="mt-2 font-sb-display text-[22px] leading-tight sm:text-[24px]">
        <Link to={href} className="hover:text-sb-accent">{league.name}</Link>
      </h3>
      <p className="mt-1 text-[14px] text-sb-muted">{league.memberCount.toLocaleString()} {league.memberCount === 1 ? 'Member' : 'Members'}</p>
      <div className="mt-auto pt-4">
        {open && !entered
          ? <Button size="lg" className="w-full" onClick={() => navigate(`${href}?join=1`)}>Join Now</Button>
          : <Button size="lg" variant="outline" className="w-full" onClick={() => navigate(href)}>{entered ? 'You’re in · View' : 'View Table'}</Button>}
      </div>
    </article>
  );
}

export function LeagueCardSkeleton() {
  return (
    <div className="rounded-2xl border-2 border-sb-line bg-sb-surface p-4" aria-hidden>
      <div className="aspect-[16/9] animate-pulse rounded-2xl bg-sb-surface2" />
      <div className="mt-4 h-5 w-20 animate-pulse rounded-full bg-sb-surface2" />
      <div className="mt-3 h-7 w-3/4 animate-pulse rounded bg-sb-surface2" />
      <div className="mt-6 h-12 animate-pulse rounded-full bg-sb-surface2" />
    </div>
  );
}
