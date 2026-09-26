import type { PgFantasyLeagueRepo } from '@crash/wallet/fantasy-league-repo-pg';
import type { LeagueTemplate } from '@crash/wallet/fantasy-league-repo';
import type { FantasyProvider } from './provider.js';

/**
 * One pass: open next gameweek's leagues, then settle every open league whose
 * gameweek FPL has marked final (finished + data_checked). Safe to run
 * repeatedly — creation is idempotent and settle() is exactly-once.
 */
export async function runFantasyTick(
  repo: PgFantasyLeagueRepo,
  provider: FantasyProvider,
  templates: readonly LeagueTemplate[],
  nowMs = Date.now(),
): Promise<void> {
  const { gameweeks } = await provider.catalog();

  const upcoming = gameweeks
    .filter((g) => Date.parse(g.deadline) > nowMs)
    .sort((a, b) => a.id - b.id)[0];
  if (upcoming) {
    const created = await repo.ensureLeagues(templates, upcoming.id, upcoming.deadline);
    if (created > 0) console.log(`[fantasy-league] opened ${created} league(s) for ${upcoming.name}`);
  }

  for (const league of await repo.listOpen()) {
    const gw = gameweeks.find((g) => g.id === league.gameweek);
    if (!gw?.finished || !gw.dataChecked) continue;
    const out = await repo.settle(league.leagueId, await provider.livePoints(gw.id));
    if (out.status !== 'already-final') {
      console.log(`[fantasy-league] ${out.status} ${league.leagueId}: ${out.entrants} entrants, paid ${out.paidMinor}, rake ${out.rakeMinor}`);
    }
  }
}

/** Runs a tick now and every `intervalMs`; overlapping ticks are skipped. Returns a stop function. */
export function startFantasyScheduler(
  repo: PgFantasyLeagueRepo,
  provider: FantasyProvider,
  templates: readonly LeagueTemplate[],
  intervalMs = 5 * 60_000,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runFantasyTick(repo, provider, templates);
    } catch (err) {
      console.error('[fantasy-league] scheduler tick failed (will retry):', err);
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(handle);
}
