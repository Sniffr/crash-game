import { GameConfig } from './types';

export const GAME_CONFIG: GameConfig = {
  rtp: 0.97,
  houseEdge: 0.03,
  maxMultiplier: 10000,
  minMultiplier: 1.0,
  bettingPhaseMs: 5000,
  resultPhaseMs: 3000,
};

export const SERVER_PORT = 3001;
export const CLIENT_PORT = 5173;

// ─── Session + economy ──────────────────────────────────────────────────────

/** Hard cap on a single bet, in credits. The server rejects anything larger. */
export const MAX_STAKE = 1000;

/** Token-bucket rate limit: max bets per session per minute. */
export const BETS_PER_MINUTE = 40;

/** Session TTL — refreshed on every bet/cashout so active sessions don't expire. */
export const SESSION_TTL_SEC = 60 * 60 * 24; // 24h

/** Max history entries persisted per session. List is trimmed on each write. */
export const HISTORY_LIMIT = 500;

/** Adjectives + nouns for generating friendly anonymous display names. */
export const ANON_ADJ = [
  'Lucky', 'Cosmic', 'Silver', 'Mystic', 'Stellar', 'Solar', 'Nebula', 'Quantum',
  'Crimson', 'Velvet', 'Lunar', 'Neon', 'Phantom', 'Rapid', 'Bold', 'Quiet',
];
export const ANON_NOUN = [
  'Falcon', 'Comet', 'Otter', 'Tiger', 'Rocket', 'Glider', 'Voyager', 'Drifter',
  'Phoenix', 'Heron', 'Lynx', 'Magpie', 'Astronaut', 'Pilot', 'Ranger', 'Nomad',
];
