/**
 * reconciler.ts — Reconciliation store + diff engine (Task 8.1, spec §9).
 *
 * Owns the `reconciliation_runs` and `reconciliation_mismatches` tables in the
 * shared SQLite DB. A run diffs OUR recorded transactions (txn_idempotency, via
 * BetLog.listIdempotencyFiltered) against an operator's ledger (an injected
 * OperatorLedgerSource) over a half-open window [windowStart, windowEnd).
 *
 * Mirrors the class-owns-table / _ensureSchema() / lazy-prepared-statement /
 * keyset-listFiltered structure of AdminAudit and OperatorAudit.
 *
 * Run status lifecycle:
 *   RUNNING (transient — only persisted while in-flight) →
 *     OK         (no mismatches),
 *     MISMATCHES (≥1 mismatch), or
 *     FAILED     (the operator-ledger source threw).
 *
 * On source failure we DELIBERATELY resolve with a persisted FAILED run rather
 * than rethrowing — a single bad operator feed must not crash the daily
 * scheduler that iterates every operator. The POST endpoint surfaces FAILED to
 * the caller (202 with status:'FAILED'); callers can inspect/retry.
 */

import type { Database } from 'better-sqlite3';
import type { BetLog } from './bet-log.js';
import { type Cursor, encodeCursor, decodeCursor } from './cursor.js';

// ---------------------------------------------------------------------------
// Derive Statement type without importing the namespace type (mirrors bet-log.ts)
// ---------------------------------------------------------------------------

type SqliteStatement<P extends unknown[] = unknown[]> = ReturnType<Database['prepare']> & {
  run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  get(...params: P): unknown;
  all(...params: P): unknown[];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReconKind =
  | 'missing_on_operator'
  | 'missing_on_game'
  | 'amount_mismatch'
  | 'status_mismatch';

export type ReconStatus = 'OK' | 'MISMATCHES' | 'FAILED';

/** Status of a single transaction as derived/reported on either side. */
export type ReconTxnStatus = 'OK' | 'FAILED';

/** One transaction as the OPERATOR reports it, for the window. */
export interface OperatorLedgerTxn {
  txnId: string;
  amountMinor: number;
  status: ReconTxnStatus;
}

/**
 * Injected source: fetch the operator's ledger for the half-open window
 * [windowStart, windowEnd). The real per-operator reconciliation feed is wired
 * here (Phase-future); absent a feed the default source returns [].
 */
export type OperatorLedgerSource = (
  operatorId: string,
  windowStart: number,
  windowEnd: number,
) => Promise<OperatorLedgerTxn[]>;

export interface ReconRun {
  id: number;
  operatorId: string;
  windowStart: number;
  windowEnd: number;
  checkedCount: number;
  mismatchCount: number;
  status: ReconStatus;
  startedAt: number;
  finishedAt: number | null;
}

export interface ReconMismatch {
  txnId: string;
  kind: ReconKind;
  details: Record<string, unknown>;
}

interface ReconRunRow {
  id: number;
  operator_id: string;
  window_start: number;
  window_end: number;
  checked_count: number;
  mismatch_count: number;
  status: string;
  started_at: number;
  finished_at: number | null;
}

interface ReconMismatchRow {
  txn_id: string;
  kind: string;
  details_json: string;
}

/** Our derived view of one transaction. */
interface SideTxn {
  amountMinor: number;
  status: ReconTxnStatus;
}

// ---------------------------------------------------------------------------
// Derivation helpers — REUSED from the same rules as admin.ts /transactions and
// operator.ts /operator-tx so OUR records map identically everywhere.
// ---------------------------------------------------------------------------

/**
 * Effective amount for a txn_idempotency row joined with bet_log:
 * win rows use win_amount_minor; everything else uses amount_minor.
 * Mirrors admin.ts /transactions and operator.ts /operator-tx.
 */
export function deriveTxnAmountMinor(r: {
  kind: 'bet' | 'win' | 'rollback';
  amountMinor: number | null;
  winAmountMinor: number | null;
}): number {
  const v = r.kind === 'win' ? r.winAmountMinor : r.amountMinor;
  return v ?? 0;
}

/**
 * Status of OUR stored txn, derived from response_json: ok===false → FAILED,
 * otherwise OK. Mirrors admin.ts /transactions and operator.ts /operator-tx.
 */
export function deriveTxnStatus(responseJson: string): ReconTxnStatus {
  try {
    const resp = JSON.parse(responseJson) as Record<string, unknown>;
    if (resp['ok'] === false) return 'FAILED';
  } catch {
    // unparseable → treat as OK (it was stored, so it succeeded at store time)
  }
  return 'OK';
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export class Reconciler {
  private readonly db: Database;
  private readonly source: OperatorLedgerSource;
  private readonly betLog: BetLog;
  private readonly nowSeconds: () => number;

  constructor(
    db: Database,
    opts: { source: OperatorLedgerSource; betLog: BetLog; nowSeconds?: () => number },
  ) {
    this.db = db;
    this.source = opts.source;
    this.betLog = opts.betLog;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this._ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id   TEXT NOT NULL,
        window_start  INTEGER NOT NULL,
        window_end    INTEGER NOT NULL,
        checked_count INTEGER NOT NULL,
        mismatch_count INTEGER NOT NULL,
        status        TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_recon_runs_operator ON reconciliation_runs(operator_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_recon_runs_keyset   ON reconciliation_runs(started_at, id);

      CREATE TABLE IF NOT EXISTS reconciliation_mismatches (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       INTEGER NOT NULL REFERENCES reconciliation_runs(id),
        txn_id       TEXT NOT NULL,
        kind         TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recon_mismatches_run ON reconciliation_mismatches(run_id);
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
  // run — execute a reconciliation over [windowStart, windowEnd)
  // -------------------------------------------------------------------------

  async run(operatorId: string, windowStart: number, windowEnd: number): Promise<ReconRun> {
    const startedAt = this.nowSeconds();

    // 1. Insert a transient RUNNING row; capture its id.
    const insert = this.stmt(
      'insert_run',
      `INSERT INTO reconciliation_runs
         (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
       VALUES (@operator_id, @window_start, @window_end, 0, 0, 'RUNNING', @started_at, NULL)`,
    ).run({
      operator_id: operatorId,
      window_start: windowStart,
      window_end: windowEnd,
      started_at: startedAt,
    });
    const runId = Number(insert.lastInsertRowid);

    // 2. Gather OUR records by paging through txn_idempotency for the window.
    const ours = new Map<string, SideTxn>();
    let cursor: Cursor | undefined;
    for (;;) {
      const { rows, nextCursor } = this.betLog.listIdempotencyFiltered(
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
        `[Reconciler] operator-ledger source failed for operator '${operatorId}' — marking run ${runId} FAILED (non-fatal):`,
        err,
      );
      const finishedAt = this.nowSeconds();
      this.stmt(
        'finish_run',
        `UPDATE reconciliation_runs
            SET checked_count = @checked_count, mismatch_count = @mismatch_count,
                status = @status, finished_at = @finished_at
          WHERE id = @id`,
      ).run({
        id: runId,
        checked_count: 0,
        mismatch_count: 0,
        status: 'FAILED',
        finished_at: finishedAt,
      });
      return this.getRunRow(runId)!;
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

    // 5. Persist mismatches + finalise the run in a single transaction.
    const insertMismatch = this.stmt(
      'insert_mismatch',
      `INSERT INTO reconciliation_mismatches (run_id, txn_id, kind, details_json)
       VALUES (@run_id, @txn_id, @kind, @details_json)`,
    );
    const finishRun = this.stmt(
      'finish_run',
      `UPDATE reconciliation_runs
          SET checked_count = @checked_count, mismatch_count = @mismatch_count,
              status = @status, finished_at = @finished_at
        WHERE id = @id`,
    );
    const finishedAt = this.nowSeconds();

    this.db.transaction(() => {
      for (const m of mismatches) {
        insertMismatch.run({
          run_id: runId,
          txn_id: m.txnId,
          kind: m.kind,
          details_json: JSON.stringify(m.details),
        });
      }
      finishRun.run({
        id: runId,
        checked_count: checkedCount,
        mismatch_count: mismatchCount,
        status,
        finished_at: finishedAt,
      });
    })();

    return this.getRunRow(runId)!;
  }

  // -------------------------------------------------------------------------
  // listRuns — keyset (started_at DESC, id DESC), half-open from/to on started_at
  // -------------------------------------------------------------------------

  listRuns(
    filter: { operatorId?: string; from?: number; to?: number; status?: ReconStatus },
    page: { limit: number; cursor?: Cursor },
  ): { rows: ReconRun[]; nextCursor: string | null } {
    const conds: string[] = [];
    const params: unknown[] = [];

    // Keyset cursor on (started_at DESC, id DESC)
    if (page.cursor) {
      conds.push('(started_at < ? OR (started_at = ? AND id < ?))');
      params.push(page.cursor.ts, page.cursor.ts, Number(page.cursor.id));
    }
    if (filter.operatorId !== undefined) {
      conds.push('operator_id = ?');
      params.push(filter.operatorId);
    }
    if (filter.from !== undefined) {
      conds.push('started_at >= ?'); // inclusive lower bound (spec §2.2)
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conds.push('started_at < ?'); // exclusive upper bound (spec §2.2)
      params.push(filter.to);
    }
    if (filter.status !== undefined) {
      conds.push('status = ?');
      params.push(filter.status);
    }

    // RUNNING rows are transient/internal and MUST NOT appear in public listings
    // (the public enum is OK | MISMATCHES | FAILED — see spec §9 status lifecycle).
    conds.push("status != 'RUNNING'");

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const sql = `SELECT * FROM reconciliation_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`;
    params.push(page.limit);

    const raw = this.db.prepare(sql).all(...params) as ReconRunRow[];
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

  getRun(id: number): { run: ReconRun; mismatches: ReconMismatch[] } | null {
    const run = this.getRunRow(id);
    if (!run) return null;
    // RUNNING is transient/internal — surface as not-found to external callers.
    if (run.status === ('RUNNING' as ReconStatus)) return null;

    const rawMismatches = this.stmt(
      'get_mismatches',
      `SELECT txn_id, kind, details_json FROM reconciliation_mismatches WHERE run_id = ? ORDER BY id ASC`,
    ).all(id) as ReconMismatchRow[];

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

  private getRunRow(id: number): ReconRun | null {
    const row = this.stmt(
      'get_run',
      `SELECT * FROM reconciliation_runs WHERE id = ?`,
    ).get(id) as ReconRunRow | undefined;
    return row ? rowToReconRun(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

function rowToReconRun(row: ReconRunRow): ReconRun {
  return {
    id: row.id,
    operatorId: row.operator_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    checkedCount: row.checked_count,
    mismatchCount: row.mismatch_count,
    status: row.status as ReconStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}
