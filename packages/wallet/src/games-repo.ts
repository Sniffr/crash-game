import type { Database } from 'better-sqlite3';
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

function assertRtp(rtp: unknown): asserts rtp is number {
  if (typeof rtp !== 'number' || !Number.isFinite(rtp) || rtp <= 0 || rtp > 1) {
    throw new InvalidGameError('rtp must be a fraction in (0, 1] (e.g. 0.97)');
  }
}

function assertGameType(t: unknown): asserts t is GameType {
  if (typeof t !== 'string' || !GAME_TYPES.includes(t as GameType)) {
    throw new InvalidGameError(`gameType must be one of ${GAME_TYPES.join(', ')}`);
  }
}

/** The Creator's `Theme` carries its own `gameType`; if present it MUST match. */
function assertThemeMatchesType(theme: unknown, gameType: GameType): void {
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

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface GameRow {
  game_id: string;
  name: string;
  game_type: string;
  rtp: number;
  theme_json: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface OperatorGameRow {
  operator_id: string;
  game_id: string;
  enabled: number;
  rtp_override: number | null;
}

function rowToGame(row: GameRow): Game {
  return {
    gameId: row.game_id,
    name: row.name,
    gameType: row.game_type as GameType,
    rtp: row.rtp,
    theme: JSON.parse(row.theme_json),
    status: row.status as GameStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOperatorGame(row: OperatorGameRow): OperatorGame {
  return {
    operatorId: row.operator_id,
    gameId: row.game_id,
    enabled: row.enabled === 1,
    rtpOverride: row.rtp_override,
  };
}

// ---------------------------------------------------------------------------
// GamesRepo
// ---------------------------------------------------------------------------

export class GamesRepo {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this._ensureSchema();
  }

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        game_id     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        game_type   TEXT NOT NULL,
        rtp         REAL NOT NULL,
        theme_json  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operator_games (
        operator_id  TEXT NOT NULL,
        game_id      TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        rtp_override REAL,
        PRIMARY KEY (operator_id, game_id)
      );
    `);
  }

  // ── games ────────────────────────────────────────────────────────────────

  create(input: GameCreate): Game {
    assertGameType(input.gameType);
    assertRtp(input.rtp);
    assertThemeMatchesType(input.theme, input.gameType);

    const now = Math.floor(Date.now() / 1000);
    try {
      this.db
        .prepare(
          `INSERT INTO games (game_id, name, game_type, rtp, theme_json, status, created_at, updated_at)
           VALUES (@game_id, @name, @game_type, @rtp, @theme_json, @status, @created_at, @updated_at)`,
        )
        .run({
          game_id: input.gameId,
          name: input.name,
          game_type: input.gameType,
          rtp: input.rtp,
          theme_json: JSON.stringify(input.theme),
          status: input.status ?? 'active',
          created_at: now,
          updated_at: now,
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed')) throw new DuplicateGameIdError(input.gameId);
      throw err;
    }
    return this.getById(input.gameId) as Game;
  }

  getById(gameId: string): Game | null {
    const row = this.db.prepare(`SELECT * FROM games WHERE game_id = ?`).get(gameId) as
      | GameRow
      | undefined;
    return row ? rowToGame(row) : null;
  }

  list(opts?: { includeArchived?: boolean }): Game[] {
    const rows = (
      opts?.includeArchived
        ? this.db.prepare(`SELECT * FROM games ORDER BY created_at ASC`).all()
        : this.db.prepare(`SELECT * FROM games WHERE status = 'active' ORDER BY created_at ASC`).all()
    ) as GameRow[];
    return rows.map(rowToGame);
  }

  update(gameId: string, patch: GameUpdate): Game {
    const existing = this.getById(gameId);
    if (!existing) throw new GameNotFoundError(gameId);

    const nextType = patch.gameType ?? existing.gameType;
    if (patch.gameType !== undefined) assertGameType(patch.gameType);
    if (patch.rtp !== undefined) assertRtp(patch.rtp);
    if (patch.theme !== undefined) assertThemeMatchesType(patch.theme, nextType);
    else if (patch.gameType !== undefined) assertThemeMatchesType(existing.theme, nextType);

    const now = Math.floor(Date.now() / 1000);
    const set: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { game_id: gameId, updated_at: now };

    if (patch.name !== undefined) { set.push('name = @name'); params['name'] = patch.name; }
    if (patch.gameType !== undefined) { set.push('game_type = @game_type'); params['game_type'] = patch.gameType; }
    if (patch.rtp !== undefined) { set.push('rtp = @rtp'); params['rtp'] = patch.rtp; }
    if (patch.theme !== undefined) { set.push('theme_json = @theme_json'); params['theme_json'] = JSON.stringify(patch.theme); }
    if (patch.status !== undefined) { set.push('status = @status'); params['status'] = patch.status; }

    this.db.prepare(`UPDATE games SET ${set.join(', ')} WHERE game_id = @game_id`).run(params);
    return this.getById(gameId) as Game;
  }

  // ── operator_games ─────────────────────────────────────────────────────────

  /** Upsert an operator↔game row. Absent fields keep their current value (or default on insert). */
  setOperatorGame(
    operatorId: string,
    gameId: string,
    patch: { enabled?: boolean; rtpOverride?: number | null },
  ): OperatorGame {
    if (patch.rtpOverride != null) assertRtp(patch.rtpOverride);
    const existing = this.getOperatorGame(operatorId, gameId);
    const enabled = patch.enabled ?? existing?.enabled ?? true;
    const rtpOverride =
      patch.rtpOverride !== undefined ? patch.rtpOverride : (existing?.rtpOverride ?? null);

    this.db
      .prepare(
        `INSERT INTO operator_games (operator_id, game_id, enabled, rtp_override)
         VALUES (@operator_id, @game_id, @enabled, @rtp_override)
         ON CONFLICT(operator_id, game_id) DO UPDATE SET
           enabled = @enabled, rtp_override = @rtp_override`,
      )
      .run({
        operator_id: operatorId,
        game_id: gameId,
        enabled: enabled ? 1 : 0,
        rtp_override: rtpOverride,
      });
    return this.getOperatorGame(operatorId, gameId) as OperatorGame;
  }

  getOperatorGame(operatorId: string, gameId: string): OperatorGame | null {
    const row = this.db
      .prepare(`SELECT * FROM operator_games WHERE operator_id = ? AND game_id = ?`)
      .get(operatorId, gameId) as OperatorGameRow | undefined;
    return row ? rowToOperatorGame(row) : null;
  }

  listOperatorGames(operatorId: string): OperatorGame[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_games WHERE operator_id = ? ORDER BY game_id ASC`)
      .all(operatorId) as OperatorGameRow[];
    return rows.map(rowToOperatorGame);
  }

  /**
   * Effective RTP (as a fraction) for a game launched by an operator, or null
   * if the game does not exist or is not enabled for that operator.
   * = operator_games.rtp_override ?? games.rtp
   */
  effectiveRtp(operatorId: string, gameId: string): number | null {
    const game = this.getById(gameId);
    if (!game || game.status !== 'active') return null;
    const link = this.getOperatorGame(operatorId, gameId);
    if (!link || !link.enabled) return null;
    return link.rtpOverride ?? game.rtp;
  }
}
