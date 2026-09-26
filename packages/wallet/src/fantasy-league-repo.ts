import type { SquadPick } from '@crash/shared/fantasy';

export class LeagueNotFoundError extends Error {
  constructor(leagueId: string) {
    super(`Fantasy league '${leagueId}' not found`);
    this.name = 'LeagueNotFoundError';
  }
}

/** The league is past its deadline, settled, or cancelled — no more entries. */
export class LeagueLockedError extends Error {
  constructor(leagueId: string) {
    super(`Fantasy league '${leagueId}' is no longer accepting entries`);
    this.name = 'LeagueLockedError';
  }
}

export class AlreadyJoinedError extends Error {
  constructor(leagueId: string, playerId: string) {
    super(`Player '${playerId}' has already joined league '${leagueId}'`);
    this.name = 'AlreadyJoinedError';
  }
}

export type LeagueStatus = 'open' | 'settled' | 'cancelled';

export interface FantasyLeague {
  leagueId: string;
  name: string;
  blurb: string;
  gameweek: number;
  /** ISO timestamp — entries close here. */
  deadline: string;
  entryFeeMinor: number;
  currency: string;
  rakeBps: number;
  payoutBps: number[];
  status: LeagueStatus;
  poolMinor: number | null;
  rakeMinor: number | null;
  settledAt: string | null;
  memberCount: number;
}

/** A recurring league, instantiated once per gameweek. */
export interface LeagueTemplate {
  templateId: string;
  name: string;
  blurb: string;
  entryFeeMinor: number;
  currency: string;
}

export interface FantasyEntry {
  leagueId: string;
  playerId: string;
  username: string;
  squad: SquadPick;
  /** Null until the league settles. */
  points: number | null;
  finalRank: number | null;
  payoutMinor: number | null;
  joinedAt: string;
}

export interface FplLink {
  entryId: number;
  teamName: string;
  managerName: string;
  linkedAt: string;
}

export interface SettlementOutcome {
  leagueId: string;
  status: 'settled' | 'cancelled' | 'already-final';
  entrants: number;
  poolMinor: number;
  rakeMinor: number;
  paidMinor: number;
}
