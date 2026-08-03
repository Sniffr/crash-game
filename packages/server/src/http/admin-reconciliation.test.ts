/**
 * Integration tests for admin reconciliation API — Task 8.1 (spec §9).
 *
 * Tests:
 *   - POST /reconciliation/runs — admin → 202 + audit row; non-admin → 403;
 *     unknown operator → 404; bad window → 400; seed-a-mismatch e2e visible via GET
 *   - GET  /reconciliation/runs — list + status filter; keyset traversal small case;
 *     bad status filter → 400
 *   - GET  /reconciliation/runs/:id — 404 unknown id
 *
 * Hermetic per test: fresh :memory: db + router with an INJECTED fake
 * OperatorLedgerSource. Mirrors the admin-financial.test.ts / admin-read.test.ts
 * harness pattern.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Store / WS / theme / game mocks (required by indirect imports)
// ---------------------------------------------------------------------------

vi.mock('../store.js', () => ({
  DEFAULT_DEMO_BALANCE: 1000,
  StoreOfflineError: class StoreOfflineError extends Error {
    constructor() { super('session store offline'); }
  },
  isOnline: vi.fn(() => true),
  getSession: vi.fn(async () => null),
  createSession: vi.fn(),
  createOperatorSession: vi.fn(),
  getStats: vi.fn(async () => ({})),
  getHistory: vi.fn(async () => []),
  adjustBalance: vi.fn(),
  appendHistory: vi.fn(),
  recordBet: vi.fn(),
  recordWin: vi.fn(),
  recordLoss: vi.fn(),
  checkRateLimit: vi.fn(async () => true),
  refreshTtl: vi.fn(),
  setBalance: vi.fn(),
}));

vi.mock('../ws/hub.js', () => ({
  sessionSockets: new Map(),
  sendToSession: vi.fn(),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
}));

vi.mock('../theme/loader.js', () => ({
  getActiveTheme: vi.fn(() => null),
  initThemeLoader: vi.fn(),
}));

vi.mock('../game/history.js', () => ({
  getAllHistory: vi.fn(() => []),
  getRecentHistory: vi.fn(() => []),
  pushHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Real imports
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as bcrypt from 'bcryptjs';
import { PgBetLog, PgOperatorRegistry, PgReconciler, PgGamesRepo } from '@crash/wallet';
import type { Pool, OperatorLedgerSource, OperatorLedgerTxn, CreateBetInput } from '@crash/wallet';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PgAdminAudit, PgAdminUsers } from '../admin/admin-store-pg.js';
import { createAdminRouter } from './admin.js';
import { WalletClientCache } from '../wallet/client-cache.js';

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

interface Harness {
  app: express.Application;
  pool: Pool;
  betLog: PgBetLog;
  adminAudit: PgAdminAudit;
  adminUsers: PgAdminUsers;
  registry: PgOperatorRegistry;
  reconciler: PgReconciler;
  /** mutable per-test: change between calls to vary what the operator ledger returns */
  setSource: (fn: OperatorLedgerSource) => void;
}

// Each makeHarness() call builds an isolated Postgres schema; track them so
// afterEach can drop every schema created during the test.
const activeDbs: TestDb[] = [];

async function makeHarness(): Promise<Harness> {
  const testDb = await makeTestDb();
  activeDbs.push(testDb);
  const pool = testDb.pool;
  const betLog = new PgBetLog(pool);
  const registry = new PgOperatorRegistry(pool);
  const adminAudit = new PgAdminAudit(pool);
  const adminUsers = new PgAdminUsers(pool);
  const games = new PgGamesRepo(pool);
  const revoked = new Set<string>();
  const walletClientCache = new WalletClientCache(registry, betLog);

  let currentSource: OperatorLedgerSource = async () => [];
  const source: OperatorLedgerSource = (op, s, e) => currentSource(op, s, e);
  const reconciler = new PgReconciler(pool, { source, betLog });

  const app = express();
  app.use(express.json());
  app.use('/admin/v1', createAdminRouter({
    walletClientCache,
    betLog,
    adminAudit,
    adminUsers,
    registry,
    games,
    revoked,
    reconciler,
  }));

  return {
    app, pool, betLog, adminAudit, adminUsers, registry, reconciler,
    setSource: (fn) => { currentSource = fn; },
  };
}

// ---------------------------------------------------------------------------
// JWT env management
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-recon';
let savedJwtSecret: string | undefined;

beforeEach(() => {
  savedJwtSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = TEST_SECRET;
});

afterEach(async () => {
  if (savedJwtSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = savedJwtSecret;
  }
  // Drop every isolated schema created by makeHarness() during this test.
  for (const d of activeDbs) await d.cleanup();
  activeDbs.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAs(app: express.Application, username: string, password: string): Promise<string> {
  const res = await request(app)
    .post('/admin/v1/auth/login')
    .send({ username, password });
  return (res.body as { token?: string }).token ?? '';
}

async function createTestOperator(registry: PgOperatorRegistry, operatorId: string): Promise<void> {
  await registry.create({
    operatorId,
    name: `Operator ${operatorId}`,
    walletBaseUrl: `https://wallet-${operatorId}.example.com`,
    currencies: ['EUR'],
    status: 'active',
  });
}

/**
 * Seed one OUR-side bet+idempotency row so listIdempotencyFiltered surfaces it
 * inside the reconciliation window. Returns the txnId.
 */
async function seedBet(
  betLog: PgBetLog,
  opts: { operatorId: string; txnId: string; amountMinor: number; createdAt?: number },
): Promise<string> {
  const now = opts.createdAt ?? Math.floor(Date.now() / 1000);
  const input: CreateBetInput = {
    betId: `bet-${opts.txnId}`,
    operatorId: opts.operatorId,
    playerId: 'pl-1',
    sessionId: 'sess-1',
    roundId: 'rnd-1',
    currency: 'EUR',
    amountMinor: opts.amountMinor,
    betTxnId: opts.txnId,
  };
  await betLog.create(input);
  await betLog.putIdempotency({
    txnId: opts.txnId,
    operatorId: opts.operatorId,
    kind: 'bet',
    requestHash: `h-${opts.txnId}`,
    responseJson: '{"ok":true}',
    createdAt: now,
  });
  return opts.txnId;
}

const aSourceReturning = (rows: OperatorLedgerTxn[]): OperatorLedgerSource => async () => rows;

// ===========================================================================
// POST /reconciliation/runs
// ===========================================================================

describe('POST /admin/v1/reconciliation/runs', () => {
  it('admin → 202 with run id; audit row recorded; run visible via GET /:id with the seeded mismatch', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    await createTestOperator(h.registry, 'op-1');
    const now = Math.floor(Date.now() / 1000);
    // Seed OUR txn — operator has nothing → missing_on_operator.
    await seedBet(h.betLog, { operatorId: 'op-1', txnId: 'tx-A', amountMinor: 1234, createdAt: now });
    h.setSource(aSourceReturning([])); // operator empty ledger

    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .post('/admin/v1/reconciliation/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-1', windowStart: now - 60, windowEnd: now + 60 });

    expect(res.status).toBe(202);
    expect(typeof res.body.id).toBe('number');
    expect(res.body.status).toBe('MISMATCHES');
    expect(res.body.mismatchCount).toBe(1);

    // Audit row exists with the right action + target
    const audit = await h.adminAudit.listFiltered({ action: 'reconciliation.run' }, { limit: 50 });
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.target).toBe('op-1');
    expect(audit.rows[0]!.actor).toBe('admin1');
    expect(audit.rows[0]!.payload).toMatchObject({ runId: res.body.id, mismatchCount: 1 });

    // Run + mismatch visible via GET /:id
    const detail = await request(h.app)
      .get(`/admin/v1/reconciliation/runs/${res.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run.id).toBe(res.body.id);
    expect(detail.body.run.status).toBe('MISMATCHES');
    expect(detail.body.run.operatorId).toBe('op-1');
    expect(detail.body.run.checkedCount).toBe(1);
    expect(detail.body.run.mismatchCount).toBe(1);
    expect(detail.body.mismatches).toHaveLength(1);
    expect(detail.body.mismatches[0]).toEqual({
      txnId: 'tx-A',
      kind: 'missing_on_operator',
      details: { ourAmountMinor: 1234, operatorRecord: null },
    });
  });

  it('finance role → 403; viewer → 403', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('finance1', await bcrypt.hash('pw', 10), ['finance']);
    await h.adminUsers.create('viewer1',  await bcrypt.hash('pw', 10), ['viewer']);
    await createTestOperator(h.registry, 'op-2');

    for (const u of ['finance1', 'viewer1']) {
      const token = await loginAs(h.app, u, 'pw');
      const res = await request(h.app)
        .post('/admin/v1/reconciliation/runs')
        .set('Authorization', `Bearer ${token}`)
        .send({ operatorId: 'op-2', windowStart: 0, windowEnd: 1 });
      expect(res.status).toBe(403);
    }
  });

  it('unknown operator → 404 OPERATOR_NOT_FOUND', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .post('/admin/v1/reconciliation/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'no-such-op', windowStart: 0, windowEnd: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('OPERATOR_NOT_FOUND');
  });

  it('bad window — windowEnd <= windowStart → 400 INVALID_REQUEST', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    await createTestOperator(h.registry, 'op-3');
    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .post('/admin/v1/reconciliation/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-3', windowStart: 1000, windowEnd: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('bad window — non-integer windowStart → 400 INVALID_REQUEST', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    await createTestOperator(h.registry, 'op-4');
    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .post('/admin/v1/reconciliation/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-4', windowStart: 1.5, windowEnd: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('missing operatorId → 400 INVALID_REQUEST', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .post('/admin/v1/reconciliation/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ windowStart: 0, windowEnd: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

// ===========================================================================
// GET /reconciliation/runs
// ===========================================================================

describe('GET /admin/v1/reconciliation/runs', () => {
  it('lists runs (any role; viewer ok); status filter narrows; bad status → 400', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    await h.adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);
    await createTestOperator(h.registry, 'op-a');
    await createTestOperator(h.registry, 'op-b');

    const now = Math.floor(Date.now() / 1000);

    // op-a: 1 OK run.
    h.setSource(aSourceReturning([]));
    await h.reconciler.run('op-a', now - 10, now + 10);  // OK (no our txns, no theirs)

    // op-b: 1 MISMATCHES run (seed one OUR txn, none on theirs).
    await seedBet(h.betLog, { operatorId: 'op-b', txnId: 'tx-B', amountMinor: 500, createdAt: now });
    h.setSource(aSourceReturning([]));
    await h.reconciler.run('op-b', now - 10, now + 10);

    const adminToken  = await loginAs(h.app, 'admin1',  'pw');
    const viewerToken = await loginAs(h.app, 'viewer1', 'pw');

    // Viewer can list (roles: any)
    const all = await request(h.app)
      .get('/admin/v1/reconciliation/runs')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(all.status).toBe(200);
    expect(all.body.count).toBe(2);

    // status=MISMATCHES → only the op-b run
    const onlyMis = await request(h.app)
      .get('/admin/v1/reconciliation/runs?status=MISMATCHES')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(onlyMis.status).toBe(200);
    expect(onlyMis.body.count).toBe(1);
    expect(onlyMis.body.items[0].operatorId).toBe('op-b');
    expect(onlyMis.body.items[0].status).toBe('MISMATCHES');

    // bad status → 400
    const bad = await request(h.app)
      .get('/admin/v1/reconciliation/runs?status=NOPE')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_REQUEST');
  });

  it('keyset pagination traverses all pages with no dup/no gap', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    // Insert 5 completed runs directly for fast keyset coverage.
    const base = 1_800_000_000;
    for (let i = 0; i < 5; i++) {
      await h.pool.query(
        `INSERT INTO reconciliation_runs
          (operator_id, window_start, window_end, checked_count, mismatch_count, status, started_at, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['op-page', 0, 1, 0, 0, 'OK', base + i, base + i + 1],
      );
    }

    const token = await loginAs(h.app, 'admin1', 'pw');

    const seen: number[] = [];
    let cursor: string | null = null;
    let safety = 10;
    do {
      const url = cursor
        ? `/admin/v1/reconciliation/runs?limit=2&cursor=${encodeURIComponent(cursor)}`
        : `/admin/v1/reconciliation/runs?limit=2`;
      const res = await request(h.app).get(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      for (const r of res.body.items as Array<{ id: number }>) seen.push(r.id);
      cursor = res.body.nextCursor;
      safety -= 1;
    } while (cursor !== null && safety > 0);

    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]!);
  });
});

// ===========================================================================
// GET /reconciliation/runs/:id
// ===========================================================================

describe('GET /admin/v1/reconciliation/runs/:id', () => {
  it('unknown id → 404 RECONCILIATION_RUN_NOT_FOUND', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .get('/admin/v1/reconciliation/runs/999999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RECONCILIATION_RUN_NOT_FOUND');
  });

  it('non-integer id → 400 INVALID_REQUEST', async () => {
    const h = await makeHarness();
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(h.app, 'admin1', 'pw');

    const res = await request(h.app)
      .get('/admin/v1/reconciliation/runs/not-a-number')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});
