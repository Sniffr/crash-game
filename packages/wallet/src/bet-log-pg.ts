import type { Pool } from 'pg';
import { encodeCursor, type Cursor } from './cursor.js';
import { nextState, type BetState, type BetEvent } from './state-machine.js';
import {
  DuplicateBetIdError,
  DuplicateBetTxnIdError,
  BetNotFoundError,
  IdempotencyMismatchError,
  type BetRow,
  type CreateBetInput,
  type IdempotencyEntry,
  type IdempotencyWithBet,
  type TxnKind,
  type RoundSummary,
  type PlayerSessionSummary,
  type FinancialFilter,
  type FinancialRow,
} from './bet-log.js';

// ---------------------------------------------------------------------------
// Postgres BetLog — faithful async port of the SQLite BetLog. The bet ledger
// is the transactional heart of the B2B money path, so this cannot be cached:
// every method hits Postgres. State transitions run inside a DB transaction.
// Table DDL lives in pg.ts:bootstrapCasinoSchema.
// ---------------------------------------------------------------------------

// pg returns bigint/bigserial as strings — coerce the numeric columns.
function n(v: unknown): number { return v == null ? 0 : Number(v); }
function nn(v: unknown): number | null { return v == null ? null : Number(v); }

interface BetLogRowPg {
  bet_id: string; operator_id: string; player_id: string; session_id: string;
  round_id: string; currency: string; amount_minor: string | number; state: string;
  bet_txn_id: string; win_txn_id: string | null; rollback_txn_id: string | null;
  bet_op_txn_id: string | null; win_op_txn_id: string | null;
  win_amount_minor: string | number | null; multiplier: number | null; error_code: string | null;
  game_id: string; created_at: string | number; updated_at: string | number;
}

function rowToBetRow(r: BetLogRowPg): BetRow {
  return {
    betId: r.bet_id, operatorId: r.operator_id, playerId: r.player_id, sessionId: r.session_id,
    roundId: r.round_id, currency: r.currency, amountMinor: n(r.amount_minor), state: r.state as BetState,
    betTxnId: r.bet_txn_id, winTxnId: r.win_txn_id, rollbackTxnId: r.rollback_txn_id,
    betOpTxnId: r.bet_op_txn_id, winOpTxnId: r.win_op_txn_id, winAmountMinor: nn(r.win_amount_minor),
    multiplier: r.multiplier == null ? null : Number(r.multiplier), errorCode: r.error_code,
    gameId: r.game_id, createdAt: n(r.created_at), updatedAt: n(r.updated_at),
  };
}

export class PgBetLog {
  constructor(private readonly pool: Pool) {}

  // ── bet_log writes/reads ───────────────────────────────────────────────────

  async create(input: CreateBetInput): Promise<BetRow> {
    const now = Math.floor(Date.now() / 1000);
    try {
      const { rows } = await this.pool.query<BetLogRowPg>(
        `INSERT INTO bet_log (
           bet_id, operator_id, player_id, session_id, round_id, currency,
           amount_minor, state, bet_txn_id, game_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [input.betId, input.operatorId, input.playerId, input.sessionId, input.roundId,
         input.currency, input.amountMinor, 'PENDING', input.betTxnId, input.gameId ?? 'galaxy-crash', now],
      );
      return rowToBetRow(rows[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate key')) {
        if (msg.includes('bet_log_pkey') || msg.includes('bet_id')) throw new DuplicateBetIdError(input.betId);
        if (msg.includes('bet_txn_id')) throw new DuplicateBetTxnIdError(input.betTxnId);
      }
      throw err;
    }
  }

  async getById(betId: string): Promise<BetRow | null> {
    const { rows } = await this.pool.query<BetLogRowPg>(`SELECT * FROM bet_log WHERE bet_id = $1`, [betId]);
    return rows[0] ? rowToBetRow(rows[0]) : null;
  }

  async getByBetTxnId(betTxnId: string): Promise<BetRow | null> {
    const { rows } = await this.pool.query<BetLogRowPg>(`SELECT * FROM bet_log WHERE bet_txn_id = $1`, [betTxnId]);
    return rows[0] ? rowToBetRow(rows[0]) : null;
  }

  async listByState(state: BetState, limit = 100): Promise<BetRow[]> {
    const { rows } = await this.pool.query<BetLogRowPg>(
      `SELECT * FROM bet_log WHERE state = $1 ORDER BY created_at ASC LIMIT $2`, [state, limit]);
    return rows.map(rowToBetRow);
  }

  async listByRound(roundId: string): Promise<BetRow[]> {
    const { rows } = await this.pool.query<BetLogRowPg>(
      `SELECT * FROM bet_log WHERE round_id = $1 ORDER BY created_at ASC`, [roundId]);
    return rows.map(rowToBetRow);
  }

  async listDistinctSessionIdsByPlayer(operatorId: string, playerId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM bet_log WHERE operator_id = $1 AND player_id = $2`, [operatorId, playerId]);
    return rows.map((r) => r.session_id);
  }

  async listByPlayer(operatorId: string, playerId: string, opts?: { limit?: number; offset?: number }): Promise<BetRow[]> {
    const { rows } = await this.pool.query<BetLogRowPg>(
      `SELECT * FROM bet_log WHERE operator_id = $1 AND player_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [operatorId, playerId, opts?.limit ?? 100, opts?.offset ?? 0]);
    return rows.map(rowToBetRow);
  }

  /** Advance the state machine atomically (SELECT → validate → UPDATE in one txn). */
  async transition(
    betId: string,
    event: BetEvent,
    sideData?: Partial<{ winTxnId: string; rollbackTxnId: string; betOpTxnId: string; winOpTxnId: string; winAmountMinor: number; multiplier: number; errorCode: string }>,
  ): Promise<BetRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<BetLogRowPg>(`SELECT * FROM bet_log WHERE bet_id = $1 FOR UPDATE`, [betId]);
      if (!cur.rows[0]) throw new BetNotFoundError(betId);
      const next = nextState(cur.rows[0].state as BetState, event); // throws InvalidTransitionError

      const set: string[] = ['state = $1', 'updated_at = $2'];
      const vals: unknown[] = [next, Math.floor(Date.now() / 1000)];
      const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
      if (sideData?.winTxnId !== undefined) add('win_txn_id', sideData.winTxnId);
      if (sideData?.rollbackTxnId !== undefined) add('rollback_txn_id', sideData.rollbackTxnId);
      if (sideData?.betOpTxnId !== undefined) add('bet_op_txn_id', sideData.betOpTxnId);
      if (sideData?.winOpTxnId !== undefined) add('win_op_txn_id', sideData.winOpTxnId);
      if (sideData?.winAmountMinor !== undefined) add('win_amount_minor', sideData.winAmountMinor);
      if (sideData?.multiplier !== undefined) add('multiplier', sideData.multiplier);
      if (sideData?.errorCode !== undefined) add('error_code', sideData.errorCode);
      vals.push(betId);

      const upd = await client.query<BetLogRowPg>(
        `UPDATE bet_log SET ${set.join(', ')} WHERE bet_id = $${vals.length} RETURNING *`, vals);
      await client.query('COMMIT');
      return rowToBetRow(upd.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── txn_idempotency ─────────────────────────────────────────────────────────

  async putIdempotency(entry: IdempotencyEntry): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO txn_idempotency (txn_id, operator_id, kind, request_hash, response_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [entry.txnId, entry.operatorId, entry.kind, entry.requestHash, entry.responseJson, entry.createdAt]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate key')) {
        const existing = await this.getIdempotency(entry.operatorId, entry.txnId);
        if (existing && existing.requestHash === entry.requestHash) return; // idempotent replay
        throw new IdempotencyMismatchError(entry.txnId);
      }
      throw err;
    }
  }

  async getIdempotency(operatorId: string, txnId: string): Promise<IdempotencyEntry | null> {
    const { rows } = await this.pool.query<{ txn_id: string; operator_id: string; kind: string; request_hash: string; response_json: string; created_at: string | number }>(
      `SELECT * FROM txn_idempotency WHERE txn_id = $1 AND operator_id = $2`, [txnId, operatorId]);
    const r = rows[0];
    return r ? { txnId: r.txn_id, operatorId: r.operator_id, kind: r.kind as TxnKind, requestHash: r.request_hash, responseJson: r.response_json, createdAt: n(r.created_at) } : null;
  }

  // ── admin read API: keyset-paginated filtered lists ──────────────────────────

  async listBetsFiltered(
    f: { operatorId?: string; playerId?: string; state?: BetState; betId?: string; betTxnId?: string; from?: number; to?: number },
    page: { limit: number; cursor?: Cursor },
  ): Promise<{ rows: BetRow[]; nextCursor: string | null }> {
    const conds: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (page.cursor) conds.push(`(created_at < ${p(page.cursor.ts)} OR (created_at = ${p(page.cursor.ts)} AND bet_id < ${p(page.cursor.id)}))`);
    if (f.operatorId !== undefined) conds.push(`operator_id = ${p(f.operatorId)}`);
    if (f.playerId !== undefined) conds.push(`player_id = ${p(f.playerId)}`);
    if (f.state !== undefined) conds.push(`state = ${p(f.state)}`);
    if (f.betId !== undefined) conds.push(`bet_id = ${p(f.betId)}`);
    if (f.betTxnId !== undefined) conds.push(`bet_txn_id = ${p(f.betTxnId)}`);
    if (f.from !== undefined) conds.push(`created_at >= ${p(f.from)}`);
    if (f.to !== undefined) conds.push(`created_at < ${p(f.to)}`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows: raw } = await this.pool.query<BetLogRowPg>(
      `SELECT * FROM bet_log ${where} ORDER BY created_at DESC, bet_id DESC LIMIT ${p(page.limit)}`, params);
    const rows = raw.map(rowToBetRow);
    const nextCursor = rows.length === page.limit ? encodeCursor({ ts: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.betId }) : null;
    return { rows, nextCursor };
  }

  async listRoundsFiltered(
    f: { operatorId?: string; from?: number; to?: number; minMultiplier?: number; maxMultiplier?: number },
    page: { limit: number; cursor?: Cursor },
  ): Promise<{ rows: RoundSummary[]; nextCursor: string | null }> {
    const where: string[] = [];
    const having: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.operatorId !== undefined) where.push(`operator_id = ${p(f.operatorId)}`);
    if (f.from !== undefined) where.push(`created_at >= ${p(f.from)}`);
    if (f.to !== undefined) where.push(`created_at < ${p(f.to)}`);
    if (page.cursor) having.push(`(MAX(created_at) < ${p(page.cursor.ts)} OR (MAX(created_at) = ${p(page.cursor.ts)} AND round_id < ${p(page.cursor.id)}))`);
    if (f.minMultiplier !== undefined) having.push(`MAX(COALESCE(multiplier, 0)) >= ${p(f.minMultiplier)}`);
    if (f.maxMultiplier !== undefined) having.push(`MAX(COALESCE(multiplier, 0)) <= ${p(f.maxMultiplier)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const havingSql = having.length ? `HAVING ${having.join(' AND ')}` : '';
    const limitPh = p(page.limit);
    const { rows: raw } = await this.pool.query<{ round_id: string; operator_ids_csv: string | null; bet_count: string; distinct_players: string; max_multiplier: number | null; first_at: string | number; last_at: string | number }>(
      `SELECT round_id,
              STRING_AGG(DISTINCT operator_id, ',') AS operator_ids_csv,
              COUNT(*) AS bet_count,
              COUNT(DISTINCT player_id) AS distinct_players,
              MAX(COALESCE(multiplier, 0)) AS max_multiplier,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at
       FROM bet_log ${whereSql}
       GROUP BY round_id ${havingSql}
       ORDER BY MAX(created_at) DESC, round_id DESC
       LIMIT ${limitPh}`, params);

    const rows: RoundSummary[] = [];
    for (const r of raw) {
      const ct = await this.pool.query<{ currency: string; total: string | number }>(
        `SELECT currency, SUM(amount_minor) AS total FROM bet_log WHERE round_id = $1 GROUP BY currency`, [r.round_id]);
      const totalAmountMinorByCurrency: Record<string, number> = {};
      for (const c of ct.rows) totalAmountMinorByCurrency[c.currency] = n(c.total);
      rows.push({
        roundId: r.round_id,
        operatorIds: r.operator_ids_csv ? r.operator_ids_csv.split(',').filter(Boolean) : [],
        betCount: n(r.bet_count),
        distinctPlayers: n(r.distinct_players),
        totalAmountMinorByCurrency,
        maxMultiplier: r.max_multiplier != null && Number(r.max_multiplier) > 0 ? Number(r.max_multiplier) : null,
        firstAt: n(r.first_at),
        lastAt: n(r.last_at),
      });
    }
    const nextCursor = rows.length === page.limit ? encodeCursor({ ts: rows[rows.length - 1]!.lastAt, id: rows[rows.length - 1]!.roundId }) : null;
    return { rows, nextCursor };
  }

  async listIdempotencyFiltered(
    f: { operatorId?: string; playerId?: string; kind?: TxnKind; from?: number; to?: number },
    page: { limit: number; cursor?: Cursor },
  ): Promise<{ rows: IdempotencyWithBet[]; nextCursor: string | null }> {
    const conds: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (page.cursor) conds.push(`(ti.created_at < ${p(page.cursor.ts)} OR (ti.created_at = ${p(page.cursor.ts)} AND ti.txn_id < ${p(page.cursor.id)}))`);
    if (f.operatorId !== undefined) conds.push(`ti.operator_id = ${p(f.operatorId)}`);
    if (f.kind !== undefined) conds.push(`ti.kind = ${p(f.kind)}`);
    if (f.from !== undefined) conds.push(`ti.created_at >= ${p(f.from)}`);
    if (f.to !== undefined) conds.push(`ti.created_at < ${p(f.to)}`);
    if (f.playerId !== undefined) conds.push(`bl.player_id = ${p(f.playerId)}`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows: raw } = await this.pool.query<{ txn_id: string; operator_id: string; kind: string; request_hash: string; response_json: string; created_at: string | number; player_id: string | null; bet_id: string | null; bet_op_txn_id: string | null; win_op_txn_id: string | null; rollback_txn_id: string | null; amount_minor: string | number | null; currency: string | null; win_amount_minor: string | number | null }>(
      `SELECT ti.txn_id, ti.operator_id, ti.kind, ti.request_hash, ti.response_json, ti.created_at,
              bl.player_id, bl.bet_id, bl.bet_op_txn_id, bl.win_op_txn_id, bl.rollback_txn_id,
              bl.amount_minor, bl.currency, bl.win_amount_minor
       FROM txn_idempotency ti
       LEFT JOIN bet_log bl ON (
         (ti.kind = 'bet'      AND bl.bet_txn_id      = ti.txn_id AND bl.operator_id = ti.operator_id) OR
         (ti.kind = 'win'      AND bl.win_txn_id      = ti.txn_id AND bl.operator_id = ti.operator_id) OR
         (ti.kind = 'rollback' AND bl.rollback_txn_id = ti.txn_id AND bl.operator_id = ti.operator_id))
       ${where}
       ORDER BY ti.created_at DESC, ti.txn_id DESC
       LIMIT ${p(page.limit)}`, params);

    const rows: IdempotencyWithBet[] = raw.map((r) => ({
      txnId: r.txn_id, operatorId: r.operator_id, kind: r.kind as TxnKind, requestHash: r.request_hash,
      responseJson: r.response_json, createdAt: n(r.created_at), playerId: r.player_id ?? null, betId: r.bet_id ?? null,
      operatorTxnId: r.kind === 'bet' ? (r.bet_op_txn_id ?? null) : r.kind === 'win' ? (r.win_op_txn_id ?? null) : null,
      amountMinor: nn(r.amount_minor), currency: r.currency ?? null, winAmountMinor: nn(r.win_amount_minor),
    }));
    const nextCursor = rows.length === page.limit ? encodeCursor({ ts: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.txnId }) : null;
    return { rows, nextCursor };
  }

  async listSessionsByPlayer(
    operatorId: string, playerId: string, page: { limit: number; cursor?: Cursor },
  ): Promise<{ rows: PlayerSessionSummary[]; nextCursor: string | null }> {
    const having: string[] = [];
    const params: unknown[] = [operatorId, playerId];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (page.cursor) having.push(`(MAX(created_at) < ${p(page.cursor.ts)} OR (MAX(created_at) = ${p(page.cursor.ts)} AND session_id < ${p(page.cursor.id)}))`);
    const havingSql = having.length ? `HAVING ${having.join(' AND ')}` : '';
    const { rows: raw } = await this.pool.query<{ session_id: string; started_at: string | number; ended_at: string | number; currency: string; bet_count: string; stake_minor: string | number | null; win_minor: string | number | null }>(
      `SELECT session_id, MIN(created_at) AS started_at, MAX(created_at) AS ended_at, MIN(currency) AS currency,
              COUNT(*) AS bet_count, SUM(amount_minor) AS stake_minor,
              SUM(CASE WHEN state = 'SETTLED' THEN COALESCE(win_amount_minor,0) ELSE 0 END) AS win_minor
       FROM bet_log WHERE operator_id = $1 AND player_id = $2
       GROUP BY session_id ${havingSql}
       ORDER BY MAX(created_at) DESC, session_id DESC
       LIMIT ${p(page.limit)}`, params);
    const rows: PlayerSessionSummary[] = raw.map((r) => ({
      sessionId: r.session_id, startedAt: n(r.started_at), endedAt: n(r.ended_at), currency: r.currency,
      betCount: n(r.bet_count), stakeMinor: n(r.stake_minor), winMinor: n(r.win_minor),
    }));
    const nextCursor = rows.length === page.limit ? encodeCursor({ ts: rows[rows.length - 1]!.endedAt, id: rows[rows.length - 1]!.sessionId }) : null;
    return { rows, nextCursor };
  }

  // ── financial GGR/NGR report ──────────────────────────────────────────────

  async financialReport(filter: FinancialFilter): Promise<FinancialRow[]> {
    const VALID = new Set(['operator', 'currency', 'day']);
    if (!filter.groupBy || filter.groupBy.length === 0) {
      throw new Error('groupBy must be a non-empty array containing at least one of: operator, currency, day');
    }
    for (const g of filter.groupBy) if (!VALID.has(g)) throw new Error(`Unknown groupBy value '${g}'. Valid values: operator, currency, day`);

    const byOperator = filter.groupBy.includes('operator');
    const byCurrency = filter.groupBy.includes('currency');
    const byDay = filter.groupBy.includes('day');
    const select: string[] = [];
    const groupBy: string[] = [];
    const orderBy: string[] = [];
    const dayExpr = `to_char(to_timestamp(created_at), 'YYYY-MM-DD')`;

    if (byOperator) { select.push('operator_id'); groupBy.push('operator_id'); orderBy.push('operator_id ASC'); }
    else select.push('NULL::text AS operator_id');
    if (byCurrency) { select.push('currency'); groupBy.push('currency'); orderBy.push('currency ASC'); }
    else select.push('NULL::text AS currency');
    if (byDay) { select.push(`${dayExpr} AS day`); groupBy.push(dayExpr); orderBy.push('day ASC'); }
    else select.push('NULL::text AS day');

    select.push(`
      SUM(CASE WHEN state IN ('SETTLED','LOST','WIN_FAILED') THEN 1 ELSE 0 END) AS bet_count,
      SUM(CASE WHEN state IN ('SETTLED','LOST','WIN_FAILED') THEN amount_minor ELSE 0 END) AS stake_minor,
      SUM(CASE WHEN state = 'SETTLED' THEN COALESCE(win_amount_minor,0) ELSE 0 END) AS win_minor`);

    const conds: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (filter.operatorId !== undefined) conds.push(`operator_id = ${p(filter.operatorId)}`);
    if (filter.currency !== undefined) conds.push(`currency = ${p(filter.currency)}`);
    if (filter.from !== undefined) conds.push(`created_at >= ${p(filter.from)}`);
    if (filter.to !== undefined) conds.push(`created_at < ${p(filter.to)}`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const groupSql = groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : '';
    const orderSql = orderBy.length ? `ORDER BY ${orderBy.join(', ')}` : '';

    const { rows: raw } = await this.pool.query<{ operator_id: string | null; currency: string | null; day: string | null; bet_count: string; stake_minor: string | number; win_minor: string | number }>(
      `SELECT ${select.join(', ')} FROM bet_log ${where} ${groupSql} ${orderSql} LIMIT 100000`, params);

    return raw.map((r) => {
      const stakeMinor = n(r.stake_minor);
      const winMinor = n(r.win_minor);
      const ggrMinor = stakeMinor - winMinor;
      return { operatorId: r.operator_id, currency: r.currency, day: r.day, betCount: n(r.bet_count), stakeMinor, winMinor, ggrMinor, ngrMinor: ggrMinor };
    });
  }
}
