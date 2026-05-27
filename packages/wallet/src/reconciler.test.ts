/**
 * Reconciler tests — Task 8.1 (spec §9).
 *
 * Hermetic per test: a fresh :memory: better-sqlite3 + real BetLog seeded via
 * its public putIdempotency/create APIs (so listIdempotencyFiltered returns the
 * seeded rows as it does in production). The operator-ledger source is injected
 * as a plain async fn — that is the production contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetLog, type CreateBetInput } from './bet-log.js';
import {
  Reconciler,
  type OperatorLedgerSource,
  type OperatorLedgerTxn,
  type ReconStatus,
} from './reconciler.js';
import { decodeCursor } from './cursor.js';

function makeDb() {
  return new Database(':memory:');
}

/**
 * Seed one OUR-side transaction by inserting a bet_log row and the matching
 * txn_idempotency row. Returns the (operatorId, txnId, amountMinor, status).
 */
function seedOurTxn(
  log: BetLog,
  opts: {
    operatorId: string;
    txnId: string;
    kind: 'bet' | 'win' | 'rollback';
    amountMinor: number;       // bet/rollback amount; for win this is bet-side stake
    winAmountMinor?: number;   // required when kind='win'; this is the effective amount
    status?: 'OK' | 'FAILED';
    createdAt?: number;
    betId?: string;
    betTxnId?: string;
  },
): { operatorId: string; txnId: string; amountMinor: number; status: 'OK' | 'FAILED' } {
  const status = opts.status ?? 'OK';
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);
  const betId = opts.betId ?? `bet-${opts.txnId}`;
  const betTxnId = opts.betTxnId ?? (opts.kind === 'bet' ? opts.txnId : `btxn-${betId}`);

  const input: CreateBetInput = {
    betId,
    operatorId: opts.operatorId,
    playerId: 'pl-1',
    sessionId: 'sess-1',
    roundId: 'rnd-1',
    currency: 'EUR',
    amountMinor: opts.amountMinor,
    betTxnId,
  };

  // Create the bet row if it doesn't exist (guarded by primary key)
  try { log.create(input); } catch { /* already exists — kind=win/rollback can share a bet */ }

  // For win/rollback, attach the appropriate side-data so the JOIN in
  // listIdempotencyFiltered yields the right amount.
  if (opts.kind === 'win') {
    // Move to SETTLED with winTxnId / winAmountMinor — multi-step
    log.transition(betId, 'bet_accepted');
    log.transition(betId, 'round_started');
    log.transition(betId, 'cashout_requested');
    log.transition(betId, 'win_settled', {
      winTxnId: opts.txnId,
      winAmountMinor: opts.winAmountMinor ?? opts.amountMinor,
      multiplier: 2,
    });
  } else if (opts.kind === 'rollback') {
    // Move PENDING → ROLLBACK_PENDING → VOIDED with rollbackTxnId
    log.transition(betId, 'bet_accepted');
    log.transition(betId, 'rollback_requested', { rollbackTxnId: opts.txnId });
    log.transition(betId, 'rollback_acked');
  }

  const responseJson = status === 'OK' ? '{"ok":true}' : '{"ok":false,"error":{"code":"X"}}';
  log.putIdempotency({
    txnId: opts.txnId,
    operatorId: opts.operatorId,
    kind: opts.kind,
    requestHash: `h-${opts.txnId}`,
    responseJson,
    createdAt,
  });

  return {
    operatorId: opts.operatorId,
    txnId: opts.txnId,
    amountMinor: opts.kind === 'win' ? (opts.winAmountMinor ?? opts.amountMinor) : opts.amountMinor,
    status,
  };
}

function makeSource(rows: OperatorLedgerTxn[]): OperatorLedgerSource {
  return async () => rows;
}

const throwingSource: OperatorLedgerSource = async () => {
  throw new Error('simulated ledger feed failure');
};

describe('Reconciler.run — diff engine', () => {
  let db: InstanceType<typeof Database>;
  let log: BetLog;

  beforeEach(() => {
    db = makeDb();
    log = new BetLog(db);
  });

  it('all four mismatch kinds + matches: checked/mismatch counts, status MISMATCHES, exact details', async () => {
    // OUR side (5 txns):
    //   m1  bet  500  OK   — also on theirs, equal       → match
    //   m2  bet  600  OK   — also on theirs, equal       → match
    //   miss-op  bet 700 OK — missing from theirs        → missing_on_operator
    //   amt-mis  bet 800 OK — theirs has 850             → amount_mismatch
    //   stat-mis bet 900 OK — theirs has FAILED          → status_mismatch
    seedOurTxn(log, { operatorId: 'op-1', txnId: 'm1',        kind: 'bet', amountMinor: 500 });
    seedOurTxn(log, { operatorId: 'op-1', txnId: 'm2',        kind: 'bet', amountMinor: 600 });
    seedOurTxn(log, { operatorId: 'op-1', txnId: 'miss-op',   kind: 'bet', amountMinor: 700 });
    seedOurTxn(log, { operatorId: 'op-1', txnId: 'amt-mis',   kind: 'bet', amountMinor: 800 });
    seedOurTxn(log, { operatorId: 'op-1', txnId: 'stat-mis',  kind: 'bet', amountMinor: 900 });

    // THEIRS side (5 txns):
    //   m1, m2 — match.  amt-mis (850 ≠ 800). stat-mis (900 FAILED ≠ OK).  miss-game (only theirs).
    const source = makeSource([
      { txnId: 'm1',        amountMinor: 500, status: 'OK'     },
      { txnId: 'm2',        amountMinor: 600, status: 'OK'     },
      { txnId: 'amt-mis',   amountMinor: 850, status: 'OK'     },
      { txnId: 'stat-mis',  amountMinor: 900, status: 'FAILED' },
      { txnId: 'miss-game', amountMinor: 1100, status: 'OK'    },
    ]);

    const rc = new Reconciler(db, { source, betLog: log });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-1', now - 86400, now + 86400);

    expect(run.status).toBe('MISMATCHES' as ReconStatus);
    expect(run.operatorId).toBe('op-1');
    expect(run.checkedCount).toBe(6); // union: m1,m2,miss-op,amt-mis,stat-mis,miss-game
    expect(run.mismatchCount).toBe(4);
    expect(run.finishedAt).not.toBeNull();
    expect(run.finishedAt!).toBeGreaterThanOrEqual(run.startedAt);

    const fetched = rc.getRun(run.id);
    expect(fetched).not.toBeNull();
    const byTxn = new Map(fetched!.mismatches.map((m) => [m.txnId, m]));

    const m1 = byTxn.get('miss-op');
    expect(m1).toBeDefined();
    expect(m1!.kind).toBe('missing_on_operator');
    expect(m1!.details).toEqual({ ourAmountMinor: 700, operatorRecord: null });

    const m2 = byTxn.get('miss-game');
    expect(m2).toBeDefined();
    expect(m2!.kind).toBe('missing_on_game');
    expect(m2!.details).toEqual({ theirAmountMinor: 1100, ourRecord: null });

    const m3 = byTxn.get('amt-mis');
    expect(m3).toBeDefined();
    expect(m3!.kind).toBe('amount_mismatch');
    expect(m3!.details).toEqual({ ours: 800, theirs: 850 });

    const m4 = byTxn.get('stat-mis');
    expect(m4).toBeDefined();
    expect(m4!.kind).toBe('status_mismatch');
    expect(m4!.details).toEqual({ ours: 'OK', theirs: 'FAILED' });
  });

  it('all-match run → status=OK, zero mismatches', async () => {
    seedOurTxn(log, { operatorId: 'op-2', txnId: 'a', kind: 'bet', amountMinor: 100 });
    seedOurTxn(log, { operatorId: 'op-2', txnId: 'b', kind: 'bet', amountMinor: 200 });

    const source = makeSource([
      { txnId: 'a', amountMinor: 100, status: 'OK' },
      { txnId: 'b', amountMinor: 200, status: 'OK' },
    ]);
    const rc = new Reconciler(db, { source, betLog: log });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-2', now - 3600, now + 3600);

    expect(run.status).toBe('OK' as ReconStatus);
    expect(run.checkedCount).toBe(2);
    expect(run.mismatchCount).toBe(0);
    const got = rc.getRun(run.id);
    expect(got).not.toBeNull();
    expect(got!.mismatches).toEqual([]);
  });

  it('source throws → run persisted as FAILED (does not rethrow)', async () => {
    seedOurTxn(log, { operatorId: 'op-3', txnId: 'x', kind: 'bet', amountMinor: 50 });

    const rc = new Reconciler(db, { source: throwingSource, betLog: log });
    const now = Math.floor(Date.now() / 1000);

    // Must resolve, not reject.
    const run = await rc.run('op-3', now - 60, now + 60);
    expect(run.status).toBe('FAILED' as ReconStatus);
    expect(run.finishedAt).not.toBeNull();

    // Visible via getRun (FAILED is a public terminal state).
    const got = rc.getRun(run.id);
    expect(got).not.toBeNull();
    expect(got!.run.status).toBe('FAILED' as ReconStatus);
  });

  it('win-kind uses winAmountMinor as the effective amount', async () => {
    // bet stake = 100, but the win row should expose amountMinor = winAmountMinor = 250.
    seedOurTxn(log, {
      operatorId: 'op-4', txnId: 'wtxn-1', kind: 'win',
      amountMinor: 100, winAmountMinor: 250,
    });

    // operator says 250 → match. If derivation were wrong (used 100), this would
    // surface as amount_mismatch.
    const rc = new Reconciler(db, {
      source: makeSource([{ txnId: 'wtxn-1', amountMinor: 250, status: 'OK' }]),
      betLog: log,
    });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-4', now - 60, now + 60);
    expect(run.status).toBe('OK' as ReconStatus);
    expect(run.mismatchCount).toBe(0);
  });
});

describe('Reconciler.listRuns — keyset pagination + filters', () => {
  let db: InstanceType<typeof Database>;
  let log: BetLog;

  beforeEach(() => {
    db = makeDb();
    log = new BetLog(db);
  });

  it('keyset pagination across multiple pages: no dup, no gap, exact total', async () => {
    const rc = new Reconciler(db, { source: makeSource([]), betLog: log });
    // Insert 7 RUNS with strictly increasing startedAt by using nowSeconds injection.
    // We do this by directly inserting completed run rows (the diff engine itself is
    // tested above; here we just need rows to page).
    const base = 1_700_000_000;
    const insert = db.prepare(`
      INSERT INTO reconciliation_runs
        (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 7; i++) {
      insert.run('op-page', 0, 1, 0, 0, 'OK', base + i, base + i + 1);
    }

    // Page size 3 → expect [3,3,1] with no overlap.
    const seen: number[] = [];
    let cursor: string | null = null;
    let safety = 10;
    do {
      const page = rc.listRuns({}, { limit: 3, cursor: cursor ? decodeCursor(cursor)! : undefined });
      for (const r of page.rows) seen.push(r.id);
      cursor = page.nextCursor;
      safety -= 1;
    } while (cursor !== null && safety > 0);

    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);                                // no dup
    // DESC order across pages
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]!);
  });

  it('status filter narrows results; bad/other statuses excluded', async () => {
    const rc = new Reconciler(db, { source: makeSource([]), betLog: log });
    const base = 1_700_100_000;
    const insert = db.prepare(`
      INSERT INTO reconciliation_runs
        (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('op-f', 0, 1, 0, 0, 'OK',         base + 1, base + 2);
    insert.run('op-f', 0, 1, 0, 1, 'MISMATCHES', base + 3, base + 4);
    insert.run('op-f', 0, 1, 0, 0, 'FAILED',     base + 5, base + 6);

    const ok = rc.listRuns({ status: 'OK' }, { limit: 50 });
    expect(ok.rows.length).toBe(1);
    expect(ok.rows[0]!.status).toBe('OK' as ReconStatus);

    const failed = rc.listRuns({ status: 'FAILED' }, { limit: 50 });
    expect(failed.rows.length).toBe(1);
    expect(failed.rows[0]!.status).toBe('FAILED' as ReconStatus);
  });

  it('half-open window: from inclusive, to exclusive', async () => {
    const rc = new Reconciler(db, { source: makeSource([]), betLog: log });
    const insert = db.prepare(`
      INSERT INTO reconciliation_runs
        (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('op-w', 0, 1, 0, 0, 'OK', 1000, 1001); // included if from=1000
    insert.run('op-w', 0, 1, 0, 0, 'OK', 1500, 1501); // included
    insert.run('op-w', 0, 1, 0, 0, 'OK', 2000, 2001); // EXCLUDED if to=2000

    const inWindow = rc.listRuns({ from: 1000, to: 2000 }, { limit: 50 });
    const ts = inWindow.rows.map((r) => r.startedAt).sort((a, b) => a - b);
    expect(ts).toEqual([1000, 1500]);
  });

  it('RUNNING rows are filtered out of listRuns', async () => {
    const rc = new Reconciler(db, { source: makeSource([]), betLog: log });
    // Insert one RUNNING and one OK.
    const insert = db.prepare(`
      INSERT INTO reconciliation_runs
        (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('op-r', 0, 1, 0, 0, 'RUNNING', 5000, null);
    insert.run('op-r', 0, 1, 0, 0, 'OK',      5001, 5002);

    const got = rc.listRuns({}, { limit: 50 });
    expect(got.rows.length).toBe(1);
    expect(got.rows[0]!.status).toBe('OK' as ReconStatus);
  });
});

describe('Reconciler.getRun — RUNNING is hidden', () => {
  it('returns null for an id whose row has status=RUNNING', () => {
    const db = makeDb();
    const log = new BetLog(db);
    const rc = new Reconciler(db, { source: makeSource([]), betLog: log });
    const info = db
      .prepare(`INSERT INTO reconciliation_runs
        (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
        VALUES ('op-x', 0, 1, 0, 0, 'RUNNING', 1, NULL)`)
      .run();
    const runId = Number(info.lastInsertRowid);
    expect(rc.getRun(runId)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    const db = makeDb();
    const log = new BetLog(db);
    const rc = new Reconciler(db, { source: makeSource([]), betLog: log });
    expect(rc.getRun(999_999)).toBeNull();
  });
});
