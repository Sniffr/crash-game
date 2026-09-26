import type { LivePlayerPoints, Position, SquadPick } from '@crash/shared/fantasy';
import {
  ProviderUnavailableError,
  type FantasyCatalog,
  type FantasyProvider,
  type FplEntry,
} from './provider.js';

/**
 * Official Fantasy Premier League public API (no key). Its terms don't license
 * commercial or real-money use — swap in a licensed FantasyProvider before
 * real-money leagues go live.
 */

const POSITION_BY_TYPE: Record<number, Position> = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

const CATALOG_TTL_MS = 10 * 60_000;
const LIVE_TTL_MS = 60_000;
const FINAL_LIVE_TTL_MS = 60 * 60_000;
const ENTRY_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

interface Cached<T> { at: number; ttl: number; value: T }

type FetchFn = typeof fetch;

export class FplProvider implements FantasyProvider {
  private readonly cache = new Map<string, Cached<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly baseUrl = process.env['FPL_BASE_URL'] ?? 'https://fantasy.premierleague.com/api',
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async catalog(): Promise<FantasyCatalog> {
    return this.cached('catalog', CATALOG_TTL_MS, async () => {
      const raw = await this.get<BootstrapResponse>('/bootstrap-static/');
      return {
        teams: raw.teams.map((t) => ({ id: t.id, name: t.name, shortName: t.short_name })),
        players: raw.elements
          .filter((e) => POSITION_BY_TYPE[e.element_type])
          .map((e) => ({
            id: e.id,
            name: e.web_name,
            teamId: e.team,
            position: POSITION_BY_TYPE[e.element_type]!,
            cost: e.now_cost,
            status: e.status,
            news: e.news ?? '',
            canSelect: e.can_select !== false && e.status !== 'u' && e.status !== 'n',
          })),
        gameweeks: raw.events.map((ev) => ({
          id: ev.id,
          name: ev.name,
          deadline: ev.deadline_time,
          finished: ev.finished,
          dataChecked: ev.data_checked,
          isCurrent: ev.is_current,
          isNext: ev.is_next,
        })),
      };
    });
  }

  async livePoints(gameweek: number): Promise<Map<number, LivePlayerPoints>> {
    const gw = (await this.catalog()).gameweeks.find((g) => g.id === gameweek);
    const ttl = gw?.finished && gw.dataChecked ? FINAL_LIVE_TTL_MS : LIVE_TTL_MS;
    return this.cached(`live:${gameweek}`, ttl, async () => {
      const raw = await this.get<LiveResponse>(`/event/${gameweek}/live/`);
      return new Map(raw.elements.map((e) => [e.id, { points: e.stats.total_points, minutes: e.stats.minutes }]));
    });
  }

  async entry(entryId: number): Promise<FplEntry | null> {
    return this.cached(`entry:${entryId}`, ENTRY_TTL_MS, async () => {
      const raw = await this.get<EntryResponse>(`/entry/${entryId}/`, true);
      if (!raw) return null;
      return {
        entryId: raw.id,
        teamName: raw.name,
        managerName: `${raw.player_first_name} ${raw.player_last_name}`.trim(),
        currentGameweek: raw.current_event ?? null,
      };
    });
  }

  async entryXi(entryId: number, gameweek: number): Promise<SquadPick | null> {
    return this.cached(`picks:${entryId}:${gameweek}`, ENTRY_TTL_MS, async () => {
      const raw = await this.get<PicksResponse>(`/entry/${entryId}/event/${gameweek}/picks/`, true);
      if (!raw) return null;
      const xi = raw.picks.filter((p) => p.position <= 11).sort((a, b) => a.position - b.position);
      const captain = raw.picks.find((p) => p.is_captain);
      const vice = raw.picks.find((p) => p.is_vice_captain);
      if (!captain || !vice) return null;
      return { playerIds: xi.map((p) => p.element), captainId: captain.element, viceCaptainId: vice.element };
    });
  }

  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && this.now() - hit.at < hit.ttl) return hit.value;
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = load()
      .then((value) => { this.cache.set(key, { at: this.now(), ttl, value }); return value; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async get<T>(path: string, nullOn404: true): Promise<T | null>;
  private async get<T>(path: string, nullOn404?: false): Promise<T>;
  private async get<T>(path: string, nullOn404 = false): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new ProviderUnavailableError(`FPL request failed: ${(err as Error).message}`);
    }
    if (res.status === 404 && nullOn404) return null;
    if (!res.ok) throw new ProviderUnavailableError(`FPL ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

interface BootstrapResponse {
  teams: Array<{ id: number; name: string; short_name: string }>;
  elements: Array<{
    id: number; web_name: string; team: number; element_type: number; now_cost: number;
    status: string; news?: string; can_select?: boolean;
  }>;
  events: Array<{
    id: number; name: string; deadline_time: string; finished: boolean; data_checked: boolean;
    is_current: boolean; is_next: boolean;
  }>;
}

interface LiveResponse {
  elements: Array<{ id: number; stats: { total_points: number; minutes: number } }>;
}

interface EntryResponse {
  id: number; name: string; player_first_name: string; player_last_name: string; current_event: number | null;
}

interface PicksResponse {
  picks: Array<{ element: number; position: number; is_captain: boolean; is_vice_captain: boolean }>;
}
