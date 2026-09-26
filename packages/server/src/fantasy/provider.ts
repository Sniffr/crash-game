import type { LivePlayerPoints, Position, SquadPick } from '@crash/shared/fantasy';

export interface CatalogPlayer {
  id: number;
  name: string;
  teamId: number;
  position: Position;
  /** Tenths of £1m. */
  cost: number;
  /** FPL availability: a=available, d=doubtful, i=injured, s=suspended, u=unavailable, n=not in squad. */
  status: string;
  news: string;
  canSelect: boolean;
}

export interface CatalogTeam {
  id: number;
  name: string;
  shortName: string;
}

export interface Gameweek {
  id: number;
  name: string;
  deadline: string;
  finished: boolean;
  dataChecked: boolean;
  isCurrent: boolean;
  isNext: boolean;
}

export interface FantasyCatalog {
  players: CatalogPlayer[];
  teams: CatalogTeam[];
  gameweeks: Gameweek[];
}

export interface FplEntry {
  entryId: number;
  teamName: string;
  managerName: string;
  /** Latest gameweek the team has picks for, or null before its first. */
  currentGameweek: number | null;
}

/** Source of fantasy football data. Only the FPL implementation exists today. */
export interface FantasyProvider {
  catalog(): Promise<FantasyCatalog>;
  livePoints(gameweek: number): Promise<Map<number, LivePlayerPoints>>;
  entry(entryId: number): Promise<FplEntry | null>;
  /** The team's starting XI + armbands for a gameweek, or null if not visible. */
  entryXi(entryId: number, gameweek: number): Promise<SquadPick | null>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
