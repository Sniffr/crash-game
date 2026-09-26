import type { PgFantasyLeagueRepo } from '@crash/wallet/fantasy-league-repo-pg';
import type { FantasyEntry, FantasyLeague } from '@crash/wallet/fantasy-league-repo';
import { payouts, rankByPoints, splitPool, squadPoints } from '@crash/shared/fantasy';
import type { FantasyProvider } from './provider.js';

export type LeaguePhase = 'open' | 'live' | 'settled' | 'cancelled';

export function phaseOf(league: FantasyLeague, nowMs: number): LeaguePhase {
  if (league.status !== 'open') return league.status;
  return Date.parse(league.deadline) > nowMs ? 'open' : 'live';
}

export interface Standing {
  rank: number | null;
  playerId: string;
  username: string;
  points: number | null;
  /** Final payout once settled; projected from the live table while live. */
  payoutMinor: number | null;
}

/**
 * The league table. Before the deadline nobody has points yet (entries only);
 * during the gameweek it's computed from FPL live points; once settled it's
 * the stored final result.
 */
export async function standings(
  league: FantasyLeague,
  repo: PgFantasyLeagueRepo,
  provider: FantasyProvider,
  nowMs: number,
): Promise<Standing[]> {
  const entries = await repo.entries(league.leagueId);
  const phase = phaseOf(league, nowMs);
  if (phase === 'open' || phase === 'cancelled') {
    return entries.map((e) => ({ rank: null, playerId: e.playerId, username: e.username, points: null, payoutMinor: null }));
  }
  if (phase === 'settled') {
    return entries.map((e) => ({ rank: e.finalRank, playerId: e.playerId, username: e.username, points: e.points, payoutMinor: e.payoutMinor }));
  }
  return liveTable(league, entries, await provider.livePoints(league.gameweek));
}

function liveTable(league: FantasyLeague, entries: FantasyEntry[], live: Awaited<ReturnType<FantasyProvider['livePoints']>>): Standing[] {
  const byId = new Map(entries.map((e) => [e.playerId, e]));
  const ranked = rankByPoints(entries.map((e) => ({ key: e.playerId, points: squadPoints(e.squad, live) })));
  const { prizePoolMinor } = splitPool(league.entryFeeMinor, entries.length, league.rakeBps);
  const { byKey } = payouts(ranked, prizePoolMinor, league.payoutBps);
  return ranked.map((r) => ({
    rank: r.rank,
    playerId: r.key,
    username: byId.get(r.key)!.username,
    points: r.points,
    payoutMinor: byKey.get(r.key) ?? 0,
  }));
}
