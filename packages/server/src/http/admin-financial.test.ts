/**
 * Integration tests for admin financial API — Task 5.4.
 *
 * Tests:
 *   - GET /financial/ggr — requireRole(finance|admin); input validation; GGR values; VOIDED excluded;
 *     WIN_FAILED stake in, win out; window bounding; groupBy collapsing
 *   - GET /financial/settlement?period=YYYY-MM — nested shape; shareBps per operator;
 *     ourShareMinor floor-computed; out-of-period rows excluded
 *   - POST /financial/settlement/:period/invoice — invoice JSON; audit row; 404 on no data;
 *     bad period format 400
 *   - shareBps PATCH round-trip — settlement reflects updated value
 *
 * Hermetic per describe: fresh :memory: db + router, seeded via direct SQL.
 * Mirrors admin-read.test.ts harness exactly.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Store / WS / theme / game mocks
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
import Database from 'better-sqlite3';
import * as bcrypt from 'bcryptjs';
import { BetLog, OperatorRegistry } from '@crash/wallet';
import { AdminAudit, AdminUsers } from '../admin/admin-store.js';
import { createAdminRouter } from './admin.js';
import { WalletClientCache } from '../wallet/client-cache.js';

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

interface Harness {
  app: express.Application;
  db: InstanceType<typeof Database>;
  betLog: BetLog;
  adminAudit: AdminAudit;
  adminUsers: AdminUsers;
  registry: OperatorRegistry;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  const betLog = new BetLog(db);
  const registry = new OperatorRegistry(db);
  const adminAudit = new AdminAudit(db);
  const adminUsers = new AdminUsers(db);
  const revoked = new Set<string>();
  const walletClientCache = new WalletClientCache(registry, betLog);

  const app = express();
  app.use(express.json());
  app.use('/admin/v1', createAdminRouter({
    walletClientCache,
    betLog,
    adminAudit,
    adminUsers,
    registry,
    revoked,
  }));

  return { app, db, betLog, adminAudit, adminUsers, registry };
}

// ---------------------------------------------------------------------------
// JWT env management
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-financial';
let savedJwtSecret: string | undefined;

beforeEach(() => {
  savedJwtSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = TEST_SECRET;
});

afterEach(() => {
  if (savedJwtSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = savedJwtSecret;
  }
});

// ---------------------------------------------------------------------------
// Login helper
// ---------------------------------------------------------------------------

async function loginAs(app: express.Application, username: string, password: string): Promise<string> {
  const res = await request(app)
    .post('/admin/v1/auth/login')
    .send({ username, password });
  return (res.body as { token?: string }).token ?? '';
}

// ---------------------------------------------------------------------------
// Financial fixture
//
// Month: 2026-04 (April 2026). Timestamps computed from Date.UTC at runtime.
//
// Operators:
//   op-a: shareBps = 1500 (default)
//   op-b: shareBps = 2500
//
// Bet rows in 2026-04:
//   10 SETTLED EUR op-a 2026-04-10: stake 100ea, win 250ea  → stake=1000, win=2500, ggr=-1500
//    5 SETTLED EUR op-a 2026-04-15: stake 100ea, win 150ea  → stake=500,  win=750,  ggr=-250
//    8 LOST    EUR op-a 2026-04-20: stake 100ea, win=0      → stake=800,  win=0,    ggr=800
//    3 SETTLED USD op-a 2026-04-10: stake 200ea, win 300ea  → stake=600,  win=900,  ggr=-300
//    5 LOST    BTC op-b 2026-04-15: stake 100000ea, win=0   → stake=500000, win=0,  ggr=500000
//    2 VOIDED  EUR op-a (any)       → EXCLUDED from all sums
//    1 WIN_FAILED EUR op-a          → stake 100 in STAKE; win EXCLUDED
//
// EUR op-a totals for April:
//   stake = 1000 + 500 + 800 + 100 (WIN_FAILED) = 2400
//   win   = 2500 + 750               = 3250
//   ggr   = 2400 - 3250             = -850
//   betCount = 10 + 5 + 8 + 1       = 24
//
// USD op-a totals for April:
//   stake = 600, win = 900, ggr = -300, betCount = 3
//
// BTC op-b totals for April:
//   stake = 500000, win = 0, ggr = 500000, betCount = 5
//
// Outside period (must NOT appear in April settlement):
//   1 SETTLED EUR op-a 2026-03-15
//   1 SETTLED EUR op-a 2026-05-15
// ---------------------------------------------------------------------------

let _seq = 0;

interface FixtureResult {
  aprilEurOpAStake: number;
  aprilEurOpAWin: number;
  aprilEurOpAGgr: number;
  aprilEurOpABetCount: number;
  aprilUsdOpAGgr: number;
  aprilBtcOpBGgr: number;
  aprilBtcOpBStake: number;
  aprilBtcOpBBetCount: number;
}

function seedFinancialFixture(
  db: InstanceType<typeof Database>,
  registry: OperatorRegistry,
): FixtureResult {
  // Create operators
  registry.create({
    operatorId: 'op-a',
    name: 'Operator A',
    walletBaseUrl: 'https://wallet-a.example.com',
    currencies: ['EUR', 'USD'],
    shareBps: 1500,
    status: 'active',
  });
  registry.create({
    operatorId: 'op-b',
    name: 'Operator B',
    walletBaseUrl: 'https://wallet-b.example.com',
    currencies: ['BTC'],
    shareBps: 2500,
    status: 'active',
  });

  // Compute timestamps from Date.UTC to ensure correctness regardless of machine local time
  const apr10 = Math.floor(Date.UTC(2026, 3, 10) / 1000); // 2026-04-10
  const apr15 = Math.floor(Date.UTC(2026, 3, 15) / 1000); // 2026-04-15
  const apr20 = Math.floor(Date.UTC(2026, 3, 20) / 1000); // 2026-04-20
  const mar15 = Math.floor(Date.UTC(2026, 2, 15) / 1000); // 2026-03-15 (outside period)
  const may15 = Math.floor(Date.UTC(2026, 4, 15) / 1000); // 2026-05-15 (outside period)

  function insertBet(opts: {
    operatorId: string;
    currency: string;
    state: string;
    amountMinor: number;
    winAmountMinor: number | null;
    createdAt: number;
  }): void {
    const betId = `bet-${++_seq}`;
    const betTxnId = `btxn-${_seq}`;
    db.prepare(`
      INSERT INTO bet_log (
        bet_id, operator_id, player_id, session_id, round_id, currency,
        amount_minor, state, bet_txn_id,
        win_txn_id, rollback_txn_id, bet_op_txn_id, win_op_txn_id,
        win_amount_minor, multiplier, error_code,
        created_at, updated_at
      ) VALUES (
        ?, ?, 'player-1', 'sess-1', 'round-1', ?,
        ?, ?, ?,
        NULL, NULL, NULL, NULL,
        ?, NULL, NULL,
        ?, ?
      )
    `).run(
      betId,
      opts.operatorId,
      opts.currency,
      opts.amountMinor,
      opts.state,
      betTxnId,
      opts.winAmountMinor,
      opts.createdAt,
      opts.createdAt,
    );
  }

  // 10 SETTLED EUR op-a 2026-04-10: stake=100, win=250 each
  for (let i = 0; i < 10; i++) {
    insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'SETTLED', amountMinor: 100, winAmountMinor: 250, createdAt: apr10 + i });
  }

  // 5 SETTLED EUR op-a 2026-04-15: stake=100, win=150 each
  for (let i = 0; i < 5; i++) {
    insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'SETTLED', amountMinor: 100, winAmountMinor: 150, createdAt: apr15 + i });
  }

  // 8 LOST EUR op-a 2026-04-20: stake=100, win=null
  for (let i = 0; i < 8; i++) {
    insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'LOST', amountMinor: 100, winAmountMinor: null, createdAt: apr20 + i });
  }

  // 3 SETTLED USD op-a 2026-04-10: stake=200, win=300 each
  for (let i = 0; i < 3; i++) {
    insertBet({ operatorId: 'op-a', currency: 'USD', state: 'SETTLED', amountMinor: 200, winAmountMinor: 300, createdAt: apr10 + 100 + i });
  }

  // 5 LOST BTC op-b 2026-04-15: stake=100000, win=null
  for (let i = 0; i < 5; i++) {
    insertBet({ operatorId: 'op-b', currency: 'BTC', state: 'LOST', amountMinor: 100000, winAmountMinor: null, createdAt: apr15 + i });
  }

  // 2 VOIDED EUR op-a — must be excluded
  insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'VOIDED', amountMinor: 100, winAmountMinor: null, createdAt: apr10 });
  insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'VOIDED', amountMinor: 100, winAmountMinor: null, createdAt: apr15 });

  // 1 WIN_FAILED EUR op-a — stake in STAKE, win NOT in WIN
  insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'WIN_FAILED', amountMinor: 100, winAmountMinor: 999, createdAt: apr20 + 100 });

  // Outside-period bets (must NOT appear in April reports)
  insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'SETTLED', amountMinor: 100, winAmountMinor: 200, createdAt: mar15 });
  insertBet({ operatorId: 'op-a', currency: 'EUR', state: 'SETTLED', amountMinor: 100, winAmountMinor: 200, createdAt: may15 });

  return {
    aprilEurOpAStake: 1000 + 500 + 800 + 100,   // 2400
    aprilEurOpAWin: 2500 + 750,                  // 3250
    aprilEurOpAGgr: (1000 + 500 + 800 + 100) - (2500 + 750), // -850
    aprilEurOpABetCount: 10 + 5 + 8 + 1,         // 24
    aprilUsdOpAGgr: 600 - 900,                   // -300
    aprilBtcOpBGgr: 500000,
    aprilBtcOpBStake: 500000,
    aprilBtcOpBBetCount: 5,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('GET /admin/v1/financial/ggr — auth and role', () => {
  it('viewer → 403; finance → 200; admin → 200', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    await adminUsers.create('finance1', await bcrypt.hash('pw', 10), ['finance']);
    await adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);
    seedFinancialFixture(db, registry);

    const adminToken = await loginAs(app, 'admin1', 'pw');
    const financeToken = await loginAs(app, 'finance1', 'pw');
    const viewerToken = await loginAs(app, 'viewer1', 'pw');

    const from = Math.floor(Date.UTC(2026, 3, 1) / 1000);
    const to = Math.floor(Date.UTC(2026, 4, 1) / 1000);
    const qs = `from=${from}&to=${to}&groupBy=operator,currency,day`;

    const r1 = await request(app).get(`/admin/v1/financial/ggr?${qs}`).set('Authorization', `Bearer ${viewerToken}`);
    expect(r1.status).toBe(403);

    const r2 = await request(app).get(`/admin/v1/financial/ggr?${qs}`).set('Authorization', `Bearer ${financeToken}`);
    expect(r2.status).toBe(200);

    const r3 = await request(app).get(`/admin/v1/financial/ggr?${qs}`).set('Authorization', `Bearer ${adminToken}`);
    expect(r3.status).toBe(200);
  });

  it('no bearer → 401', async () => {
    const { app } = makeHarness();
    const r = await request(app).get('/admin/v1/financial/ggr?from=0&to=99999&groupBy=operator');
    expect(r.status).toBe(401);
  });
});

describe('GET /admin/v1/financial/ggr — GGR values', () => {
  it('groupBy=operator,currency,day returns correct cells for EUR op-a 2026-04-10', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    // April window: from=2026-04-01, to=2026-05-01 (exclusive)
    const from = Math.floor(Date.UTC(2026, 3, 1) / 1000);
    const to = Math.floor(Date.UTC(2026, 4, 1) / 1000);

    const r = await request(app)
      .get(`/admin/v1/financial/ggr?from=${from}&to=${to}&groupBy=operator,currency,day`)
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    expect(r.body.from).toBe(from);
    expect(r.body.to).toBe(to);
    expect(r.body.groupBy).toEqual(['operator', 'currency', 'day']);

    const rows = r.body.rows as Array<{
      operatorId: string;
      currency: string;
      day: string;
      betCount: number;
      stakeMinor: number;
      winMinor: number;
      ggrMinor: number;
      ngrMinor: number;
    }>;

    // Find EUR op-a 2026-04-10 cell
    const eurOpA10 = rows.find(
      (row) => row.operatorId === 'op-a' && row.currency === 'EUR' && row.day === '2026-04-10',
    );
    expect(eurOpA10).toBeDefined();
    // 10 SETTLED bets, stake=100ea, win=250ea
    expect(eurOpA10!.betCount).toBe(10);
    expect(eurOpA10!.stakeMinor).toBe(1000);
    expect(eurOpA10!.winMinor).toBe(2500);
    expect(eurOpA10!.ggrMinor).toBe(-1500);
    expect(eurOpA10!.ngrMinor).toBe(-1500); // NGR = GGR in v1

    // Find EUR op-a 2026-04-15 cell
    const eurOpA15 = rows.find(
      (row) => row.operatorId === 'op-a' && row.currency === 'EUR' && row.day === '2026-04-15',
    );
    expect(eurOpA15).toBeDefined();
    // 5 SETTLED bets, stake=100ea, win=150ea
    expect(eurOpA15!.betCount).toBe(5);
    expect(eurOpA15!.stakeMinor).toBe(500);
    expect(eurOpA15!.winMinor).toBe(750);
    expect(eurOpA15!.ggrMinor).toBe(-250);
  });

  it('VOIDED bets excluded; WIN_FAILED stake included, win excluded', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const expected = seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    const from = Math.floor(Date.UTC(2026, 3, 1) / 1000);
    const to = Math.floor(Date.UTC(2026, 4, 1) / 1000);

    const r = await request(app)
      .get(`/admin/v1/financial/ggr?from=${from}&to=${to}&groupBy=operator,currency`)
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    const rows = r.body.rows as Array<{
      operatorId: string;
      currency: string;
      stakeMinor: number;
      winMinor: number;
      ggrMinor: number;
      betCount: number;
    }>;

    const eurOpA = rows.find((r) => r.operatorId === 'op-a' && r.currency === 'EUR');
    expect(eurOpA).toBeDefined();

    // WIN_FAILED stake=100 is included; VOIDED bets are excluded
    // stake = 1000 + 500 + 800 + 100(WIN_FAILED) = 2400; win = 2500+750 = 3250 (WIN_FAILED win excluded)
    expect(eurOpA!.stakeMinor).toBe(expected.aprilEurOpAStake);    // 2400
    expect(eurOpA!.winMinor).toBe(expected.aprilEurOpAWin);        // 3250
    expect(eurOpA!.ggrMinor).toBe(expected.aprilEurOpAGgr);        // -850
    expect(eurOpA!.betCount).toBe(expected.aprilEurOpABetCount);   // 24 (10+5+8+1 WIN_FAILED; VOIDED excluded)
  });

  it('window bounding: bets outside from/to not included', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    // Only March window
    const from = Math.floor(Date.UTC(2026, 2, 1) / 1000);
    const to = Math.floor(Date.UTC(2026, 3, 1) / 1000);

    const r = await request(app)
      .get(`/admin/v1/financial/ggr?from=${from}&to=${to}&groupBy=operator,currency`)
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    const rows = r.body.rows as Array<{ operatorId: string; currency: string; stakeMinor: number }>;
    // Only the 1 SETTLED EUR op-a 2026-03-15 bet should appear
    const eurOpA = rows.find((r) => r.operatorId === 'op-a' && r.currency === 'EUR');
    expect(eurOpA).toBeDefined();
    expect(eurOpA!.stakeMinor).toBe(100);

    // op-b should not appear in March
    const btcOpB = rows.find((r) => r.operatorId === 'op-b');
    expect(btcOpB).toBeUndefined();
  });

  it('groupBy=operator collapses across currency and day; op-a stake = sum of EUR+USD for April', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    const from = Math.floor(Date.UTC(2026, 3, 1) / 1000);
    const to = Math.floor(Date.UTC(2026, 4, 1) / 1000);

    const r = await request(app)
      .get(`/admin/v1/financial/ggr?from=${from}&to=${to}&groupBy=operator`)
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    const rows = r.body.rows as Array<{
      operatorId: string;
      currency: string | null;
      day: string | null;
      stakeMinor: number;
    }>;

    const opARow = rows.find((r) => r.operatorId === 'op-a');
    expect(opARow).toBeDefined();
    // currency collapsed → null or empty; day collapsed → null
    expect(opARow!.currency).toBeFalsy();
    expect(opARow!.day).toBeNull();
    // EUR stake=2400 + USD stake=600 = 3000 (currencies mixed in ONE row since groupBy excludes currency)
    expect(opARow!.stakeMinor).toBe(2400 + 600);
  });
});

describe('GET /admin/v1/financial/ggr — bad inputs', () => {
  let token: string;
  let app: express.Application;

  beforeEach(async () => {
    const h = makeHarness();
    app = h.app;
    await h.adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    token = await loginAs(app, 'admin1', 'pw');
  });

  it('missing from → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/ggr?to=99999999&groupBy=operator')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('missing to → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/ggr?from=0&groupBy=operator')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('non-integer from → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/ggr?from=abc&to=99999999&groupBy=operator')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('to <= from → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/ggr?from=100&to=100&groupBy=operator')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('window > 1 year → 400 INVALID_REQUEST', async () => {
    const from = 0;
    const to = 366 * 86400; // > 365 days
    const r = await request(app)
      .get(`/admin/v1/financial/ggr?from=${from}&to=${to}&groupBy=operator`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('missing groupBy → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/ggr?from=0&to=99999')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('bad groupBy value → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/ggr?from=0&to=99999&groupBy=operator,invalid')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('bad period format in settlement → 400 INVALID_REQUEST', async () => {
    const r = await request(app)
      .get('/admin/v1/financial/settlement?period=2026/04')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /admin/v1/financial/settlement — spec §8.2', () => {
  it('returns nested shape with correct shareBps and ourShareMinor per operator', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const expected = seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    const r = await request(app)
      .get('/admin/v1/financial/settlement?period=2026-04')
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    expect(r.body.period).toBe('2026-04');

    const operators = r.body.operators as Array<{
      operatorId: string;
      currencies: Array<{
        currency: string;
        stakeMinor: number;
        winMinor: number;
        ggrMinor: number;
        shareBps: number;
        ourShareMinor: number;
      }>;
    }>;
    expect(Array.isArray(operators)).toBe(true);

    // op-a EUR
    const opA = operators.find((o) => o.operatorId === 'op-a');
    expect(opA).toBeDefined();
    const eurRow = opA!.currencies.find((c) => c.currency === 'EUR');
    expect(eurRow).toBeDefined();
    expect(eurRow!.stakeMinor).toBe(expected.aprilEurOpAStake);    // 2400
    expect(eurRow!.winMinor).toBe(expected.aprilEurOpAWin);        // 3250
    expect(eurRow!.ggrMinor).toBe(expected.aprilEurOpAGgr);        // -850
    expect(eurRow!.shareBps).toBe(1500);
    // ourShareMinor = floor(-850 * 1500 / 10000) = floor(-127.5) = -128
    expect(eurRow!.ourShareMinor).toBe(Math.floor(expected.aprilEurOpAGgr * 1500 / 10000));

    // op-b BTC
    const opB = operators.find((o) => o.operatorId === 'op-b');
    expect(opB).toBeDefined();
    const btcRow = opB!.currencies.find((c) => c.currency === 'BTC');
    expect(btcRow).toBeDefined();
    expect(btcRow!.stakeMinor).toBe(expected.aprilBtcOpBStake);    // 500000
    expect(btcRow!.ggrMinor).toBe(expected.aprilBtcOpBGgr);        // 500000
    expect(btcRow!.shareBps).toBe(2500);
    // ourShareMinor = floor(500000 * 2500 / 10000) = floor(125000) = 125000
    expect(btcRow!.ourShareMinor).toBe(Math.floor(expected.aprilBtcOpBGgr * 2500 / 10000));

    // Outside-period bets must not appear: no 2026-03 or 2026-05 data in April settlement
    // (verified implicitly — the EUR op-a stake is exactly 2400, not 2600 (which would include March/May))
    expect(eurRow!.stakeMinor).toBe(2400);
  });

  it('missing period param → 400 INVALID_REQUEST', async () => {
    const { app, adminUsers } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const r = await request(app)
      .get('/admin/v1/financial/settlement')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('viewer → 403 on settlement', async () => {
    const { app, adminUsers } = makeHarness();
    await adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);
    const token = await loginAs(app, 'viewer1', 'pw');

    const r = await request(app)
      .get('/admin/v1/financial/settlement?period=2026-04')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('POST /admin/v1/financial/settlement/:period/invoice — spec §8.3', () => {
  it('returns invoice JSON with correct shape; audit row written', async () => {
    const { app, adminUsers, db, registry, adminAudit } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const expected = seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    const r = await request(app)
      .post('/admin/v1/financial/settlement/2026-04/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-a' });

    expect(r.status).toBe(200);

    const body = r.body as {
      invoiceId: string;
      period: string;
      operatorId: string;
      operator: { name: string };
      generatedAt: number;
      currencies: Array<{
        currency: string;
        stakeMinor: number;
        winMinor: number;
        ggrMinor: number;
        shareBps: number;
        ourShareMinor: number;
      }>;
      totals: Record<string, { ggrMinor: number; ourShareMinor: number }>;
    };

    expect(body.invoiceId).toMatch(/^inv-2026-04-op-a-\d+$/);
    expect(body.period).toBe('2026-04');
    expect(body.operatorId).toBe('op-a');
    expect(body.operator.name).toBe('Operator A');
    expect(typeof body.generatedAt).toBe('number');

    // EUR currency row
    const eurRow = body.currencies.find((c) => c.currency === 'EUR');
    expect(eurRow).toBeDefined();
    expect(eurRow!.stakeMinor).toBe(expected.aprilEurOpAStake);
    expect(eurRow!.ggrMinor).toBe(expected.aprilEurOpAGgr);
    expect(eurRow!.shareBps).toBe(1500);
    expect(eurRow!.ourShareMinor).toBe(Math.floor(expected.aprilEurOpAGgr * 1500 / 10000));

    // USD currency row
    const usdRow = body.currencies.find((c) => c.currency === 'USD');
    expect(usdRow).toBeDefined();
    expect(usdRow!.ggrMinor).toBe(expected.aprilUsdOpAGgr);

    // Totals — per-currency, no mixing
    expect(body.totals['EUR']).toBeDefined();
    expect(body.totals['EUR']!.ggrMinor).toBe(expected.aprilEurOpAGgr);
    expect(body.totals['USD']).toBeDefined();
    // BTC should NOT appear in op-a's invoice
    expect(body.totals['BTC']).toBeUndefined();

    // Audit row was written
    const auditRows = adminAudit.listFiltered({ action: 'financial.invoice.generated' }, { limit: 10 });
    const auditRow = auditRows.rows.find((row) => row.action === 'financial.invoice.generated');
    expect(auditRow).toBeDefined();
    expect(auditRow!.target).toBe('operator:op-a:period:2026-04');
    expect(auditRow!.payload?.['operatorId']).toBe('op-a');
    expect(auditRow!.payload?.['period']).toBe('2026-04');
    expect(auditRow!.payload?.['invoiceId']).toMatch(/^inv-2026-04-op-a-\d+$/);
    expect(auditRow!.payload?.['currencyCount']).toBe(2); // EUR + USD
  });

  it('operator with no activity in period → 404 NO_SETTLEMENT_DATA', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    // op-b has no activity in January 2026
    const r = await request(app)
      .post('/admin/v1/financial/settlement/2026-01/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-b' });

    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NO_SETTLEMENT_DATA');
  });

  it('completely unknown operator → 404 NO_SETTLEMENT_DATA', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    const r = await request(app)
      .post('/admin/v1/financial/settlement/2026-04/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-does-not-exist' });

    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NO_SETTLEMENT_DATA');
  });

  it('bad period format in route → 400 INVALID_REQUEST', async () => {
    const { app, adminUsers } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const r = await request(app)
      .post('/admin/v1/financial/settlement/bad-period/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-a' });

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('missing operatorId in body → 400 INVALID_REQUEST', async () => {
    const { app, adminUsers } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const r = await request(app)
      .post('/admin/v1/financial/settlement/2026-04/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });

  it('viewer → 403 on invoice', async () => {
    const { app, adminUsers } = makeHarness();
    await adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);
    const token = await loginAs(app, 'viewer1', 'pw');

    const r = await request(app)
      .post('/admin/v1/financial/settlement/2026-04/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: 'op-a' });

    expect(r.status).toBe(403);
  });
});

describe('shareBps PATCH round-trip → settlement reflects updated value', () => {
  it('PATCH /operators/:id with shareBps=3000; settlement ourShareMinor uses new value', async () => {
    const { app, adminUsers, db, registry } = makeHarness();
    await adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFinancialFixture(db, registry);
    const token = await loginAs(app, 'admin1', 'pw');

    // Update op-b shareBps to 3000
    const patchRes = await request(app)
      .patch('/admin/v1/operators/op-b')
      .set('Authorization', `Bearer ${token}`)
      .send({ shareBps: 3000 });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.shareBps).toBe(3000);

    // Now check settlement
    const r = await request(app)
      .get('/admin/v1/financial/settlement?period=2026-04')
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    const operators = r.body.operators as Array<{
      operatorId: string;
      currencies: Array<{ currency: string; shareBps: number; ggrMinor: number; ourShareMinor: number }>;
    }>;
    const opB = operators.find((o) => o.operatorId === 'op-b');
    expect(opB).toBeDefined();
    const btcRow = opB!.currencies.find((c) => c.currency === 'BTC');
    expect(btcRow).toBeDefined();
    expect(btcRow!.shareBps).toBe(3000);
    expect(btcRow!.ourShareMinor).toBe(Math.floor(btcRow!.ggrMinor * 3000 / 10000));
  });
});
