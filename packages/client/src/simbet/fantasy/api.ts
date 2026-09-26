import { useEffect, useState } from 'react';
import { splitPool, type SquadPick, type SquadPlayer } from '@crash/shared/fantasy';
import { api } from '../lib/api';

// Types mirror /api/fantasy-league (the same API Game Hub's Fantasy League uses).

export type Phase = 'open' | 'live' | 'settled' | 'cancelled';

export interface League {
  leagueId: string;
  name: string;
  blurb: string;
  gameweek: number;
  deadline: string;
  entryFeeMinor: number;
  currency: string;
  rakeBps: number;
  payoutBps: number[];
  poolMinor: number | null;
  rakeMinor: number | null;
  memberCount: number;
  phase: Phase;
}
export interface Standing { rank: number | null; playerId: string; username: string; points: number | null; payoutMinor: number | null }
export interface LeagueDetail { league: League; standings: Standing[]; total: number }
export interface MyEntry { squad: SquadPick; rank: number | null; points: number | null; payoutMinor: number | null }
export interface CatalogPlayer extends SquadPlayer { name: string; status: string; news: string }
export interface Catalog {
  gameweek: { id: number; name: string; deadline: string } | null;
  teams: Array<{ id: number; name: string; shortName: string }>;
  players: CatalogPlayer[];
}
export interface FplLink { entryId: number; teamName: string; managerName: string }

/** Prize pool after the house fee: the settled figure, else projected from entries so far. */
export function prizePool(l: League): number {
  if (l.poolMinor != null && l.rakeMinor != null) return l.poolMinor - l.rakeMinor;
  return splitPool(l.entryFeeMinor, l.memberCount, l.rakeBps).prizePoolMinor;
}

export function useLeagues(reload = 0): { leagues: League[] | null; error: boolean } {
  const [leagues, setLeagues] = useState<League[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ items: League[] }>('/api/fantasy-league/leagues')
      .then((r) => { if (live) { setLeagues(r.items); setError(false); } })
      .catch(() => { if (live) { setLeagues([]); setError(true); } });
    return () => { live = false; };
  }, [reload]);
  return { leagues, error };
}

let catalogCache: Catalog | null = null;
export function useCatalog(): Catalog | null {
  const [catalog, setCatalog] = useState(catalogCache);
  useEffect(() => {
    if (catalogCache) return;
    api<Catalog>('/api/fantasy-league/catalog').then((c) => { catalogCache = c; setCatalog(c); }).catch(() => {});
  }, []);
  return catalog;
}

export function useJoined(token: string | null, reload = 0): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!token) { setIds(new Set()); return; }
    let live = true;
    api<{ leagueIds: string[] }>('/api/fantasy-league/my-leagues', { auth: true })
      .then((r) => { if (live) setIds(new Set(r.leagueIds)); })
      .catch(() => {});
    return () => { live = false; };
  }, [token, reload]);
  return ids;
}
