/**
 * PgReconciler tests — Postgres port of reconciler.test.ts (Wave B pt3).
 *
 * Uses makeTestDb() (isolated schema on the local crash-test-pg container) and a
 * real PgBetLog on the same pool, seeded via its public putIdempotency/create/
 * transition APIs so listIdempotencyFiltered returns the seeded rows exactly as
 * in production. The operator-ledger source is injected as a plain async fn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PgBetLog } from './bet-log-pg.js';
import type { CreateBetInput } from './bet-log.js';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import {
  PgReconciler,
  type OperatorLedgerSource,
  type OperatorLedgerTxn,
  type ReconStatus,
} from './reconciler-pg.js';
import { decodeCursor } from './cursor.js';

/**
 * Seed one OUR-side transaction by inserting a bet_log row and the matching
 * txn_idempotency row. Mirrors reconciler.test.ts seedOurTxn (now async).
 */
async function seedOurTxn(
  log: PgBetLog,
  opts: {
    operatorId: string;
    txnId: string;
    kind: 'bet' | 'win' | 'rollback';
    amountMinor: number;
    winAmountMinor?: number;
    status?: 'OK' | 'FAILED';
    createdAt?: number;
    betId?: string;
    betTxnId?: string;
  },
): Promise<void> {
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

  try { await log.create(input); } catch { /* already exists — kind=win/rollback can share a bet */ }

  if (opts.kind === 'win') {
    await log.transition(betId, 'bet_accepted');
    await log.transition(betId, 'round_started');
    await log.transition(betId, 'cashout_requested');
    await log.transition(betId, 'win_settled', {
      winTxnId: opts.txnId,
      winAmountMinor: opts.winAmountMinor ?? opts.amountMinor,
      multiplier: 2,
    });
  } else if (opts.kind === 'rollback') {
    await log.transition(betId, 'bet_accepted');
    await log.transition(betId, 'rollback_requested', { rollbackTxnId: opts.txnId });
    await log.transition(betId, 'rollback_acked');
  }

  const responseJson = status === 'OK' ? '{"ok":true}' : '{"ok":false,"error":{"code":"X"}}';
  await log.putIdempotency({
    txnId: opts.txnId,
    operatorId: opts.operatorId,
    kind: opts.kind,
    requestHash: `h-${opts.txnId}`,
    responseJson,
    createdAt,
  });
}

function makeSource(rows: OperatorLedgerTxn[]): OperatorLedgerSource {
  return async () => rows;
}

const throwingSource: OperatorLedgerSource = async () => {
  throw new Error('simulated ledger feed failure');
};

/** Insert a completed run row directly (used by the listRuns pagination tests). */
async function insertRun(
  tdb: TestDb,
  r: { operatorId: string; status: string; startedAt: number; finishedAt: number | null; mismatchCount?: number },
): Promise<number> {
  const { rows } = await tdb.pool.query<{ id: string | number }>(
    `INSERT INTO reconciliation_runs
       (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
     VALUES ($1, 0, 1, 0, $2, $3, $4, $5) RETURNING id`,
    [r.operatorId, r.mismatchCount ?? 0, r.status, r.startedAt, r.finishedAt],
  );
  return Number(rows[0]!.id);
}

describe('PgReconciler.run — diff engine', () => {
  let tdb: TestDb;
  let log: PgBetLog;

  beforeEach(async () => {
    tdb = await makeTestDb();
    log = new PgBetLog(tdb.pool);
  });
  afterEach(async () => {
    await tdb.cleanup();
  });

  it('all four mismatch kinds + matches: checked/mismatch counts, status MISMATCHES, exact details', async () => {
    await seedOurTxn(log, { operatorId: 'op-1', txnId: 'm1',       kind: 'bet', amountMinor: 500 });
    await seedOurTxn(log, { operatorId: 'op-1', txnId: 'm2',       kind: 'bet', amountMinor: 600 });
    await seedOurTxn(log, { operatorId: 'op-1', txnId: 'miss-op',  kind: 'bet', amountMinor: 700 });
    await seedOurTxn(log, { operatorId: 'op-1', txnId: 'amt-mis',  kind: 'bet', amountMinor: 800 });
    await seedOurTxn(log, { operatorId: 'op-1', txnId: 'stat-mis', kind: 'bet', amountMinor: 900 });

    const source = makeSource([
      { txnId: 'm1',        amountMinor: 500,  status: 'OK'     },
      { txnId: 'm2',        amountMinor: 600,  status: 'OK'     },
      { txnId: 'amt-mis',   amountMinor: 850,  status: 'OK'     },
      { txnId: 'stat-mis',  amountMinor: 900,  status: 'FAILED' },
      { txnId: 'miss-game', amountMinor: 1100, status: 'OK'     },
    ]);

    const rc = new PgReconciler(tdb.pool, { source, betLog: log });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-1', now - 86400, now + 86400);

    expect(run.status).toBe('MISMATCHES' as ReconStatus);
    expect(run.operatorId).toBe('op-1');
    expect(run.checkedCount).toBe(6);
    expect(run.mismatchCount).toBe(4);
    expect(run.finishedAt).not.toBeNull();
    expect(run.finishedAt!).toBeGreaterThanOrEqual(run.startedAt);

    const fetched = await rc.getRun(run.id);
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
    await seedOurTxn(log, { operatorId: 'op-2', txnId: 'a', kind: 'bet', amountMinor: 100 });
    await seedOurTxn(log, { operatorId: 'op-2', txnId: 'b', kind: 'bet', amountMinor: 200 });

    const source = makeSource([
      { txnId: 'a', amountMinor: 100, status: 'OK' },
      { txnId: 'b', amountMinor: 200, status: 'OK' },
    ]);
    const rc = new PgReconciler(tdb.pool, { source, betLog: log });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-2', now - 3600, now + 3600);

    expect(run.status).toBe('OK' as ReconStatus);
    expect(run.checkedCount).toBe(2);
    expect(run.mismatchCount).toBe(0);
    const got = await rc.getRun(run.id);
    expect(got).not.toBeNull();
    expect(got!.mismatches).toEqual([]);
  });

  it('source throws → run persisted as FAILED (does not rethrow)', async () => {
    await seedOurTxn(log, { operatorId: 'op-3', txnId: 'x', kind: 'bet', amountMinor: 50 });

    const rc = new PgReconciler(tdb.pool, { source: throwingSource, betLog: log });
    const now = Math.floor(Date.now() / 1000);

    // Must resolve, not reject.
    const run = await rc.run('op-3', now - 60, now + 60);
    expect(run.status).toBe('FAILED' as ReconStatus);
    expect(run.finishedAt).not.toBeNull();

    const got = await rc.getRun(run.id);
    expect(got).not.toBeNull();
    expect(got!.run.status).toBe('FAILED' as ReconStatus);
  });

  it('win-kind uses winAmountMinor as the effective amount', async () => {
    await seedOurTxn(log, {
      operatorId: 'op-4', txnId: 'wtxn-1', kind: 'win',
      amountMinor: 100, winAmountMinor: 250,
    });

    const rc = new PgReconciler(tdb.pool, {
      source: makeSource([{ txnId: 'wtxn-1', amountMinor: 250, status: 'OK' }]),
      betLog: log,
    });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-4', now - 60, now + 60);
    expect(run.status).toBe('OK' as ReconStatus);
    expect(run.mismatchCount).toBe(0);
  });
});

describe('PgReconciler.listRuns — keyset pagination + filters', () => {
  let tdb: TestDb;
  let log: PgBetLog;

  beforeEach(async () => {
    tdb = await makeTestDb();
    log = new PgBetLog(tdb.pool);
  });
  afterEach(async () => {
    await tdb.cleanup();
  });

  it('keyset pagination across multiple pages: no dup, no gap, exact total', async () => {
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    const base = 1_700_000_000;
    for (let i = 0; i < 7; i++) {
      await insertRun(tdb, { operatorId: 'op-page', status: 'OK', startedAt: base + i, finishedAt: base + i + 1 });
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    let safety = 10;
    do {
      const page = await rc.listRuns({}, { limit: 3, cursor: cursor ? decodeCursor(cursor)! : undefined });
      for (const r of page.rows) seen.push(r.id);
      cursor = page.nextCursor;
      safety -= 1;
    } while (cursor !== null && safety > 0);

    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7); // no dup
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]!);
  });

  it('status filter narrows results; other statuses excluded', async () => {
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    const base = 1_700_100_000;
    await insertRun(tdb, { operatorId: 'op-f', status: 'OK',         startedAt: base + 1, finishedAt: base + 2 });
    await insertRun(tdb, { operatorId: 'op-f', status: 'MISMATCHES', startedAt: base + 3, finishedAt: base + 4, mismatchCount: 1 });
    await insertRun(tdb, { operatorId: 'op-f', status: 'FAILED',     startedAt: base + 5, finishedAt: base + 6 });

    const ok = await rc.listRuns({ status: 'OK' }, { limit: 50 });
    expect(ok.rows.length).toBe(1);
    expect(ok.rows[0]!.status).toBe('OK' as ReconStatus);

    const failed = await rc.listRuns({ status: 'FAILED' }, { limit: 50 });
    expect(failed.rows.length).toBe(1);
    expect(failed.rows[0]!.status).toBe('FAILED' as ReconStatus);
  });

  it('half-open window: from inclusive, to exclusive', async () => {
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    await insertRun(tdb, { operatorId: 'op-w', status: 'OK', startedAt: 1000, finishedAt: 1001 });
    await insertRun(tdb, { operatorId: 'op-w', status: 'OK', startedAt: 1500, finishedAt: 1501 });
    await insertRun(tdb, { operatorId: 'op-w', status: 'OK', startedAt: 2000, finishedAt: 2001 });

    const inWindow = await rc.listRuns({ from: 1000, to: 2000 }, { limit: 50 });
    const ts = inWindow.rows.map((r) => r.startedAt).sort((a, b) => a - b);
    expect(ts).toEqual([1000, 1500]);
  });

  it('RUNNING rows are filtered out of listRuns', async () => {
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    await insertRun(tdb, { operatorId: 'op-r', status: 'RUNNING', startedAt: 5000, finishedAt: null });
    await insertRun(tdb, { operatorId: 'op-r', status: 'OK',      startedAt: 5001, finishedAt: 5002 });

    const got = await rc.listRuns({}, { limit: 50 });
    expect(got.rows.length).toBe(1);
    expect(got.rows[0]!.status).toBe('OK' as ReconStatus);
  });
});

describe('PgReconciler.getRun — run + mismatches; RUNNING hidden', () => {
  let tdb: TestDb;
  let log: PgBetLog;

  beforeEach(async () => {
    tdb = await makeTestDb();
    log = new PgBetLog(tdb.pool);
  });
  afterEach(async () => {
    await tdb.cleanup();
  });

  it('returns run + its mismatches for a real MISMATCHES run', async () => {
    await seedOurTxn(log, { operatorId: 'op-g', txnId: 'only-ours', kind: 'bet', amountMinor: 400 });
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    const now = Math.floor(Date.now() / 1000);
    const run = await rc.run('op-g', now - 60, now + 60);
    expect(run.status).toBe('MISMATCHES' as ReconStatus);

    const got = await rc.getRun(run.id);
    expect(got).not.toBeNull();
    expect(got!.run.id).toBe(run.id);
    expect(got!.mismatches.length).toBe(1);
    expect(got!.mismatches[0]!.txnId).toBe('only-ours');
    expect(got!.mismatches[0]!.kind).toBe('missing_on_operator');
    expect(got!.mismatches[0]!.details).toEqual({ ourAmountMinor: 400, operatorRecord: null });
  });

  it('returns null for a RUNNING row', async () => {
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    const runId = await insertRun(tdb, { operatorId: 'op-x', status: 'RUNNING', startedAt: 1, finishedAt: null });
    expect(await rc.getRun(runId)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    const rc = new PgReconciler(tdb.pool, { source: makeSource([]), betLog: log });
    expect(await rc.getRun(999_999)).toBeNull();
  });
});
