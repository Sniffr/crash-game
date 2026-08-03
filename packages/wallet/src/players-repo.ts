import type { Pool } from './pg.js';

// ---------------------------------------------------------------------------
// Player accounts repository (Wave A — personal lobby).
//
// Backed by the Postgres `players` table (bootstrapped in pg.ts):
//   player_id uuid pk, username text unique, password_hash text, created_at timestamptz
//
// Balance lives in wallet_ledger (see WalletLedger); this repo owns identity only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class DuplicateUsernameError extends Error {
  readonly username: string;
  constructor(username: string) {
    super(`A player with username '${username}' already exists`);
    this.name = 'DuplicateUsernameError';
    this.username = username;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public player shape — never carries the password hash. */
export interface Player {
  playerId: string;
  username: string;
  createdAt: string;
}

/** Player + hash — only returned by getByUsernameWithHash (login path). */
export interface PlayerWithHash extends Player {
  passwordHash: string;
}

// ---------------------------------------------------------------------------
// Internal row shape (as returned by pg)
// ---------------------------------------------------------------------------

interface PlayerRow {
  player_id: string;
  username: string;
  password_hash: string;
  created_at: Date | string;
}

function rowToPlayer(row: PlayerRow): Player {
  return {
    playerId: row.player_id,
    username: row.username,
    // timestamptz comes back as a Date from pg — normalise to an ISO string.
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// Postgres unique-violation SQLSTATE.
const PG_UNIQUE_VIOLATION = '23505';

// ---------------------------------------------------------------------------
// PlayersRepo
// ---------------------------------------------------------------------------

export class PlayersRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Insert a new player. Throws DuplicateUsernameError on unique violation. */
  async create(username: string, passwordHash: string): Promise<Player> {
    try {
      const { rows } = await this.pool.query<PlayerRow>(
        `INSERT INTO players (username, password_hash)
         VALUES ($1, $2)
         RETURNING player_id, username, password_hash, created_at`,
        [username, passwordHash],
      );
      return rowToPlayer(rows[0]!);
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new DuplicateUsernameError(username);
      }
      throw err;
    }
  }

  /** Fetch a player by username (public shape, no hash). */
  async getByUsername(username: string): Promise<Player | null> {
    const { rows } = await this.pool.query<PlayerRow>(
      `SELECT player_id, username, password_hash, created_at
       FROM players WHERE username = $1`,
      [username],
    );
    return rows[0] ? rowToPlayer(rows[0]) : null;
  }

  /** Fetch a player by username, including the password hash (login path only). */
  async getByUsernameWithHash(username: string): Promise<PlayerWithHash | null> {
    const { rows } = await this.pool.query<PlayerRow>(
      `SELECT player_id, username, password_hash, created_at
       FROM players WHERE username = $1`,
      [username],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...rowToPlayer(row), passwordHash: row.password_hash };
  }

  /** Fetch a player by id (public shape, no hash). */
  async getById(playerId: string): Promise<Player | null> {
    const { rows } = await this.pool.query<PlayerRow>(
      `SELECT player_id, username, password_hash, created_at
       FROM players WHERE player_id = $1`,
      [playerId],
    );
    return rows[0] ? rowToPlayer(rows[0]) : null;
  }
}
