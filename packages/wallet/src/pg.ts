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
  // gen_random_uuid() is built into Postgres 13+ (no pgcrypto extension needed —
  // and CREATE EXTENSION IF NOT EXISTS races under concurrent schema bootstraps).
  await pool.query(`
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

    ALTER TABLE players ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KES';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS phone    text;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS email    text;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS country  text;

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id           bigserial PRIMARY KEY,
      player_id    uuid NOT NULL REFERENCES players(player_id),
      currency     text NOT NULL DEFAULT 'KES',
      amount_minor bigint NOT NULL,                     -- +credit / -debit
      kind         text NOT NULL,                       -- 'deposit'|'bet'|'win'|'adjust'|'withdrawal'
      ref          text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT wallet_ledger_kind_check CHECK (kind IN ('deposit','bet','win','adjust','withdrawal'))
    );
    -- Databases created before withdrawals existed carry the old 4-kind check.
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'wallet_ledger'::regclass AND conname = 'wallet_ledger_kind_check'
          AND pg_get_constraintdef(oid) LIKE '%withdrawal%'
      ) THEN
        ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_kind_check;
        ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_kind_check
          CHECK (kind IN ('deposit','bet','win','adjust','withdrawal'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_wallet_player ON wallet_ledger(player_id, currency);
    -- One credit per deposit reference (idempotent webhook replay + crash-safety).
    -- Partial so it only constrains deposit rows; bet/win/adjust reuse refs freely.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_deposit_ref ON wallet_ledger(ref) WHERE kind = 'deposit';

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

    CREATE TABLE IF NOT EXISTS deposits (
      reference    text PRIMARY KEY,
      player_id    uuid NOT NULL REFERENCES players(player_id),
      currency     text NOT NULL,
      amount_minor bigint NOT NULL,
      status       text NOT NULL DEFAULT 'pending',
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('pending','settled','failed'))
    );

    -- ── Fantasy League ─────────────────────────────────────────────────────
    -- One league = one FPL gameweek. Joins close at the gameweek deadline;
    -- once FPL marks the gameweek final it settles exactly once: points and
    -- payouts are written here and credited to wallet_ledger in the same txn.
    CREATE TABLE IF NOT EXISTS fantasy_leagues (
      league_id       text PRIMARY KEY,
      name            text NOT NULL,
      blurb           text NOT NULL DEFAULT '',
      gameweek        integer NOT NULL,
      deadline        timestamptz NOT NULL,
      entry_fee_minor bigint NOT NULL,
      currency        text NOT NULL DEFAULT 'KES',
      rake_bps        integer NOT NULL DEFAULT 1000,
      payout_bps      jsonb NOT NULL DEFAULT '[5000,3000,2000]',
      status          text NOT NULL DEFAULT 'open',
      pool_minor      bigint,
      rake_minor      bigint,
      settled_at      timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CHECK (entry_fee_minor > 0),
      CHECK (rake_bps >= 0 AND rake_bps <= 10000),
      CHECK (status IN ('open','settled','cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_fantasy_leagues_status ON fantasy_leagues(status, gameweek);

    CREATE TABLE IF NOT EXISTS fantasy_league_members (
      league_id       text NOT NULL REFERENCES fantasy_leagues(league_id) ON DELETE CASCADE,
      player_id       uuid NOT NULL REFERENCES players(player_id),
      player_ids      integer[] NOT NULL,     -- FPL element ids, the XI
      captain_id      integer NOT NULL,
      vice_captain_id integer NOT NULL,
      points          integer,                -- final gameweek points, set at settlement
      final_rank      integer,
      payout_minor    bigint,
      joined_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (league_id, player_id)
    );

    -- A player's linked FPL team (by its public Team ID) — used to import an XI.
    CREATE TABLE IF NOT EXISTS fantasy_fpl_links (
      player_id    uuid PRIMARY KEY REFERENCES players(player_id),
      entry_id     integer NOT NULL,
      team_name    text NOT NULL,
      manager_name text NOT NULL,
      linked_at    timestamptz NOT NULL DEFAULT now()
    );

    -- ── Account security (SimBet phone accounts) ───────────────────────────
    -- token_version is embedded in player JWTs; bumping it signs the player
    -- out everywhere (password change/reset, self-exclusion, deactivation).
    ALTER TABLE players ADD COLUMN IF NOT EXISTS phone_verified_at   timestamptz;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS token_version       integer NOT NULL DEFAULT 0;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS account_status      text NOT NULL DEFAULT 'active';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS self_excluded_until timestamptz;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS deactivation_reason text;
    CREATE INDEX IF NOT EXISTS idx_players_phone ON players(phone);

    CREATE TABLE IF NOT EXISTS otp_codes (
      id          bigserial PRIMARY KEY,
      phone       text NOT NULL,
      purpose     text NOT NULL,
      code_hash   text NOT NULL,
      attempts    integer NOT NULL DEFAULT 0,
      expires_at  timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CHECK (purpose IN ('register','reset','deactivate','reactivate'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_codes(phone, purpose, created_at DESC);

    -- ── Real-money Simulated Matches ────────────────────────────────────────
    -- Each bet resolves at placement (provably-fair RNG); the seed/nonce stay
    -- here so a player can verify any bet from their history.
    CREATE TABLE IF NOT EXISTS sim_bets (
      bet_id       text PRIMARY KEY,
      player_id    uuid NOT NULL REFERENCES players(player_id),
      mode         text NOT NULL,
      currency     text NOT NULL,
      stake_minor  bigint NOT NULL,
      total_odds   double precision NOT NULL,
      won          boolean NOT NULL,
      payout_minor bigint NOT NULL,
      server_seed  text NOT NULL,
      commit       text NOT NULL,
      nonce        text NOT NULL,
      rtp          real NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (mode IN ('single','multi')),
      CHECK (stake_minor > 0 AND payout_minor >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_sim_bets_player ON sim_bets(player_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sim_bet_legs (
      bet_id     text NOT NULL REFERENCES sim_bets(bet_id) ON DELETE CASCADE,
      idx        integer NOT NULL,
      event_id   text NOT NULL,
      league     text,
      home       text,
      away       text,
      kickoff    timestamptz,
      market     text NOT NULL,
      pick       text NOT NULL,
      label      text,
      odds       double precision NOT NULL,
      won        boolean NOT NULL,
      score_home integer,
      score_away integer,
      -- json, not jsonb: jsonb reorders keys, and provably-fair verification
      -- compares the timeline exactly as the engine produced it.
      goal_rates json,
      timeline   json,
      PRIMARY KEY (bet_id, idx)
    );

    -- ── Withdrawals (M-PESA payouts) ────────────────────────────────────────
    -- Funds are debited (kind 'withdrawal') when the request is created and
    -- credited back (kind 'adjust') if the payout fails.
    CREATE TABLE IF NOT EXISTS withdrawals (
      reference       text PRIMARY KEY,
      player_id       uuid NOT NULL REFERENCES players(player_id),
      currency        text NOT NULL,
      amount_minor    bigint NOT NULL,
      phone           text NOT NULL,
      provider        text NOT NULL,
      provider_txn_id text,
      status          text NOT NULL DEFAULT 'pending',
      failure_reason  text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CHECK (amount_minor > 0),
      CHECK (status IN ('pending','processing','success','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_withdrawals_player ON withdrawals(player_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_deposits_player ON deposits(player_id, created_at DESC);

    -- ── Customer support chat (one thread per player) ───────────────────────
    CREATE TABLE IF NOT EXISTS support_messages (
      id         bigserial PRIMARY KEY,
      player_id  uuid NOT NULL REFERENCES players(player_id),
      sender     text NOT NULL,
      agent      text,
      body       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at    timestamptz,
      CHECK (sender IN ('player','agent')),
      CHECK (length(body) BETWEEN 1 AND 2000)
    );
    CREATE INDEX IF NOT EXISTS idx_support_player ON support_messages(player_id, id);
  `);
}
