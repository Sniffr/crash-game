/**
 * Fantasy League rules — pure, dependency-free, shared by server and client.
 *
 * Classic fantasy football on real Premier League data (official FPL points):
 * an 11-man XI in a legal formation, under a budget, max 3 per club, with a
 * captain whose points count double. A league is one gameweek; after it is
 * final the pool (minus rake) is split across the top of the leaderboard.
 */

export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD';

export const POSITIONS: readonly Position[] = ['GKP', 'DEF', 'MID', 'FWD'];

export const SQUAD_SIZE = 11;

/** In FPL's units: tenths of £1m, so 850 = £85.0m. */
export const BUDGET_TENTHS = 850;

export const MAX_PER_CLUB = 3;

/** FPL's own starting-XI formation limits. */
export const POSITION_LIMITS: Record<Position, { min: number; max: number }> = {
  GKP: { min: 1, max: 1 },
  DEF: { min: 3, max: 5 },
  MID: { min: 2, max: 5 },
  FWD: { min: 1, max: 3 },
};

export const CAPTAIN_MULTIPLIER = 2;

/** Share of the prize pool per paid place, in basis points. */
export const DEFAULT_PAYOUT_BPS: readonly number[] = [5000, 3000, 2000];

export const DEFAULT_RAKE_BPS = 1000;

/** A league with fewer entrants than this is cancelled and refunded. */
export const MIN_ENTRANTS = 2;

export interface SquadPlayer {
  id: number;
  position: Position;
  teamId: number;
  /** Tenths of £1m. */
  cost: number;
}

export interface SquadPick {
  playerIds: number[];
  captainId: number;
  viceCaptainId: number;
}

export interface LivePlayerPoints {
  points: number;
  minutes: number;
}

export function formatMillions(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

export function squadCost(playerIds: readonly number[], pool: ReadonlyMap<number, SquadPlayer>): number {
  return playerIds.reduce((a, id) => a + (pool.get(id)?.cost ?? 0), 0);
}

/**
 * Every rule the pick breaks, as player-facing sentences. Empty means valid.
 * `pool` must contain only players that may currently be selected.
 */
export function squadIssues(pick: SquadPick, pool: ReadonlyMap<number, SquadPlayer>): string[] {
  const issues: string[] = [];
  const ids = pick.playerIds;

  if (new Set(ids).size !== ids.length) issues.push('A player can only be picked once.');
  if (ids.length !== SQUAD_SIZE) issues.push(`Pick exactly ${SQUAD_SIZE} players (you have ${ids.length}).`);

  const players = ids.map((id) => pool.get(id));
  if (players.some((p) => !p)) {
    issues.push('One or more of your players is no longer available.');
    return issues;
  }
  const picked = players as SquadPlayer[];

  for (const pos of POSITIONS) {
    const n = picked.filter((p) => p.position === pos).length;
    const { min, max } = POSITION_LIMITS[pos];
    if (n < min) issues.push(`Pick at least ${min} ${pos}.`);
    if (n > max) issues.push(`Pick at most ${max} ${pos}.`);
  }

  const perClub = new Map<number, number>();
  for (const p of picked) perClub.set(p.teamId, (perClub.get(p.teamId) ?? 0) + 1);
  if ([...perClub.values()].some((n) => n > MAX_PER_CLUB)) {
    issues.push(`No more than ${MAX_PER_CLUB} players from one club.`);
  }

  const cost = squadCost(ids, pool);
  if (cost > BUDGET_TENTHS) issues.push(`Over budget by ${formatMillions(cost - BUDGET_TENTHS)}.`);

  if (!ids.includes(pick.captainId)) issues.push('Choose a captain from your XI.');
  if (!ids.includes(pick.viceCaptainId)) issues.push('Choose a vice-captain from your XI.');
  if (pick.captainId === pick.viceCaptainId) issues.push('Captain and vice-captain must be different players.');

  return issues;
}

/** Gameweek points: the XI's total, with the captain doubled — or the vice-captain if the captain didn't play (FPL's rule). */
export function squadPoints(pick: SquadPick, live: ReadonlyMap<number, LivePlayerPoints>): number {
  let total = 0;
  for (const id of pick.playerIds) total += live.get(id)?.points ?? 0;
  const captainPlayed = (live.get(pick.captainId)?.minutes ?? 0) > 0;
  const doubled = captainPlayed ? pick.captainId : pick.viceCaptainId;
  return total + (live.get(doubled)?.points ?? 0) * (CAPTAIN_MULTIPLIER - 1);
}

/** Standard competition ranking (1, 2, 2, 4). Input order is kept within a tie. */
export function rankByPoints<T extends { points: number }>(entries: readonly T[]): Array<T & { rank: number }> {
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.points - a.e.points || a.i - b.i);
  let rank = 0;
  return sorted.map(({ e }, idx) => {
    if (idx === 0 || e.points !== sorted[idx - 1]!.e.points) rank = idx + 1;
    return { ...e, rank };
  });
}

export interface PoolSplit {
  poolMinor: number;
  rakeMinor: number;
  prizePoolMinor: number;
}

export function splitPool(entryFeeMinor: number, entrants: number, rakeBps: number): PoolSplit {
  const poolMinor = entryFeeMinor * entrants;
  const rakeMinor = Math.floor((poolMinor * rakeBps) / 10_000);
  return { poolMinor, rakeMinor, prizePoolMinor: poolMinor - rakeMinor };
}

/**
 * Split the prize pool by rank. Tied entries share the combined shares of the
 * places they occupy; with fewer entrants than paid places the unclaimed
 * shares are spread pro rata. Each payout rounds down — `dustMinor` is what's
 * left over (a few minor units at most).
 */
export function payouts(
  ranked: ReadonlyArray<{ key: string; rank: number }>,
  prizePoolMinor: number,
  payoutBps: readonly number[],
): { byKey: Map<string, number>; dustMinor: number } {
  const byKey = new Map<string, number>();
  const places = Math.min(payoutBps.length, ranked.length);
  const shares = payoutBps.slice(0, places);
  const totalShare = shares.reduce((a, s) => a + s, 0);
  if (places === 0 || totalShare <= 0) return { byKey, dustMinor: prizePoolMinor };

  const groups = new Map<number, string[]>();
  for (const r of ranked) {
    const g = groups.get(r.rank);
    if (g) g.push(r.key);
    else groups.set(r.rank, [r.key]);
  }

  let paid = 0;
  for (const [rank, keys] of groups) {
    const first = rank - 1;
    let groupShare = 0;
    for (let p = first; p < first + keys.length && p < places; p++) groupShare += shares[p]!;
    if (groupShare === 0) continue;
    const each = Math.floor((prizePoolMinor * groupShare) / (totalShare * keys.length));
    for (const k of keys) {
      byKey.set(k, each);
      paid += each;
    }
  }
  return { byKey, dustMinor: prizePoolMinor - paid };
}
