import type { Database } from 'better-sqlite3';
import { type BetState, type BetEvent, nextState, InvalidTransitionError } from './state-machine.js';
import { type Cursor, encodeCursor, decodeCursor as _decodeCursor } from './cursor.js';
export type { Cursor } from './cursor.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class BetNotFoundError extends Error {
  readonly betId: string;
  constructor(betId: string) {
    super(`Bet '${betId}' not found`);
    this.name = 'BetNotFoundError';
    this.betId = betId;
  }
}

export class DuplicateBetIdError extends Error {
  readonly betId: string;
  constructor(betId: string) {
    super(`A bet with id '${betId}' already exists`);
    this.name = 'DuplicateBetIdError';
    this.betId = betId;
  }
}

export class DuplicateBetTxnIdError extends Error {
  readonly betTxnId: string;
  constructor(betTxnId: string) {
    super(`A bet with bet_txn_id '${betTxnId}' already exists`);
    this.name = 'DuplicateBetTxnIdError';
    this.betTxnId = betTxnId;
  }
}

export class IdempotencyMismatchError extends Error {
  readonly txnId: string;
  constructor(txnId: string) {
    super(`Idempotency mismatch for txn_id '${txnId}': same txn_id, different request_hash`);
    this.name = 'IdempotencyMismatchError';
    this.txnId = txnId;
  }
}

// ---------------------------------------------------------------------------
// Derive Statement type without importing the namespace type
// ---------------------------------------------------------------------------

type SqliteStatement<P extends unknown[] = unknown[]> = ReturnType<Database['prepare']> & {
  run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  get(...params: P): unknown;
  all(...params: P): unknown[];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BetRow {
  betId: string;
  operatorId: string;
  playerId: string;
  sessionId: string;
  roundId: string;
  currency: string;
  amountMinor: number;
  state: BetState;
  betTxnId: string;
  winTxnId: string | null;
  rollbackTxnId: string | null;
  betOpTxnId: string | null;
  winOpTxnId: string | null;
  winAmountMinor: number | null;
  multiplier: number | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * RoundSummary: derived by GROUP BY round_id over bet_log rows.
 * There is NO rounds table — rounds exist only as groups of bet_log rows.
 * Fields unavailable from bet_log (server seeds, crash point from RNG, roundNumber)
 * are omitted — the live round loop's RNG seeds are NOT persisted (Phase-future gap).
 */
export interface RoundSummary {
  roundId: string;
  /** All distinct operator ids that have bets in this round */
  operatorIds: string[];
  betCount: number;
  distinctPlayers: number;
  /** Total amount wagered, per currency */
  totalAmountMinorByCurrency: Record<string, number>;
  /** Max multiplier seen across settled bets in this round (null if no settled bets) */
  maxMultiplier: number | null;
  firstAt: number;   // unix seconds
  lastAt: number;    // unix seconds
}

/**
 * A txn_idempotency row joined with bet_log fields for the §7.1 transactions API.
 */
export interface IdempotencyWithBet {
  txnId: string;
  operatorId: string;
  kind: TxnKind;
  requestHash: string;
  responseJson: string;
  createdAt: number;
  // Joined from bet_log:
  playerId: string | null;
  betId: string | null;
  // Derived per-kind from bet_log:
  operatorTxnId: string | null;
  amountMinor: number | null;
  currency: string | null;
  winAmountMinor: number | null;
}

// ---------------------------------------------------------------------------
// Financial report types (Task 5.4 — spec §8.1 / §8.2)
// ---------------------------------------------------------------------------

/**
 * A single row in a financial GGR/NGR report.
 *
 * Stake/win definitions (mirrored in SQL below):
 *   STAKE = sum(amount_minor) for SETTLED, LOST, WIN_FAILED rows.
 *     - SETTLED: debit happened, credit happened — fully closed.
 *     - LOST: debit happened, no credit (multiplier < cashout) — fully closed.
 *     - WIN_FAILED: debit happened, credit PENDING (operator hasn't responded) —
 *       the debit is real so we count the stake. We do NOT count the win because
 *       the operator has not confirmed credit. When force-credit later transitions
 *       WIN_FAILED → SETTLED, future reports will include the win.
 *     - VOIDED: full rollback — stake was refunded; exclude from stake.
 *     - Mid-flight (PENDING/ARMED/FLYING/SETTLING/ROLLBACK_PENDING): not financially
 *       closed; exclude entirely.
 *   WIN = sum(win_amount_minor) for SETTLED rows only.
 *   GGR = STAKE − WIN.
 *   NGR = GGR − bonuses; bonuses = 0 in v1 (field reserved for future use).
 *
 * NEVER mix currencies in a single row. All sums are per (operatorId, currency).
 */
export interface FinancialRow {
  operatorId: string;
  currency: string;
  /** UTC date 'YYYY-MM-DD'; null when 'day' is not in groupBy. */
  day: string | null;
  /** Count of financially-closed bets (SETTLED | LOST | WIN_FAILED). */
  betCount: number;
  stakeMinor: number;
  winMinor: number;
  /** stakeMinor − winMinor */
  ggrMinor: number;
  /** GGR − bonuses; bonuses = 0 in v1 */
  ngrMinor: number;
}

export interface FinancialFilter {
  operatorId?: string;
  currency?: string;
  /** Unix seconds inclusive lower bound on bet created_at */
  from?: number;
  /** Unix seconds exclusive upper bound on bet created_at */
  to?: number;
  /**
   * At least one required. Controls GROUP BY granularity.
   * Unknown values throw (caller should 400).
   */
  groupBy: ReadonlyArray<'operator' | 'currency' | 'day'>;
}

export interface CreateBetInput {
  betId: string;
  operatorId: string;
  playerId: string;
  sessionId: string;
  roundId: string;
  currency: string;
  amountMinor: number;
  betTxnId: string;
}

export type TxnKind = 'bet' | 'win' | 'rollback';

export interface IdempotencyEntry {
  txnId: string;
  operatorId: string;
  kind: TxnKind;
  requestHash: string;
  responseJson: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Internal raw row shapes (as returned by better-sqlite3)
// ---------------------------------------------------------------------------

interface BetLogRow {
  bet_id: string;
  operator_id: string;
  player_id: string;
  session_id: string;
  round_id: string;
  currency: string;
  amount_minor: number;
  state: string;
  bet_txn_id: string;
  win_txn_id: string | null;
  rollback_txn_id: string | null;
  bet_op_txn_id: string | null;
  win_op_txn_id: string | null;
  win_amount_minor: number | null;
  multiplier: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface IdempotencyRow {
  txn_id: string;
  operator_id: string;
  kind: string;
  request_hash: string;
  response_json: string;
  created_at: number;
}

interface IdempotencyWithBetRow {
  txn_id: string;
  operator_id: string;
  kind: string;
  request_hash: string;
  response_json: string;
  created_at: number;
  // Joined from bet_log:
  player_id: string | null;
  bet_id: string | null;
  bet_op_txn_id: string | null;
  win_op_txn_id: string | null;
  rollback_txn_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  win_amount_minor: number | null;
}

interface RoundSummaryRow {
  round_id: string;
  operator_ids: string;  // JSON array of distinct operator_ids
  bet_count: number;
  distinct_players: number;
  currencies: string;    // JSON array of distinct currencies
  total_amounts: string; // JSON array of {currency, total} objects
  max_multiplier: number | null;
  first_at: number;
  last_at: number;
}

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

function rowToBetRow(row: BetLogRow): BetRow {
  return {
    betId: row.bet_id,
    operatorId: row.operator_id,
    playerId: row.player_id,
    sessionId: row.session_id,
    roundId: row.round_id,
    currency: row.currency,
    amountMinor: row.amount_minor,
    state: row.state as BetState,
    betTxnId: row.bet_txn_id,
    winTxnId: row.win_txn_id,
    rollbackTxnId: row.rollback_txn_id,
    betOpTxnId: row.bet_op_txn_id,
    winOpTxnId: row.win_op_txn_id,
    winAmountMinor: row.win_amount_minor,
    multiplier: row.multiplier,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToIdempotencyEntry(row: IdempotencyRow): IdempotencyEntry {
  return {
    txnId: row.txn_id,
    operatorId: row.operator_id,
    kind: row.kind as TxnKind,
    requestHash: row.request_hash,
    responseJson: row.response_json,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// BetLog
// ---------------------------------------------------------------------------

export class BetLog {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this._ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bet_log (
        bet_id            TEXT PRIMARY KEY,
        operator_id       TEXT NOT NULL,
        player_id         TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        round_id          TEXT NOT NULL,
        currency          TEXT NOT NULL,
        amount_minor      INTEGER NOT NULL,
        state             TEXT NOT NULL,
        bet_txn_id        TEXT NOT NULL UNIQUE,
        win_txn_id        TEXT,
        rollback_txn_id   TEXT,
        bet_op_txn_id     TEXT,
        win_op_txn_id     TEXT,
        win_amount_minor  INTEGER,
        multiplier        REAL,
        error_code        TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_betlog_round    ON bet_log(round_id);
      CREATE INDEX IF NOT EXISTS idx_betlog_state    ON bet_log(state);
      CREATE INDEX IF NOT EXISTS idx_betlog_player   ON bet_log(operator_id, player_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_betlog_operator ON bet_log(operator_id, created_at);

      CREATE TABLE IF NOT EXISTS txn_idempotency (
        txn_id        TEXT NOT NULL,
        operator_id   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (txn_id, operator_id)
      );
      CREATE INDEX IF NOT EXISTS idx_txn_idemp_op ON txn_idempotency(operator_id, created_at);
    `);
  }

  // -------------------------------------------------------------------------
  // Prepared-statement helpers (lazy, created once per instance)
  // -------------------------------------------------------------------------

  private _stmts = {} as Record<string, SqliteStatement>;

  private stmt<P extends unknown[] = unknown[]>(key: string, sql: string): SqliteStatement<P> {
    if (!this._stmts[key]) {
      this._stmts[key] = this.db.prepare(sql) as SqliteStatement;
    }
    return this._stmts[key] as SqliteStatement<P>;
  }

  // -------------------------------------------------------------------------
  // bet_log operations
  // -------------------------------------------------------------------------

  create(input: CreateBetInput): BetRow {
    const now = Math.floor(Date.now() / 1000);

    try {
      this.stmt(
        'insert_bet',
        `INSERT INTO bet_log (
          bet_id, operator_id, player_id, session_id, round_id, currency,
          amount_minor, state, bet_txn_id,
          win_txn_id, rollback_txn_id, bet_op_txn_id, win_op_txn_id,
          win_amount_minor, multiplier, error_code,
          created_at, updated_at
        ) VALUES (
          @bet_id, @operator_id, @player_id, @session_id, @round_id, @currency,
          @amount_minor, @state, @bet_txn_id,
          NULL, NULL, NULL, NULL,
          NULL, NULL, NULL,
          @created_at, @updated_at
        )`,
      ).run({
        bet_id: input.betId,
        operator_id: input.operatorId,
        player_id: input.playerId,
        session_id: input.sessionId,
        round_id: input.roundId,
        currency: input.currency,
        amount_minor: input.amountMinor,
        state: 'PENDING' as BetState,
        bet_txn_id: input.betTxnId,
        created_at: now,
        updated_at: now,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed') && msg.includes('bet_log.bet_id')) {
        throw new DuplicateBetIdError(input.betId);
      }
      if (msg.includes('UNIQUE constraint failed') && msg.includes('bet_txn_id')) {
        throw new DuplicateBetTxnIdError(input.betTxnId);
      }
      throw err;
    }

    return this.getById(input.betId) as BetRow;
  }

  getById(betId: string): BetRow | null {
    const row = this.stmt(
      'get_bet_by_id',
      `SELECT * FROM bet_log WHERE bet_id = ?`,
    ).get(betId) as BetLogRow | undefined;

    return row ? rowToBetRow(row) : null;
  }

  getByBetTxnId(betTxnId: string): BetRow | null {
    const row = this.stmt(
      'get_bet_by_txn_id',
      `SELECT * FROM bet_log WHERE bet_txn_id = ?`,
    ).get(betTxnId) as BetLogRow | undefined;

    return row ? rowToBetRow(row) : null;
  }

  listByState(state: BetState, limit = 100): BetRow[] {
    const rows = this.stmt(
      'list_by_state',
      `SELECT * FROM bet_log WHERE state = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(state, limit) as BetLogRow[];
    return rows.map(rowToBetRow);
  }

  listByRound(roundId: string): BetRow[] {
    const rows = this.stmt(
      'list_by_round',
      `SELECT * FROM bet_log WHERE round_id = ? ORDER BY created_at ASC`,
    ).all(roundId) as BetLogRow[];
    return rows.map(rowToBetRow);
  }

  listByPlayer(
    operatorId: string,
    playerId: string,
    opts?: { limit?: number; offset?: number },
  ): BetRow[] {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = this.stmt(
      'list_by_player',
      `SELECT * FROM bet_log WHERE operator_id = ? AND player_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(operatorId, playerId, limit, offset) as BetLogRow[];
    return rows.map(rowToBetRow);
  }

  /**
   * Advance the state machine.
   * Validates the transition, runs the UPDATE inside a transaction, and applies
   * any side-data updates. Returns the updated row.
   * Throws InvalidTransitionError if the event is illegal for the current state.
   * Throws BetNotFoundError if the bet doesn't exist.
   */
  transition(
    betId: string,
    event: BetEvent,
    sideData?: Partial<{
      winTxnId: string;
      rollbackTxnId: string;
      betOpTxnId: string;
      winOpTxnId: string;
      winAmountMinor: number;
      multiplier: number;
      errorCode: string;
    }>,
  ): BetRow {
    return this.db.transaction((): BetRow => {
      const current = this.getById(betId);
      if (!current) throw new BetNotFoundError(betId);

      // nextState throws InvalidTransitionError on illegal combos
      const next = nextState(current.state, event);

      const now = Math.floor(Date.now() / 1000);
      const setClauses: string[] = ['state = @state', 'updated_at = @updated_at'];
      const params: Record<string, unknown> = {
        bet_id: betId,
        state: next,
        updated_at: now,
      };

      if (sideData?.winTxnId !== undefined) {
        setClauses.push('win_txn_id = @win_txn_id');
        params['win_txn_id'] = sideData.winTxnId;
      }
      if (sideData?.rollbackTxnId !== undefined) {
        setClauses.push('rollback_txn_id = @rollback_txn_id');
        params['rollback_txn_id'] = sideData.rollbackTxnId;
      }
      if (sideData?.betOpTxnId !== undefined) {
        setClauses.push('bet_op_txn_id = @bet_op_txn_id');
        params['bet_op_txn_id'] = sideData.betOpTxnId;
      }
      if (sideData?.winOpTxnId !== undefined) {
        setClauses.push('win_op_txn_id = @win_op_txn_id');
        params['win_op_txn_id'] = sideData.winOpTxnId;
      }
      if (sideData?.winAmountMinor !== undefined) {
        setClauses.push('win_amount_minor = @win_amount_minor');
        params['win_amount_minor'] = sideData.winAmountMinor;
      }
      if (sideData?.multiplier !== undefined) {
        setClauses.push('multiplier = @multiplier');
        params['multiplier'] = sideData.multiplier;
      }
      if (sideData?.errorCode !== undefined) {
        setClauses.push('error_code = @error_code');
        params['error_code'] = sideData.errorCode;
      }

      const sql = `UPDATE bet_log SET ${setClauses.join(', ')} WHERE bet_id = @bet_id`;
      const info = this.db.prepare(sql).run(params);
      if (info.changes !== 1) {
        throw new Error(`[BetLog] UPDATE affected ${info.changes} rows for bet '${betId}' — expected exactly 1`);
      }

      return this.getById(betId) as BetRow;
    })();
  }

  // -------------------------------------------------------------------------
  // txn_idempotency operations
  // -------------------------------------------------------------------------

  putIdempotency(entry: IdempotencyEntry): void {
    // Try a direct INSERT; if it fails on UNIQUE, check hash
    try {
      this.stmt(
        'insert_idempotency',
        `INSERT INTO txn_idempotency (txn_id, operator_id, kind, request_hash, response_json, created_at)
         VALUES (@txn_id, @operator_id, @kind, @request_hash, @response_json, @created_at)`,
      ).run({
        txn_id: entry.txnId,
        operator_id: entry.operatorId,
        kind: entry.kind,
        request_hash: entry.requestHash,
        response_json: entry.responseJson,
        created_at: entry.createdAt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed')) {
        // Existing row — check hash (scoped to this operator)
        const existing = this.getIdempotency(entry.operatorId, entry.txnId);
        if (existing && existing.requestHash === entry.requestHash) {
          // Same hash: idempotent, do nothing
          return;
        }
        throw new IdempotencyMismatchError(entry.txnId);
      }
      throw err;
    }
  }

  getIdempotency(operatorId: string, txnId: string): IdempotencyEntry | null {
    const row = this.stmt(
      'get_idempotency',
      `SELECT * FROM txn_idempotency WHERE txn_id = ? AND operator_id = ?`,
    // NOTE: positional bind order is (txn_id, operator_id) to match the WHERE clause — intentionally the REVERSE of this method's (operatorId, txnId) signature. Do not "align" them.
    ).get(txnId, operatorId) as IdempotencyRow | undefined;

    return row ? rowToIdempotencyEntry(row) : null;
  }

  // -------------------------------------------------------------------------
  // Cursor-paginated filtered queries (Task 5.3 — admin read API)
  // -------------------------------------------------------------------------

  /**
   * List bets with optional filters and keyset cursor pagination.
   * Keyset: ORDER BY created_at DESC, bet_id DESC (uses idx_betlog_player /
   *   idx_betlog_state / idx_betlog_operator as available).
   * nextCursor is null when fewer than `limit` rows are returned (last page).
   *
   * NOTE: We add idx_betlog_operator(operator_id, created_at) in _ensureSchema
   * because EXPLAIN QUERY PLAN showed a full table scan for operatorId-only
   * filters (the existing idx_betlog_player covers operator_id+player_id+created_at
   * but not operator_id alone).
   */
  listBetsFiltered(
    f: {
      operatorId?: string;
      playerId?: string;
      state?: BetState;
      betId?: string;
      betTxnId?: string;
      from?: number;
      to?: number;
    },
    page: { limit: number; cursor?: Cursor },
  ): { rows: BetRow[]; nextCursor: string | null } {
    const conds: string[] = [];
    const params: unknown[] = [];

    // Keyset cursor — lexicographic (created_at DESC, bet_id DESC)
    if (page.cursor) {
      conds.push('(created_at < ? OR (created_at = ? AND bet_id < ?))');
      params.push(page.cursor.ts, page.cursor.ts, page.cursor.id);
    }
    if (f.operatorId !== undefined) {
      conds.push('operator_id = ?');
      params.push(f.operatorId);
    }
    if (f.playerId !== undefined) {
      conds.push('player_id = ?');
      params.push(f.playerId);
    }
    if (f.state !== undefined) {
      conds.push('state = ?');
      params.push(f.state);
    }
    if (f.betId !== undefined) {
      conds.push('bet_id = ?');
      params.push(f.betId);
    }
    if (f.betTxnId !== undefined) {
      conds.push('bet_txn_id = ?');
      params.push(f.betTxnId);
    }
    if (f.from !== undefined) {
      conds.push('created_at >= ?');
      params.push(f.from);
    }
    if (f.to !== undefined) {
      conds.push('created_at <= ?');
      params.push(f.to);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    // Dynamic SQL — cannot use the prepared-statement cache (filters vary per call).
    // We accept this: these are admin read paths, not hot write paths.
    const sql = `SELECT * FROM bet_log ${where} ORDER BY created_at DESC, bet_id DESC LIMIT ?`;
    params.push(page.limit);

    const raw = this.db.prepare(sql).all(...params) as BetLogRow[];
    const rows = raw.map(rowToBetRow);

    let nextCursor: string | null = null;
    if (rows.length === page.limit) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({ ts: last.createdAt, id: last.betId });
    }

    return { rows, nextCursor };
  }

  /**
   * List rounds derived by GROUP BY round_id over bet_log.
   * Keyset: ORDER BY last_at DESC, round_id DESC.
   * minMultiplier/maxMultiplier filter on the round's max multiplier (HAVING).
   *
   * NOTE on multi-currency: totalAmountMinorByCurrency is built post-query
   * because SQLite does not support JSON aggregation; we do a second query
   * per round only if needed — or build it from the group-by result by
   * further grouping. For correctness we run one query per round for currency
   * breakdown (acceptable for admin read API, bounded by limit ≤ 200).
   *
   * NOTE: RNG seeds (server seed, crash point) are NOT persisted in bet_log;
   * those fields are emitted as null from the route layer (Phase-future gap).
   */
  listRoundsFiltered(
    f: {
      operatorId?: string;
      from?: number;
      to?: number;
      minMultiplier?: number;
      maxMultiplier?: number;
    },
    page: { limit: number; cursor?: Cursor },
  ): { rows: RoundSummary[]; nextCursor: string | null } {
    const conds: string[] = [];
    const havingConds: string[] = [];
    const params: unknown[] = [];
    const havingParams: unknown[] = [];

    if (f.operatorId !== undefined) {
      conds.push('operator_id = ?');
      params.push(f.operatorId);
    }
    if (f.from !== undefined) {
      conds.push('created_at >= ?');
      params.push(f.from);
    }
    if (f.to !== undefined) {
      conds.push('created_at <= ?');
      params.push(f.to);
    }
    // Keyset cursor on (last_at DESC, round_id DESC)
    if (page.cursor) {
      conds.push('(MAX(created_at) < ? OR (MAX(created_at) = ? AND round_id < ?))');
      // These go in HAVING, not WHERE
      conds.pop();
      havingConds.push('(MAX(created_at) < ? OR (MAX(created_at) = ? AND round_id < ?))');
      havingParams.push(page.cursor.ts, page.cursor.ts, page.cursor.id);
    }
    if (f.minMultiplier !== undefined) {
      havingConds.push('MAX(COALESCE(multiplier, 0)) >= ?');
      havingParams.push(f.minMultiplier);
    }
    if (f.maxMultiplier !== undefined) {
      havingConds.push('MAX(COALESCE(multiplier, 0)) <= ?');
      havingParams.push(f.maxMultiplier);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const having = havingConds.length > 0 ? `HAVING ${havingConds.join(' AND ')}` : '';

    const sql = `
      SELECT
        round_id,
        GROUP_CONCAT(DISTINCT operator_id) AS operator_ids_csv,
        COUNT(*) AS bet_count,
        COUNT(DISTINCT player_id) AS distinct_players,
        MAX(COALESCE(multiplier, 0)) AS max_multiplier,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at
      FROM bet_log
      ${where}
      GROUP BY round_id
      ${having}
      ORDER BY MAX(created_at) DESC, round_id DESC
      LIMIT ?
    `;

    const allParams = [...params, ...havingParams, page.limit];
    const raw = this.db.prepare(sql).all(...allParams) as Array<{
      round_id: string;
      operator_ids_csv: string;
      bet_count: number;
      distinct_players: number;
      max_multiplier: number | null;
      first_at: number;
      last_at: number;
    }>;

    // Build per-round currency totals (separate query per round, bounded by limit≤200)
    const rows: RoundSummary[] = raw.map((r) => {
      const currencyTotals = this.db.prepare(
        `SELECT currency, SUM(amount_minor) as total FROM bet_log WHERE round_id = ? GROUP BY currency`,
      ).all(r.round_id) as Array<{ currency: string; total: number }>;

      const totalAmountMinorByCurrency: Record<string, number> = {};
      for (const ct of currencyTotals) {
        totalAmountMinorByCurrency[ct.currency] = ct.total;
      }

      return {
        roundId: r.round_id,
        operatorIds: r.operator_ids_csv ? r.operator_ids_csv.split(',').filter(Boolean) : [],
        betCount: r.bet_count,
        distinctPlayers: r.distinct_players,
        totalAmountMinorByCurrency,
        // max_multiplier=0 means no settled bets; return null in that case
        maxMultiplier: r.max_multiplier !== null && r.max_multiplier > 0 ? r.max_multiplier : null,
        firstAt: r.first_at,
        lastAt: r.last_at,
      };
    });

    let nextCursor: string | null = null;
    if (rows.length === page.limit) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({ ts: last.lastAt, id: last.roundId });
    }

    return { rows, nextCursor };
  }

  /**
   * List txn_idempotency rows joined with bet_log for the §7.1 transactions API.
   * Keyset: ORDER BY txn_idempotency.created_at DESC, txn_id DESC.
   *
   * NOTE: attempts and totalMs are NOT persisted in txn_idempotency (Phase-future gap).
   * status is derived from response_json: NOOP is not detectable from stored rows,
   * so we return 'OK' for all stored entries (they were stored on success/first call).
   * operatorTxnId is derived per-kind from bet_log (bet_op_txn_id / win_op_txn_id).
   */
  listIdempotencyFiltered(
    f: {
      operatorId?: string;
      playerId?: string;
      kind?: TxnKind;
      from?: number;
      to?: number;
    },
    page: { limit: number; cursor?: Cursor },
  ): { rows: IdempotencyWithBet[]; nextCursor: string | null } {
    const conds: string[] = [];
    const params: unknown[] = [];

    // Keyset cursor on (created_at DESC, txn_id DESC)
    if (page.cursor) {
      conds.push('(ti.created_at < ? OR (ti.created_at = ? AND ti.txn_id < ?))');
      params.push(page.cursor.ts, page.cursor.ts, page.cursor.id);
    }
    if (f.operatorId !== undefined) {
      conds.push('ti.operator_id = ?');
      params.push(f.operatorId);
    }
    if (f.kind !== undefined) {
      conds.push('ti.kind = ?');
      params.push(f.kind);
    }
    if (f.from !== undefined) {
      conds.push('ti.created_at >= ?');
      params.push(f.from);
    }
    if (f.to !== undefined) {
      conds.push('ti.created_at <= ?');
      params.push(f.to);
    }
    // playerId filter requires joining through bet_log
    if (f.playerId !== undefined) {
      conds.push('bl.player_id = ?');
      params.push(f.playerId);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    // JOIN: bet-side txnId is bet_txn_id; win-side is win_txn_id; rollback is rollback_txn_id
    // We LEFT JOIN to get the bet_log row that produced this txn.
    const sql = `
      SELECT
        ti.txn_id, ti.operator_id, ti.kind, ti.request_hash, ti.response_json, ti.created_at,
        bl.player_id, bl.bet_id,
        bl.bet_op_txn_id, bl.win_op_txn_id, bl.rollback_txn_id,
        bl.amount_minor, bl.currency, bl.win_amount_minor
      FROM txn_idempotency ti
      LEFT JOIN bet_log bl ON (
        (ti.kind = 'bet'      AND bl.bet_txn_id      = ti.txn_id AND bl.operator_id = ti.operator_id) OR
        (ti.kind = 'win'      AND bl.win_txn_id      = ti.txn_id AND bl.operator_id = ti.operator_id) OR
        (ti.kind = 'rollback' AND bl.rollback_txn_id = ti.txn_id AND bl.operator_id = ti.operator_id)
      )
      ${where}
      ORDER BY ti.created_at DESC, ti.txn_id DESC
      LIMIT ?
    `;
    params.push(page.limit);

    const raw = this.db.prepare(sql).all(...params) as IdempotencyWithBetRow[];

    const rows: IdempotencyWithBet[] = raw.map((r) => {
      // Derive operatorTxnId per kind from bet_log columns
      let operatorTxnId: string | null = null;
      if (r.kind === 'bet') operatorTxnId = r.bet_op_txn_id ?? null;
      else if (r.kind === 'win') operatorTxnId = r.win_op_txn_id ?? null;
      // rollback: no separate op txn column exists — not persisted (Phase-future gap)

      return {
        txnId: r.txn_id,
        operatorId: r.operator_id,
        kind: r.kind as TxnKind,
        requestHash: r.request_hash,
        responseJson: r.response_json,
        createdAt: r.created_at,
        playerId: r.player_id ?? null,
        betId: r.bet_id ?? null,
        operatorTxnId,
        amountMinor: r.amount_minor ?? null,
        currency: r.currency ?? null,
        winAmountMinor: r.win_amount_minor ?? null,
      };
    });

    let nextCursor: string | null = null;
    if (rows.length === page.limit) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({ ts: last.createdAt, id: last.txnId });
    }

    return { rows, nextCursor };
  }

  // -------------------------------------------------------------------------
  // Financial reporting (Task 5.4 — spec §8.1 / §8.2)
  // -------------------------------------------------------------------------

  /**
   * Aggregate bet_log rows into a financial GGR/NGR report.
   *
   * Stake/win/GGR definitions:
   *   STAKE = SUM(amount_minor) WHERE state IN ('SETTLED', 'LOST', 'WIN_FAILED')
   *     VOIDED → excluded (stake was refunded).
   *     WIN_FAILED → stake included; WIN excluded (operator hasn't confirmed credit yet).
   *   WIN   = SUM(win_amount_minor) WHERE state = 'SETTLED'
   *     WIN_FAILED → excluded from win (see above; may be force-credited later).
   *   GGR   = STAKE − WIN
   *   NGR   = GGR − bonuses (v1: bonuses always 0; field reserved)
   *
   * Results are capped at 100 000 rows and ordered deterministically by the groupBy columns.
   * Never mixes currencies in one row.
   *
   * @throws Error when groupBy is empty or contains unknown values (caller should 400).
   */
  financialReport(filter: FinancialFilter): FinancialRow[] {
    const VALID_GROUP_BY = new Set(['operator', 'currency', 'day']);

    if (!filter.groupBy || filter.groupBy.length === 0) {
      throw new Error('groupBy must be a non-empty array containing at least one of: operator, currency, day');
    }
    for (const g of filter.groupBy) {
      if (!VALID_GROUP_BY.has(g)) {
        throw new Error(`Unknown groupBy value '${g}'. Valid values: operator, currency, day`);
      }
    }

    const byOperator = filter.groupBy.includes('operator');
    const byCurrency = filter.groupBy.includes('currency');
    const byDay = filter.groupBy.includes('day');

    // Build SELECT list and GROUP BY clauses dynamically from groupBy.
    // We always return operatorId and currency in the result (NULL when not in groupBy).
    // day is only computed when 'day' is in groupBy (otherwise NULL).
    const selectClauses: string[] = [];
    const groupByClauses: string[] = [];
    const orderByClauses: string[] = [];

    if (byOperator) {
      selectClauses.push('operator_id');
      groupByClauses.push('operator_id');
      orderByClauses.push('operator_id ASC');
    } else {
      selectClauses.push("NULL AS operator_id");
    }

    if (byCurrency) {
      selectClauses.push('currency');
      groupByClauses.push('currency');
      orderByClauses.push('currency ASC');
    } else {
      selectClauses.push("NULL AS currency");
    }

    if (byDay) {
      selectClauses.push("strftime('%Y-%m-%d', created_at, 'unixepoch') AS day");
      groupByClauses.push("strftime('%Y-%m-%d', created_at, 'unixepoch')");
      orderByClauses.push('day ASC');
    } else {
      selectClauses.push("NULL AS day");
    }

    // Financial aggregations per spec §8.1:
    //   STAKE: amount_minor for SETTLED, LOST, WIN_FAILED (debit happened, never refunded)
    //   WIN:   win_amount_minor for SETTLED only (confirmed operator credit)
    //   WIN_FAILED note: stake counted, win NOT counted (operator credit unconfirmed)
    selectClauses.push(`
      SUM(CASE WHEN state IN ('SETTLED', 'LOST', 'WIN_FAILED') THEN 1 ELSE 0 END) AS bet_count,
      SUM(CASE WHEN state IN ('SETTLED', 'LOST', 'WIN_FAILED') THEN amount_minor ELSE 0 END) AS stake_minor,
      SUM(CASE WHEN state = 'SETTLED' THEN COALESCE(win_amount_minor, 0) ELSE 0 END) AS win_minor
    `);

    // WHERE conditions
    const whereConds: string[] = [];
    const params: unknown[] = [];

    if (filter.operatorId !== undefined) {
      whereConds.push('operator_id = ?');
      params.push(filter.operatorId);
    }
    if (filter.currency !== undefined) {
      whereConds.push('currency = ?');
      params.push(filter.currency);
    }
    if (filter.from !== undefined) {
      whereConds.push('created_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      // 'to' is exclusive per spec
      whereConds.push('created_at < ?');
      params.push(filter.to);
    }

    const where = whereConds.length > 0 ? `WHERE ${whereConds.join(' AND ')}` : '';
    const groupBy = groupByClauses.length > 0 ? `GROUP BY ${groupByClauses.join(', ')}` : '';
    const orderBy = orderByClauses.length > 0 ? `ORDER BY ${orderByClauses.join(', ')}` : '';

    const sql = `
      SELECT
        ${selectClauses.join(',\n        ')}
      FROM bet_log
      ${where}
      ${groupBy}
      ${orderBy}
      -- Defensive cap: this is a report query; callers should narrow the window via
      -- groupBy granularity rather than relying on this limit. 100 000 rows is ~274
      -- operator-currency-day cells over a full year, which no realistic deployment
      -- should exceed. If it does, narrow the query window.
      LIMIT 100000
    `;

    // Dynamic SQL — cannot use the prepared-statement cache (SQL differs per groupBy combo).
    const raw = this.db.prepare(sql).all(...params) as Array<{
      operator_id: string | null;
      currency: string | null;
      day: string | null;
      bet_count: number;
      stake_minor: number;
      win_minor: number;
    }>;

    return raw.map((r) => {
      const stakeMinor = r.stake_minor ?? 0;
      const winMinor = r.win_minor ?? 0;
      const ggrMinor = stakeMinor - winMinor;
      return {
        operatorId: r.operator_id ?? '',
        currency: r.currency ?? '',
        day: r.day,
        betCount: r.bet_count ?? 0,
        stakeMinor,
        winMinor,
        ggrMinor,
        ngrMinor: ggrMinor, // bonuses = 0 in v1; NGR = GGR
      };
    });
  }
}
