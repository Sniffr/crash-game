import type { Database } from 'better-sqlite3';
import { type BetState, type BetEvent, nextState, InvalidTransitionError } from './state-machine.js';

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
      CREATE INDEX IF NOT EXISTS idx_betlog_round  ON bet_log(round_id);
      CREATE INDEX IF NOT EXISTS idx_betlog_state  ON bet_log(state);
      CREATE INDEX IF NOT EXISTS idx_betlog_player ON bet_log(operator_id, player_id, created_at);

      CREATE TABLE IF NOT EXISTS txn_idempotency (
        txn_id        TEXT NOT NULL,
        operator_id   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (txn_id, operator_id)
      );
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
    ).get(txnId, operatorId) as IdempotencyRow | undefined;

    return row ? rowToIdempotencyEntry(row) : null;
  }
}
