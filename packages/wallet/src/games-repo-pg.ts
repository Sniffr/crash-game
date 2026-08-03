import type { Pool } from 'pg';
import type { Game, GameCreate, GameStatus, GameType, GameUpdate, OperatorGame } from './types.js';
import {
  DuplicateGameIdError,
  GameNotFoundError,
  assertGameRtp,
  assertGameType,
  assertThemeMatchesType,
} from './games-repo.js';

// ---------------------------------------------------------------------------
// Postgres-backed games catalogue (Wave A). Same public surface as the SQLite
// GamesRepo but async, plus a synchronous in-memory snapshot of active games
// that the hot round loop reads without awaiting. Mutations refresh the snapshot.
// ---------------------------------------------------------------------------

interface GameRow {
  game_id: string;
  name: string;
  game_type: string;
  rtp: number;
  theme_json: unknown; // jsonb → already-parsed object
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface OperatorGameRow {
  operator_id: string;
  game_id: string;
  enabled: boolean;
  rtp_override: number | null;
}

const epoch = (d: Date): number => Math.floor(new Date(d).getTime() / 1000);

function rowToGame(r: GameRow): Game {
  return {
    gameId: r.game_id,
    name: r.name,
    gameType: r.game_type as GameType,
    rtp: r.rtp,
    theme: r.theme_json,
    status: r.status as GameStatus,
    createdAt: epoch(r.created_at),
    updatedAt: epoch(r.updated_at),
  };
}

function rowToOperatorGame(r: OperatorGameRow): OperatorGame {
  return { operatorId: r.operator_id, gameId: r.game_id, enabled: r.enabled, rtpOverride: r.rtp_override };
}

export class PgGamesRepo {
  private readonly pool: Pool;
  private _snapshot: Game[] = [];

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Synchronous snapshot of active games — read by the hot round loop. */
  snapshot(): Game[] {
    return this._snapshot;
  }

  /** Reload the active-games snapshot from Postgres. Call on boot + after mutations. */
  async refreshSnapshot(): Promise<void> {
    this._snapshot = await this.list();
  }

  async create(input: GameCreate): Promise<Game> {
    assertGameType(input.gameType);
    assertGameRtp(input.rtp);
    assertThemeMatchesType(input.theme, input.gameType);
    try {
      const { rows } = await this.pool.query<GameRow>(
        `INSERT INTO games (game_id, name, game_type, rtp, theme_json, status)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [input.gameId, input.name, input.gameType, input.rtp, JSON.stringify(input.theme), input.status ?? 'active'],
      );
      await this.refreshSnapshot();
      return rowToGame(rows[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate key') && msg.includes('games_pkey')) throw new DuplicateGameIdError(input.gameId);
      throw err;
    }
  }

  async getById(gameId: string): Promise<Game | null> {
    const { rows } = await this.pool.query<GameRow>(`SELECT * FROM games WHERE game_id = $1`, [gameId]);
    return rows[0] ? rowToGame(rows[0]) : null;
  }

  async list(opts?: { includeArchived?: boolean }): Promise<Game[]> {
    const sql = opts?.includeArchived
      ? `SELECT * FROM games ORDER BY created_at ASC`
      : `SELECT * FROM games WHERE status = 'active' ORDER BY created_at ASC`;
    const { rows } = await this.pool.query<GameRow>(sql);
    return rows.map(rowToGame);
  }

  async update(gameId: string, patch: GameUpdate): Promise<Game> {
    const existing = await this.getById(gameId);
    if (!existing) throw new GameNotFoundError(gameId);

    const nextType = patch.gameType ?? existing.gameType;
    if (patch.gameType !== undefined) assertGameType(patch.gameType);
    if (patch.rtp !== undefined) assertGameRtp(patch.rtp);
    if (patch.theme !== undefined) assertThemeMatchesType(patch.theme, nextType);
    else if (patch.gameType !== undefined) assertThemeMatchesType(existing.theme, nextType);

    const set: string[] = ['updated_at = now()'];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.gameType !== undefined) add('game_type', patch.gameType);
    if (patch.rtp !== undefined) add('rtp', patch.rtp);
    if (patch.theme !== undefined) add('theme_json', JSON.stringify(patch.theme));
    if (patch.status !== undefined) add('status', patch.status);
    vals.push(gameId);

    const { rows } = await this.pool.query<GameRow>(
      `UPDATE games SET ${set.join(', ')} WHERE game_id = $${vals.length} RETURNING *`,
      vals,
    );
    await this.refreshSnapshot();
    return rowToGame(rows[0]);
  }

  // ── operator_games ─────────────────────────────────────────────────────────

  async setOperatorGame(
    operatorId: string,
    gameId: string,
    patch: { enabled?: boolean; rtpOverride?: number | null },
  ): Promise<OperatorGame> {
    if (patch.rtpOverride != null) assertGameRtp(patch.rtpOverride);
    const existing = await this.getOperatorGame(operatorId, gameId);
    const enabled = patch.enabled ?? existing?.enabled ?? true;
    const rtpOverride = patch.rtpOverride !== undefined ? patch.rtpOverride : (existing?.rtpOverride ?? null);

    const { rows } = await this.pool.query<OperatorGameRow>(
      `INSERT INTO operator_games (operator_id, game_id, enabled, rtp_override)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (operator_id, game_id) DO UPDATE SET enabled = $3, rtp_override = $4
       RETURNING *`,
      [operatorId, gameId, enabled, rtpOverride],
    );
    return rowToOperatorGame(rows[0]);
  }

  async getOperatorGame(operatorId: string, gameId: string): Promise<OperatorGame | null> {
    const { rows } = await this.pool.query<OperatorGameRow>(
      `SELECT * FROM operator_games WHERE operator_id = $1 AND game_id = $2`,
      [operatorId, gameId],
    );
    return rows[0] ? rowToOperatorGame(rows[0]) : null;
  }

  async listOperatorGames(operatorId: string): Promise<OperatorGame[]> {
    const { rows } = await this.pool.query<OperatorGameRow>(
      `SELECT * FROM operator_games WHERE operator_id = $1 ORDER BY game_id ASC`,
      [operatorId],
    );
    return rows.map(rowToOperatorGame);
  }

  /** Effective RTP (fraction) for an operator's game, or null if unknown/archived/disabled. */
  async effectiveRtp(operatorId: string, gameId: string): Promise<number | null> {
    const game = await this.getById(gameId);
    if (!game || game.status !== 'active') return null;
    const link = await this.getOperatorGame(operatorId, gameId);
    if (!link || !link.enabled) return null;
    return link.rtpOverride ?? game.rtp;
  }
}
