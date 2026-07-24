import { type RoundHistoryEntry } from '@crash/shared/types';

const DEFAULT_GAME_ID = 'galaxy-crash';

// Per-game round history. The default game's series is also the legacy shared
// history (single-game callers omit gameId and get 'galaxy-crash').
const byGame = new Map<string, RoundHistoryEntry[]>();

function seriesFor(gameId: string): RoundHistoryEntry[] {
  let s = byGame.get(gameId);
  if (!s) { s = []; byGame.set(gameId, s); }
  return s;
}

export function pushHistory(entry: RoundHistoryEntry, gameId: string = DEFAULT_GAME_ID): void {
  const s = seriesFor(gameId);
  s.push(entry);
  if (s.length > 200) s.shift();
}

export function getRecentHistory(count = 30, gameId: string = DEFAULT_GAME_ID): RoundHistoryEntry[] {
  return seriesFor(gameId).slice(-count);
}

export function getAllHistory(gameId: string = DEFAULT_GAME_ID): RoundHistoryEntry[] {
  return seriesFor(gameId);
}
