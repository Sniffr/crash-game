import { navigate, useLocation } from '../lib/router';
import { ArrowLeft } from '../components/glyphs';
import { FixturesBoard } from '../matches/Board';
import { Betslip } from '../matches/Betslip';

/** Simulated Matches: every league on the board, with the slip as a sticky column. */
export default function Matches() {
  const { query } = useLocation();
  const league = query.get('league');
  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-3 pt-4 sm:px-[22px] sm:pt-6 lg:grid-cols-[minmax(0,1fr)_355px]">
      <div className="min-w-0">
        {league && (
          <div className="mb-4 flex items-center gap-2">
            <button type="button" onClick={() => navigate('/matches')} aria-label="All leagues"
              className="grid h-9 w-9 place-items-center rounded-full hover:bg-sb-surface2"><ArrowLeft className="h-5 w-5" /></button>
            <h1 className="min-w-0 truncate font-sb-display text-[26px] sm:text-[32px]">{league}</h1>
          </div>
        )}
        <FixturesBoard league={league} />
      </div>
      <aside className="hidden lg:block" aria-label="Betslip">
        <div className="sticky top-[104px]"><Betslip /></div>
      </aside>
    </div>
  );
}
