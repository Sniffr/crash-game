import { type RoundHistoryEntry } from '@crash/shared/types';

const roundHistory: RoundHistoryEntry[] = [];

export function pushHistory(entry: RoundHistoryEntry): void {
  roundHistory.push(entry);
  if (roundHistory.length > 200) roundHistory.shift();
}

export function getRecentHistory(count = 30): RoundHistoryEntry[] {
  return roundHistory.slice(-count);
}

export function getAllHistory(): RoundHistoryEntry[] {
  return roundHistory;
}
