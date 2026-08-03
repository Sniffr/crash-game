import pg from 'pg';

// ---------------------------------------------------------------------------
// Postgres connection pool (casino DB) + Wave A schema bootstrap.
//
// Single shared pg.Pool built from DATABASE_URL. Repos take the pool (or a
// PoolClient inside a transaction). Schema is bootstrapped idempotently on boot
// — the same "no migration framework" stance the SQLite code uses.
// ---------------------------------------------------------------------------

export type { Pool, PoolClient } from 'pg';

let _pool: pg.Pool | null = null;

/** Lazily build (once) the shared pool from DATABASE_URL. */
export function getPool(): pg.Pool {
  if (_pool) return _pool;
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — cannot connect to the casino Postgres database');
  }
  _pool = new pg.Pool({ connectionString, max: 10 });
  _pool.on('error', (err) => console.error('[pg] idle client error:', err));
  return _pool;
}

/** For tests: swap in a pool pointed at a throwaway database. */
export function setPoolForTesting(pool: pg.Pool | null): void {
  _pool = pool;
}

/**
 * Create the Wave A tables if absent. Idempotent — safe to run every boot.
 * (Wave B adds the ported B2B ledger tables here.)
 */
export async function bootstrapCasinoSchema(pool: pg.Pool = getPool()): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

    CREATE TABLE IF NOT EXISTS games (
      game_id     text PRIMARY KEY,
      name        text NOT NULL,
      game_type   text NOT NULL,                       -- 'sprite' | 'gif'
      rtp         real NOT NULL,                        -- fraction (0,1]
      theme_json  jsonb NOT NULL,
      status      text NOT NULL DEFAULT 'active',       -- 'active' | 'archived'
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CHECK (game_type IN ('sprite','gif')),
      CHECK (rtp > 0 AND rtp <= 1),
      CHECK (status IN ('active','archived'))
    );

    CREATE TABLE IF NOT EXISTS operator_games (
      operator_id  text NOT NULL,
      game_id      text NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
      enabled      boolean NOT NULL DEFAULT true,
      rtp_override real,
      PRIMARY KEY (operator_id, game_id),
      CHECK (rtp_override IS NULL OR (rtp_override > 0 AND rtp_override <= 1))
    );

    CREATE TABLE IF NOT EXISTS game_assets (
      game_id      text NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
      asset_key    text NOT NULL,                       -- 'gif.loading','sprite.flying',…
      url          text NOT NULL,                       -- public Contabo URL
      content_type text,
      bytes        integer,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (game_id, asset_key)
    );

    CREATE TABLE IF NOT EXISTS players (
      player_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username      text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id           bigserial PRIMARY KEY,
      player_id    uuid NOT NULL REFERENCES players(player_id),
      currency     text NOT NULL DEFAULT 'USD',
      amount_minor bigint NOT NULL,                     -- +credit / -debit
      kind         text NOT NULL,                       -- 'deposit'|'bet'|'win'|'adjust'
      ref          text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (kind IN ('deposit','bet','win','adjust'))
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_player ON wallet_ledger(player_id, currency);
  `);
}
