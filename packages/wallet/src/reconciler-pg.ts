/**
 * reconciler-pg.ts — Postgres port of the SQLite Reconciler (Wave B pt3).
 *
 * Faithful async port of `reconciler.ts`. Same diff engine, same status
 * lifecycle (RUNNING → OK | MISMATCHES | FAILED), same non-rethrow-on-source-
 * failure behavior. The public types + derivation helpers are re-exported from
 * './reconciler.js' so callers import everything from one place.
 *
 * Tables (reconciliation_runs, reconciliation_mismatches) are owned by
 * pg.ts:bootstrapCasinoSchema — this class only reads/writes them. pg returns
 * bigint/bigserial columns as strings, so every numeric column is coerced with
 * Number().
 */

import type { Pool, PoolClient } from 'pg';
import type { PgBetLog } from './bet-log-pg.js';
import { type Cursor, encodeCursor, decodeCursor } from './cursor.js';
import {
  deriveTxnAmountMinor,
  deriveTxnStatus,
  type ReconKind,
  type ReconStatus,
  type ReconTxnStatus,
  type OperatorLedgerSource,
  type ReconRun,
  type ReconMismatch,
} from './reconciler.js';

// Re-export the shared public surface so callers import from one place.
export {
  deriveTxnAmountMinor,
  deriveTxnStatus,
  type ReconKind,
  type ReconStatus,
  type ReconTxnStatus,
  type OperatorLedgerTxn,
  type OperatorLedgerSource,
  type ReconRun,
  type ReconMismatch,
} from './reconciler.js';

// ---------------------------------------------------------------------------
// Row shapes — pg returns bigint/bigserial as strings.
// ---------------------------------------------------------------------------

interface ReconRunRowPg {
  id: string | number;
  operator_id: string;
  window_start: string | number;
  window_end: string | number;
  checked_count: string | number;
  mismatch_count: string | number;
  status: string;
  started_at: string | number;
  finished_at: string | number | null;
}

interface ReconMismatchRowPg {
  txn_id: string;
  kind: string;
  details_json: string;
}

/** Our derived view of one transaction. */
interface SideTxn {
  amountMinor: number;
  status: ReconTxnStatus;
}

function rowToReconRun(row: ReconRunRowPg): ReconRun {
  return {
    id: Number(row.id),
    operatorId: row.operator_id,
    windowStart: Number(row.window_start),
    windowEnd: Number(row.window_end),
    checkedCount: Number(row.checked_count),
    mismatchCount: Number(row.mismatch_count),
    status: row.status as ReconStatus,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

// ---------------------------------------------------------------------------
// PgReconciler
// ---------------------------------------------------------------------------

export class PgReconciler {
  private readonly pool: Pool;
  private readonly source: OperatorLedgerSource;
  private readonly betLog: PgBetLog;
  private readonly nowSeconds: () => number;

  constructor(
    pool: Pool,
    opts: { source: OperatorLedgerSource; betLog: PgBetLog; nowSeconds?: () => number },
  ) {
    this.pool = pool;
    this.source = opts.source;
    this.betLog = opts.betLog;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  // -------------------------------------------------------------------------
  // run — execute a reconciliation over [windowStart, windowEnd)
  // -------------------------------------------------------------------------

  async run(operatorId: string, windowStart: number, windowEnd: number): Promise<ReconRun> {
    const startedAt = this.nowSeconds();

    // 1. Insert a transient RUNNING row; capture its id.
    const { rows: insRows } = await this.pool.query<{ id: string | number }>(
      `INSERT INTO reconciliation_runs
         (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
       VALUES ($1, $2, $3, 0, 0, 'RUNNING', $4, NULL) RETURNING id`,
      [operatorId, windowStart, windowEnd, startedAt],
    );
    const runId = Number(insRows[0]!.id);

    // 2. Gather OUR records by paging through txn_idempotency for the window.
    const ours = new Map<string, SideTxn>();
    let cursor: Cursor | undefined;
    for (;;) {
      const { rows, nextCursor } = await this.betLog.listIdempotencyFiltered(
        { operatorId, from: windowStart, to: windowEnd },
        { limit: 200, cursor },
      );
      for (const r of rows) {
        ours.set(r.txnId, {
          amountMinor: deriveTxnAmountMinor(r),
          status: deriveTxnStatus(r.responseJson),
        });
      }
      if (nextCursor === null) break;
      const decoded = decodeCursor(nextCursor);
      if (!decoded) break; // defensive — our own cursors are always valid
      cursor = decoded;
    }

    // 3. Fetch THEIR records via the injected source. On failure → FAILED run.
    let theirs: Map<string, SideTxn>;
    try {
      const ledger = await this.source(operatorId, windowStart, windowEnd);
      theirs = new Map<string, SideTxn>();
      for (const t of ledger) {
        theirs.set(t.txnId, { amountMinor: t.amountMinor, status: t.status });
      }
    } catch (err) {
      console.error(
        `[PgReconciler] operator-ledger source failed for operator '${operatorId}' — marking run ${runId} FAILED (non-fatal):`,
        err,
      );
      const finishedAt = this.nowSeconds();
      await this.pool.query(
        `UPDATE reconciliation_runs
            SET checked_count = $1, mismatch_count = $2, status = $3, finished_at = $4
          WHERE id = $5`,
        [0, 0, 'FAILED', finishedAt, runId],
      );
      return (await this.getRunRow(runId))!;
    }

    // 4. Diff over the union of txnIds.
    const allTxnIds = new Set<string>([...ours.keys(), ...theirs.keys()]);
    const mismatches: ReconMismatch[] = [];

    for (const txnId of allTxnIds) {
      const o = ours.get(txnId);
      const t = theirs.get(txnId);

      if (o && !t) {
        mismatches.push({
          txnId,
          kind: 'missing_on_operator',
          details: { ourAmountMinor: o.amountMinor, operatorRecord: null },
        });
      } else if (!o && t) {
        mismatches.push({
          txnId,
          kind: 'missing_on_game',
          details: { theirAmountMinor: t.amountMinor, ourRecord: null },
        });
      } else if (o && t) {
        if (o.amountMinor !== t.amountMinor) {
          mismatches.push({
            txnId,
            kind: 'amount_mismatch',
            details: { ours: o.amountMinor, theirs: t.amountMinor },
          });
        } else if (o.status !== t.status) {
          mismatches.push({
            txnId,
            kind: 'status_mismatch',
            details: { ours: o.status, theirs: t.status },
          });
        }
        // both present, amount equal, status equal → match (no mismatch)
      }
    }

    const checkedCount = allTxnIds.size;
    const mismatchCount = mismatches.length;
    const status: ReconStatus = mismatchCount > 0 ? 'MISMATCHES' : 'OK';
    const finishedAt = this.nowSeconds();

    // 5. Persist mismatches + finalise the run in a single transaction.
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of mismatches) {
        await client.query(
          `INSERT INTO reconciliation_mismatches (run_id, txn_id, kind, details_json)
           VALUES ($1, $2, $3, $4)`,
          [runId, m.txnId, m.kind, JSON.stringify(m.details)],
        );
      }
      await client.query(
        `UPDATE reconciliation_runs
            SET checked_count = $1, mismatch_count = $2, status = $3, finished_at = $4
          WHERE id = $5`,
        [checkedCount, mismatchCount, status, finishedAt, runId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return (await this.getRunRow(runId))!;
  }

  // -------------------------------------------------------------------------
  // listRuns — keyset (started_at DESC, id DESC), half-open from/to on started_at
  // -------------------------------------------------------------------------

  async listRuns(
    filter: { operatorId?: string; from?: number; to?: number; status?: ReconStatus },
    page: { limit: number; cursor?: Cursor },
  ): Promise<{ rows: ReconRun[]; nextCursor: string | null }> {
    const conds: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    // Keyset cursor on (started_at DESC, id DESC)
    if (page.cursor) {
      conds.push(
        `(started_at < ${p(page.cursor.ts)} OR (started_at = ${p(page.cursor.ts)} AND id < ${p(Number(page.cursor.id))}))`,
      );
    }
    if (filter.operatorId !== undefined) conds.push(`operator_id = ${p(filter.operatorId)}`);
    if (filter.from !== undefined) conds.push(`started_at >= ${p(filter.from)}`); // inclusive lower bound
    if (filter.to !== undefined) conds.push(`started_at < ${p(filter.to)}`); // exclusive upper bound
    if (filter.status !== undefined) conds.push(`status = ${p(filter.status)}`);

    // RUNNING rows are transient/internal and MUST NOT appear in public listings.
    conds.push(`status != 'RUNNING'`);

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows: raw } = await this.pool.query<ReconRunRowPg>(
      `SELECT * FROM reconciliation_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ${p(page.limit)}`,
      params,
    );
    const rows = raw.map(rowToReconRun);

    let nextCursor: string | null = null;
    if (rows.length === page.limit) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({ ts: last.startedAt, id: String(last.id) });
    }

    return { rows, nextCursor };
  }

  // -------------------------------------------------------------------------
  // getRun — run + its mismatches (details decoded), or null
  // -------------------------------------------------------------------------

  async getRun(id: number): Promise<{ run: ReconRun; mismatches: ReconMismatch[] } | null> {
    const run = await this.getRunRow(id);
    if (!run) return null;
    // RUNNING is transient/internal — surface as not-found to external callers.
    if (run.status === ('RUNNING' as ReconStatus)) return null;

    const { rows: rawMismatches } = await this.pool.query<ReconMismatchRowPg>(
      `SELECT txn_id, kind, details_json FROM reconciliation_mismatches WHERE run_id = $1 ORDER BY id ASC`,
      [id],
    );

    const mismatches: ReconMismatch[] = rawMismatches.map((m) => {
      let details: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(m.details_json) as unknown;
        if (parsed && typeof parsed === 'object') details = parsed as Record<string, unknown>;
      } catch {
        details = {};
      }
      return { txnId: m.txn_id, kind: m.kind as ReconKind, details };
    });

    return { run, mismatches };
  }

  private async getRunRow(id: number): Promise<ReconRun | null> {
    const { rows } = await this.pool.query<ReconRunRowPg>(
      `SELECT * FROM reconciliation_runs WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToReconRun(rows[0]) : null;
  }
}
