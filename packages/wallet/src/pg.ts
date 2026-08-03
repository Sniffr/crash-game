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

    -- ── Wave B: B2B ledger + control plane (ported from SQLite) ──────────────
    CREATE TABLE IF NOT EXISTS operators (
      operator_id       text PRIMARY KEY,
      name              text NOT NULL,
      wallet_base_url   text NOT NULL,
      api_key           text NOT NULL UNIQUE,
      signing_key_b64   text NOT NULL,
      adapter           text NOT NULL DEFAULT 'native',
      currencies_json   text NOT NULL,
      min_bet_minor     bigint NOT NULL DEFAULT 10,
      max_bet_minor     bigint NOT NULL DEFAULT 500000,
      rtp_variant       real NOT NULL DEFAULT 97.0,
      jurisdictions_json text NOT NULL DEFAULT '[]',
      status            text NOT NULL DEFAULT 'active',
      share_bps         integer NOT NULL DEFAULT 1500,
      created_at        bigint NOT NULL,
      updated_at        bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operators_api_key ON operators(api_key);

    CREATE TABLE IF NOT EXISTS admins (
      username      text PRIMARY KEY,
      password_hash text NOT NULL,
      roles_json    text NOT NULL,
      created_at    bigint NOT NULL,
      last_login_at bigint
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id           bigserial PRIMARY KEY,
      actor        text NOT NULL,
      action       text NOT NULL,
      target       text NOT NULL,
      payload_json text,
      at           bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit(at, id);

    CREATE TABLE IF NOT EXISTS operator_audit (
      id           bigserial PRIMARY KEY,
      operator_id  text NOT NULL,
      action       text NOT NULL,
      target       text NOT NULL,
      payload_json text,
      at           bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_op_audit_operator_at ON operator_audit(operator_id, at);
    CREATE INDEX IF NOT EXISTS idx_op_audit_at ON operator_audit(at, id);

    CREATE TABLE IF NOT EXISTS bet_log (
      bet_id            text PRIMARY KEY,
      operator_id       text NOT NULL,
      player_id         text NOT NULL,
      session_id        text NOT NULL,
      round_id          text NOT NULL,
      currency          text NOT NULL,
      amount_minor      bigint NOT NULL,
      state             text NOT NULL,
      bet_txn_id        text NOT NULL UNIQUE,
      win_txn_id        text,
      rollback_txn_id   text,
      bet_op_txn_id     text,
      win_op_txn_id     text,
      win_amount_minor  bigint,
      multiplier        real,
      error_code        text,
      game_id           text NOT NULL DEFAULT 'galaxy-crash',
      created_at        bigint NOT NULL,
      updated_at        bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_betlog_round    ON bet_log(round_id);
    CREATE INDEX IF NOT EXISTS idx_betlog_state    ON bet_log(state);
    CREATE INDEX IF NOT EXISTS idx_betlog_player   ON bet_log(operator_id, player_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_betlog_operator ON bet_log(operator_id, created_at);

    CREATE TABLE IF NOT EXISTS txn_idempotency (
      txn_id        text NOT NULL,
      operator_id   text NOT NULL,
      kind          text NOT NULL,
      request_hash  text NOT NULL,
      response_json text NOT NULL,
      created_at    bigint NOT NULL,
      PRIMARY KEY (txn_id, operator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_txn_idemp_op ON txn_idempotency(operator_id, created_at);

    CREATE TABLE IF NOT EXISTS reconciliation_runs (
      id             bigserial PRIMARY KEY,
      operator_id    text NOT NULL,
      window_start   bigint NOT NULL,
      window_end     bigint NOT NULL,
      checked_count  integer NOT NULL,
      mismatch_count integer NOT NULL,
      status         text NOT NULL,
      started_at     bigint NOT NULL,
      finished_at    bigint
    );
    CREATE INDEX IF NOT EXISTS idx_recon_runs_operator ON reconciliation_runs(operator_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_recon_runs_keyset   ON reconciliation_runs(started_at, id);

    CREATE TABLE IF NOT EXISTS reconciliation_mismatches (
      id           bigserial PRIMARY KEY,
      run_id       bigint NOT NULL REFERENCES reconciliation_runs(id),
      txn_id       text NOT NULL,
      kind         text NOT NULL,
      details_json text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_mismatches_run ON reconciliation_mismatches(run_id);
  `);
}
