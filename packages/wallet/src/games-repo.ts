import type {
  Game,
  GameCreate,
  GameStatus,
  GameType,
  GameUpdate,
  OperatorGame,
} from './types.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class DuplicateGameIdError extends Error {
  readonly gameId: string;
  constructor(gameId: string) {
    super(`Game with id '${gameId}' already exists`);
    this.name = 'DuplicateGameIdError';
    this.gameId = gameId;
  }
}

export class GameNotFoundError extends Error {
  constructor(gameId: string) {
    super(`Game '${gameId}' not found`);
    this.name = 'GameNotFoundError';
  }
}

export class InvalidGameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGameError';
  }
}

// ---------------------------------------------------------------------------
// Validation (shared by create + update)
// ---------------------------------------------------------------------------

const GAME_TYPES: readonly GameType[] = ['sprite', 'gif'];

/** Shared game validators — reused by the SQLite and Postgres repos. */
export function assertGameRtp(rtp: unknown): asserts rtp is number {
  if (typeof rtp !== 'number' || !Number.isFinite(rtp) || rtp <= 0 || rtp > 1) {
    throw new InvalidGameError('rtp must be a fraction in (0, 1] (e.g. 0.97)');
  }
}

export function assertGameType(t: unknown): asserts t is GameType {
  if (typeof t !== 'string' || !GAME_TYPES.includes(t as GameType)) {
    throw new InvalidGameError(`gameType must be one of ${GAME_TYPES.join(', ')}`);
  }
}

/** The Creator's `Theme` carries its own `gameType`; if present it MUST match. */
export function assertThemeMatchesType(theme: unknown, gameType: GameType): void {
  if (theme && typeof theme === 'object') {
    const themeType = (theme as { gameType?: unknown }).gameType;
    // Legacy sprite themes omit gameType entirely — treat as 'sprite'.
    const effective = themeType === undefined ? 'sprite' : themeType;
    if (effective !== gameType) {
      throw new InvalidGameError(
        `gameType '${gameType}' does not match theme.gameType '${String(themeType)}'`,
      );
    }
  }
}
