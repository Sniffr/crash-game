/**
 * Integration tests for /admin/v1/metrics + /admin/v1/health/summary
 * (Task 8.2 — Phase 8, spec §10).
 *
 * Mirrors the admin-read.test.ts / admin-reconciliation.test.ts harness:
 *   - fresh :memory: db per test
 *   - real BetLog / OperatorRegistry / AdminAudit / AdminUsers
 *   - Reconciler with an empty OperatorLedgerSource
 *   - JWT auth as admin via the real /auth/login endpoint
 *
 * Seeds the prom-client registry directly via observeWalletCall (no HTTP-side
 * wallet call needed) so we exercise the same code path that the production
 * wallet wrappers use.
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
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import * as bcrypt from 'bcryptjs';
import { PgBetLog, PgOperatorRegistry, PgReconciler, WalletError } from '@crash/wallet';
import type { OperatorLedgerSource } from '@crash/wallet';
import { PgAdminAudit, PgAdminUsers } from '../admin/admin-store-pg.js';
import { createAdminRouter } from './admin.js';
import { WalletClientCache } from '../wallet/client-cache.js';
import { observeWalletCall, resetMetrics } from '../observability/metrics.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  app: express.Application;
  adminUsers: PgAdminUsers;
}

let currentDb: TestDb | undefined;

async function makeHarness(): Promise<Harness> {
  const testDb = await makeTestDb();
  currentDb = testDb;
  const pool = testDb.pool;
  const betLog = new PgBetLog(pool);
  const registry = new PgOperatorRegistry(pool);
  const adminAudit = new PgAdminAudit(pool);
  const adminUsers = new PgAdminUsers(pool);
  const revoked = new Set<string>();
  const walletClientCache = new WalletClientCache(registry, betLog);
  const emptySource: OperatorLedgerSource = async () => [];
  const reconciler = new PgReconciler(pool, { source: emptySource, betLog });

  const app = express();
  app.use(express.json());
  app.use('/admin/v1', createAdminRouter({
    walletClientCache,
    betLog,
    adminAudit,
    adminUsers,
    registry,
    revoked,
    reconciler,
  }));

  return { app, adminUsers };
}

// ---------------------------------------------------------------------------
// JWT env management
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-metrics';
let savedJwtSecret: string | undefined;

beforeEach(() => {
  savedJwtSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = TEST_SECRET;
  // Reset the shared prom-client registry between tests so counters start clean.
  resetMetrics();
});

afterEach(async () => {
  if (savedJwtSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = savedJwtSecret;
  }
  if (currentDb) { await currentDb.cleanup(); currentDb = undefined; }
});

async function loginAs(app: express.Application, username: string, password: string): Promise<string> {
  const res = await request(app)
    .post('/admin/v1/auth/login')
    .send({ username, password });
  return (res.body as { token?: string }).token ?? '';
}

// ---------------------------------------------------------------------------
// Tests — /admin/v1/metrics
// ---------------------------------------------------------------------------

describe('GET /admin/v1/metrics', () => {
  it('returns 401 without Authorization header', async () => {
    const { app } = await makeHarness();
    const res = await request(app).get('/admin/v1/metrics');
    expect(res.status).toBe(401);
  });

  it('returns 200 text/plain with the three metric names after observeWalletCall is invoked', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    // Seed the registry: 2 oks + 1 WalletError for op-a / bet
    await observeWalletCall({ operator: 'op-a', endpoint: 'bet' }, async () => 1);
    await observeWalletCall({ operator: 'op-a', endpoint: 'bet' }, async () => 2);
    await expect(
      observeWalletCall({ operator: 'op-a', endpoint: 'bet' }, async () => {
        throw new WalletError({
          code: 'INSUFFICIENT_FUNDS', message: 'no money', httpStatus: 402, retryable: false,
        });
      }),
    ).rejects.toBeInstanceOf(WalletError);

    const res = await request(app)
      .get('/admin/v1/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/plain');

    const body = res.text;
    // Definition lines (always present once a metric is registered)
    expect(body).toContain('wallet_calls_total');
    expect(body).toContain('wallet_errors_total');
    expect(body).toContain('wallet_latency_ms');

    // Per-operator data
    expect(body).toMatch(/wallet_calls_total\{[^}]*operator="op-a"[^}]*outcome="ok"[^}]*\} 2/);
    expect(body).toMatch(/wallet_calls_total\{[^}]*operator="op-a"[^}]*outcome="error"[^}]*\} 1/);
    expect(body).toMatch(/wallet_errors_total\{[^}]*operator="op-a"[^}]*code="INSUFFICIENT_FUNDS"[^}]*\} 1/);
    // Histogram sample count = 3 total
    expect(body).toMatch(/wallet_latency_ms_count\{[^}]*operator="op-a"[^}]*\} 3/);
  });
});

// ---------------------------------------------------------------------------
// Tests — /admin/v1/health/summary
// ---------------------------------------------------------------------------

describe('GET /admin/v1/health/summary', () => {
  it('returns 401 without Authorization header', async () => {
    const { app } = await makeHarness();
    const res = await request(app).get('/admin/v1/health/summary?window=1h');
    expect(res.status).toBe(401);
  });

  it('?window=foo returns 400 INVALID_REQUEST', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/health/summary?window=foo')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_REQUEST');
  });

  it('returns per-operator walletCalls + errorRate after seeded calls', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    // 3 oks + 1 error on op-a/bet
    await observeWalletCall({ operator: 'op-a', endpoint: 'bet' }, async () => 'a');
    await observeWalletCall({ operator: 'op-a', endpoint: 'bet' }, async () => 'b');
    await observeWalletCall({ operator: 'op-a', endpoint: 'win' }, async () => 'c');
    await expect(
      observeWalletCall({ operator: 'op-a', endpoint: 'win' }, async () => {
        throw new WalletError({ code: 'UPSTREAM_ERROR', message: 'x', httpStatus: 502, retryable: true });
      }),
    ).rejects.toBeInstanceOf(WalletError);

    const res = await request(app)
      .get('/admin/v1/health/summary?window=1h')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.window).toBe('1h');
    expect(Array.isArray(res.body.operators)).toBe(true);

    const opA = (res.body.operators as Array<{
      operatorId: string;
      walletCalls: number;
      errorRate: number;
      latencyP50Ms: number;
      latencyP95Ms: number;
      latencyP99Ms: number;
    }>).find((o) => o.operatorId === 'op-a');

    expect(opA).toBeDefined();
    expect(opA!.walletCalls).toBe(4);
    // 1 error out of 4 calls = 0.25
    expect(opA!.errorRate).toBeCloseTo(0.25, 5);
    // Percentiles are bucket-resolution numbers; must be non-negative
    expect(opA!.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(opA!.latencyP95Ms).toBeGreaterThanOrEqual(0);
    expect(opA!.latencyP99Ms).toBeGreaterThanOrEqual(0);
  });

  it('default window is 1h when omitted; empty operator list when no calls recorded', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/health/summary')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.window).toBe('1h');
    expect(res.body.operators).toEqual([]);
  });

  it('?window=24h is accepted', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/health/summary?window=24h')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.window).toBe('24h');
  });
});
