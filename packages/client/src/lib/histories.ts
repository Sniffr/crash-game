import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '../components/CrashRail';

export interface GameFeed {
  entries: HistoryEntry[];
  /** True only once we've watched this game's round number actually advance. */
  live: boolean;
}

const POLL_MS = 10_000;

/**
 * Polls the public /api/history feed for each game so the lobby can show what
 * the tables are really doing.
 *
 * "Live" is deliberately conservative: a non-empty series only proves rounds
 * happened at some point, so the pulsing dot is withheld until a poll observes
 * the round number move. Once seen, it sticks — a quiet stretch between rounds
 * shouldn't make the badge flicker.
 */
export function useHistories(gameIds: string[]): Record<string, GameFeed> {
  const [feeds, setFeeds] = useState<Record<string, GameFeed>>({});
  const lastRound = useRef<Record<string, number>>({});
  const key = gameIds.join(',');

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) return;
    let cancelled = false;

    const load = () => {
      ids.forEach(async (id) => {
        try {
          const res = await fetch(`/api/history?game=${encodeURIComponent(id)}`);
          if (!res.ok) return;
          const entries = (await res.json()) as HistoryEntry[];
          if (cancelled || !Array.isArray(entries) || entries.length === 0) return;

          const newest = entries[entries.length - 1]!.roundNumber;
          const advanced = lastRound.current[id] != null && lastRound.current[id] !== newest;
          lastRound.current[id] = newest;

          setFeeds((prev) => ({
            ...prev,
            [id]: { entries, live: advanced || (prev[id]?.live ?? false) },
          }));
        } catch {
          /* keep whatever we last had — a dropped poll shouldn't blank the rail */
        }
      });
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [key]);

  return feeds;
}
