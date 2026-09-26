import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { Button, SectionTitle } from '../components/ui';
import { ChevronRight, Ranking } from '../components/glyphs';
import { FixturesBoard } from '../matches/Board';
import { useJoined, useLeagues } from '../fantasy/api';
import { LeagueCard, LeagueCardSkeleton } from '../fantasy/LeagueCard';

export default function Home() {
  const { token } = useSession();
  const { leagues } = useLeagues();
  const joined = useJoined(token);
  const recommended = leagues?.filter((l) => l.phase === 'open').slice(0, 3) ?? null;

  return (
    <div className="mx-auto max-w-[1440px] px-3 pt-4 sm:px-[22px] sm:pt-6">
      <div className="grid gap-3 md:grid-cols-2 md:gap-4">
        <Hero to="/matches" image="/simbet/hero-games.jpg" title="Simulated Games"
          body="Bet on simulated matches priced from real odds — every result is provably fair." />
        <Hero to="/fantasy" image="/simbet/hero-fantasy.jpg" title="Fantasy Sports"
          body="Join a league and build your dream team in the ultimate fantasy football experience." />
      </div>

      <div className="mt-6">
        <FixturesBoard limitLeagues={5} afterFirst={<DepositBanner />} />
      </div>

      <CashbackBanner />

      <section className="mt-8" aria-labelledby="sb-groups">
        <SectionTitle icon={<Ranking className="h-7 w-7" />}
          action={<Link to="/fantasy" className="flex items-center gap-1 font-sb-display text-[14px] uppercase text-sb-muted hover:text-sb-accent">View all <ChevronRight className="h-4 w-4" /></Link>}>
          <span id="sb-groups">Recommended Groups</span>
        </SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recommended == null
            ? [0, 1, 2].map((i) => <LeagueCardSkeleton key={i} />)
            : recommended.length === 0
              ? <p className="col-span-full rounded-xl border border-sb-line bg-sb-surface px-6 py-10 text-center text-[15px] text-sb-muted">
                  New fantasy leagues open automatically for each Premier League gameweek. <Link to="/fantasy" className="font-semibold text-sb-accent">See leagues</Link>
                </p>
              : recommended.map((l) => <LeagueCard key={l.leagueId} league={l} entered={joined.has(l.leagueId)} />)}
        </div>
      </section>
    </div>
  );
}

function Hero({ to, image, title, body }: { to: string; image: string; title: string; body: string }) {
  return (
    <Link to={to} className="group relative block h-[180px] overflow-hidden rounded-2xl sm:h-[240px] lg:h-[260px]">
      <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
        <h2 className="font-sb-display text-[34px] leading-none text-white sm:text-[44px]">{title}</h2>
        <p className="mt-1.5 max-w-[520px] text-[13px] text-white/90 sm:text-[14px]">{body}</p>
      </div>
    </Link>
  );
}

export function DepositBanner() {
  const { openModal } = useSession();
  return (
    <div className="relative flex min-h-[64px] items-center gap-4 overflow-hidden rounded-xl bg-[#111827] px-4 py-3 sm:px-5">
      <img src="/simbet/deposit-bg.jpg" alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />
      <p className="relative z-10 font-sb-display text-[20px] text-white sm:text-[22px]">Want to play? Deposit now</p>
      <div className="relative z-10 ml-auto hidden items-center gap-6 md:flex" aria-label="Pay with">
        <img src="/simbet/mpesa.png" alt="M-PESA" className="h-8 w-auto" />
        <img src="/simbet/airtel.png" alt="Airtel Money" className="h-7 w-auto" />
      </div>
      <Button size="sm" onClick={() => openModal('deposit')}
        className="relative z-10 ml-auto border-2 border-white !bg-sb-primary px-6 md:ml-10">Deposit</Button>
    </div>
  );
}

function CashbackBanner() {
  return (
    <div className="relative mt-6 flex flex-col gap-3 overflow-hidden rounded-xl bg-gradient-to-r from-[#5c59b9] via-[#112333] to-[#7c53a7] px-4 py-4 text-white sm:flex-row sm:items-center sm:gap-6 sm:px-5">
      <div className="min-w-0 sm:w-[220px]">
        <p className="font-sb-display text-[18px] text-sb-success">Earn rewards</p>
        <p className="text-[13px] text-white/85">from every single bet you place.</p>
      </div>
      <p className="font-sb-display text-[34px] leading-none sm:flex-1 sm:text-center sm:text-[44px]">Daily Cashback</p>
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold uppercase tracking-wide">Coming soon</span>
        <Button size="sm" onClick={() => navigate('/promotions')} className="border-2 border-white !bg-sb-primary px-5">Learn more</Button>
      </div>
    </div>
  );
}
