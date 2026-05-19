/**
 * Integration tests for admin read API — Task 5.3.
 *
 * Tests:
 *   - GET /rounds (grouped from bet_log), with filters and pagination
 *   - GET /rounds/:id (full detail + 404)
 *   - GET /bets (filtered + paginated; state validation; EXPLAIN QUERY PLAN index check)
 *   - GET /bets/:id (bet + timeline + walletCalls; 404)
 *   - GET /transactions (finance|admin guard; viewer 403; item shape)
 *   - GET /audit (admin guard; viewer 403; payload decoded; ?action= filter)
 *   - Cursor pagination: full page + nextCursor; following cursor; final page nextCursor null
 *   - Bad cursor → 400 INVALID_CURSOR on every paginated route
 *
 * Hermetic per describe: fresh :memory: db + router, seeded via direct BetLog/AdminAudit calls.
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

const TEST_SECRET = 'test-jwt-secret-read-api';
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
// Fixture seeder: inserts ~120 bet_log rows across 2 operators / 3 players /
// multiple rounds / mixed states / spread created_at, plus idempotency rows,
// plus audit rows.
// ---------------------------------------------------------------------------

let _seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${++_seq}`;
}

interface SeedResult {
  op1: string;
  op2: string;
  p1: string;
  p2: string;
  p3: string;
  rounds: string[];
  allBetIds: string[];
  op1BetIds: string[];
  settledBetIds: string[];
  now: number;
}

function seedFixture(betLog: BetLog, adminAudit: AdminAudit): SeedResult {
  const now = Math.floor(Date.now() / 1000);
  const op1 = 'fixture-op1';
  const op2 = 'fixture-op2';
  const p1 = 'player-1';
  const p2 = 'player-2';
  const p3 = 'player-3';

  const rounds = [
    uid('round'),
    uid('round'),
    uid('round'),
    uid('round'),
    uid('round'),
  ];

  const allBetIds: string[] = [];
  const op1BetIds: string[] = [];
  const settledBetIds: string[] = [];

  // Helper to insert a bet at a specific timestamp and advance it
  function insertBet(opts: {
    op: string;
    player: string;
    round: string;
    state: 'PENDING' | 'ARMED' | 'SETTLED' | 'LOST' | 'WIN_FAILED';
    offset: number; // seconds before now
    multiplier?: number;
    currency?: string;
  }): string {
    const betId = uid('bet');
    const betTxnId = uid('btxn');
    const currency = opts.currency ?? 'EUR';
    const createdAt = now - opts.offset;

    // Direct SQL insert for full control over timestamps
    betLog['db'].prepare(`
      INSERT INTO bet_log (
        bet_id, operator_id, player_id, session_id, round_id, currency,
        amount_minor, state, bet_txn_id,
        win_txn_id, rollback_txn_id, bet_op_txn_id, win_op_txn_id,
        win_amount_minor, multiplier, error_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, ?, ?)
    `).run(
      betId,
      opts.op,
      opts.player,
      `sess-${opts.player}`,
      opts.round,
      currency,
      5000,
      opts.state,
      betTxnId,
      opts.state !== 'PENDING' ? `op-bet-txn-${betId}` : null,
      opts.state === 'SETTLED' ? 10000 : null,
      opts.state === 'SETTLED' ? (opts.multiplier ?? 2.0) : null,
      createdAt,
      createdAt + 1,
    );

    allBetIds.push(betId);
    if (opts.op === op1) op1BetIds.push(betId);
    if (opts.state === 'SETTLED') settledBetIds.push(betId);
    return betId;
  }

  // Insert idempotency row for a settled bet
  function insertIdempotency(betLog: BetLog, betId: string, op: string, createdAt: number): void {
    const txnId = uid('txn');
    betLog.putIdempotency({
      txnId,
      operatorId: op,
      kind: 'bet',
      requestHash: `hash-${txnId}`,
      responseJson: JSON.stringify({ ok: true, balanceMinor: 100000, operatorTxnId: `op-ref-${txnId}` }),
      createdAt,
    });
    // Update the bet's bet_txn_id to match so the JOIN works
    betLog['db'].prepare('UPDATE bet_log SET bet_txn_id = ? WHERE bet_id = ?').run(txnId, betId);
  }

  // Seed 130 bets spread evenly across 5 rounds (26 bets per round):
  // each loop iteration writes 5 bets, one per round (not all to the same round).
  let offset = 0;
  for (let i = 0; i < 26; i++) {
    offset += 10;
    const r0 = rounds[(i + 0) % rounds.length]!;
    const r1 = rounds[(i + 1) % rounds.length]!;
    const r2 = rounds[(i + 2) % rounds.length]!;
    const r3 = rounds[(i + 3) % rounds.length]!;
    const r4 = rounds[(i + 4) % rounds.length]!;
    const b1 = insertBet({ op: op1, player: p1, round: r0, state: 'SETTLED', offset, multiplier: 2.0 + (i * 0.1) });
    insertBet({ op: op1, player: p2, round: r1, state: 'ARMED', offset: offset + 1 });
    insertBet({ op: op2, player: p3, round: r2, state: 'LOST', offset: offset + 2 });
    insertBet({ op: op2, player: p1, round: r3, state: 'SETTLED', offset: offset + 3, multiplier: 1.5 });
    insertBet({ op: op1, player: p3, round: r4, state: 'WIN_FAILED', offset: offset + 4 });
    insertIdempotency(betLog, b1, op1, now - offset);
  }

  // Seed some audit rows
  adminAudit.record({ actor: 'alice', action: 'operator.create', target: 'operator:fixture-op1', payload: { test: true } });
  adminAudit.record({ actor: 'bob', action: 'operator.pause', target: 'operator:fixture-op2', payload: { reason: 'test' } });
  adminAudit.record({ actor: 'alice', action: 'force_credit', target: uid('bet'), payload: { result: 'settled' } });

  return { op1, op2, p1, p2, p3, rounds, allBetIds, op1BetIds, settledBetIds, now };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /admin/v1/bets — pagination', () => {
  it('first page returns limit=50 items + nextCursor; following cursor yields next batch; final page nextCursor null; union = all rows, no dupes', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const totalCount = seed.allBetIds.length; // 130

    // Page 1: limit=50
    const res1 = await request(app)
      .get('/admin/v1/bets?limit=50')
      .set('Authorization', `Bearer ${token}`);

    expect(res1.status).toBe(200);
    expect(res1.body.items).toHaveLength(50);
    expect(res1.body.count).toBe(50);
    expect(typeof res1.body.nextCursor).toBe('string');
    expect(res1.body.nextCursor).not.toBeNull();

    const page1Ids = new Set((res1.body.items as Array<{ betId: string }>).map((b) => b.betId));

    // Page 2: follow cursor
    const res2 = await request(app)
      .get(`/admin/v1/bets?limit=50&cursor=${encodeURIComponent(res1.body.nextCursor as string)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res2.status).toBe(200);
    expect(res2.body.items).toHaveLength(50);
    const page2Ids = new Set((res2.body.items as Array<{ betId: string }>).map((b) => b.betId));

    // No duplicates between pages
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }

    // Page 3: follow cursor again — should be remaining 30 items
    const res3 = await request(app)
      .get(`/admin/v1/bets?limit=50&cursor=${encodeURIComponent(res2.body.nextCursor as string)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res3.status).toBe(200);
    expect(res3.body.items).toHaveLength(totalCount - 100);
    // Final page — nextCursor should be null
    expect(res3.body.nextCursor).toBeNull();

    // Union covers all bets (no gaps, no dupes)
    const allPageIds = new Set([
      ...page1Ids,
      ...page2Ids,
      ...(res3.body.items as Array<{ betId: string }>).map((b) => b.betId),
    ]);
    expect(allPageIds.size).toBe(totalCount);
    for (const id of seed.allBetIds) {
      expect(allPageIds.has(id)).toBe(true);
    }
  });
});

describe('GET /admin/v1/bets — filters', () => {
  it('?operatorId= returns only that operator\'s bets', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get(`/admin/v1/bets?operatorId=${seed.op1}&limit=200`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ operatorId: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.operatorId === seed.op1)).toBe(true);
    expect(items.length).toBe(seed.op1BetIds.length);
  });

  it('?state=SETTLED returns only SETTLED bets', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/bets?state=SETTLED&limit=200')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ state: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.state === 'SETTLED')).toBe(true);
    expect(items.length).toBe(seed.settledBetIds.length);
  });

  it('?state=BOGUS → 400 INVALID_REQUEST', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/bets?state=BOGUS')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('?playerId= filters by player', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get(`/admin/v1/bets?playerId=${seed.p3}&limit=200`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ playerId: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.playerId === seed.p3)).toBe(true);
  });

  it('?operatorId= + ?state= combined filter (AND)', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get(`/admin/v1/bets?operatorId=${seed.op1}&state=SETTLED&limit=200`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ operatorId: string; state: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.operatorId === seed.op1 && b.state === 'SETTLED')).toBe(true);
  });
});

describe('GET /admin/v1/rounds', () => {
  it('groups bets by round_id correctly — betCount per round matches fixture', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/rounds?limit=200')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBe(seed.rounds.length);

    // Each round should have betCount = 26 (130 total / 5 rounds)
    for (const item of res.body.items as Array<{ betCount: number; roundId: string }>) {
      expect(item.betCount).toBe(26);
      expect(seed.rounds).toContain(item.roundId);
    }
  });

  it('?from&to window filters rounds by time', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    // Only request rounds within the last 60 seconds (should get some but not all given offsets up to ~260s)
    const from = seed.now - 60;
    const res = await request(app)
      .get(`/admin/v1/rounds?from=${from}&limit=200`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Some rounds should be within the window
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('?minMultiplier filters to rounds with max multiplier >= threshold', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    // With a very high minMultiplier, expect 0 rounds
    const res = await request(app)
      .get('/admin/v1/rounds?minMultiplier=999&limit=200')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('bad cursor → 400 INVALID_CURSOR', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/rounds?cursor=@@@invalid@@@')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /admin/v1/rounds/:roundId', () => {
  it('returns round summary + bets array', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const roundId = seed.rounds[0]!;
    const res = await request(app)
      .get(`/admin/v1/rounds/${roundId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.round.roundId).toBe(roundId);
    expect(res.body.round.betCount).toBe(26);
    expect(Array.isArray(res.body.bets)).toBe(true);
    expect(res.body.bets).toHaveLength(26);
    // Spec fields that are not persisted should be null
    expect(res.body.round.serverSeed).toBeNull();
    expect(res.body.round.crashPoint).toBeNull();
  });

  it('unknown roundId → 404 ROUND_NOT_FOUND', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/rounds/no-such-round-xyz')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUND_NOT_FOUND');
  });
});

describe('GET /admin/v1/bets/:betId', () => {
  it('returns bet + timeline + walletCalls', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const betId = seed.settledBetIds[0]!;
    const res = await request(app)
      .get(`/admin/v1/bets/${betId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.bet.betId).toBe(betId);
    expect(res.body.bet.state).toBe('SETTLED');
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(res.body.timeline.length).toBeGreaterThanOrEqual(1);
    // walletCalls is an array (may have entries if idempotency row exists)
    expect(Array.isArray(res.body.walletCalls)).toBe(true);
    // Per-transition history is NOT persisted — attempts/totalMs are null
    if (res.body.walletCalls.length > 0) {
      expect(res.body.walletCalls[0].attempts).toBeNull();
      expect(res.body.walletCalls[0].totalMs).toBeNull();
    }
  });

  it('unknown betId → 404 BET_NOT_FOUND', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/bets/no-such-bet-xyz')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BET_NOT_FOUND');
  });

  it('bad cursor on /bets → 400 INVALID_CURSOR', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/bets?cursor=!!!bad!!!')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /admin/v1/transactions — roles + shape', () => {
  it('viewer token → 403 FORBIDDEN', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);
    const token = await loginAs(app, 'viewer1', 'pw');

    const res = await request(app)
      .get('/admin/v1/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('finance token → 200 OK', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    adminUsers.create('finance1', await bcrypt.hash('pw', 10), ['finance']);
    const token = await loginAs(app, 'finance1', 'pw');

    const res = await request(app)
      .get('/admin/v1/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('admin token → 200 OK (superuser bypasses finance guard)', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/transactions?limit=200')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('§7.1 item shape: txnId, operatorId, kind, attempts=null, totalMs=null present', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/transactions?limit=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const item = res.body.items[0] as Record<string, unknown>;
    expect(typeof item['txnId']).toBe('string');
    expect(typeof item['operatorId']).toBe('string');
    expect(typeof item['kind']).toBe('string');
    // Not persisted — must be null per spec honest-null contract
    expect(item['attempts']).toBeNull();
    expect(item['totalMs']).toBeNull();
    expect(item['status']).toBeDefined();
  });

  it('bad cursor → 400 INVALID_CURSOR', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('finance1', await bcrypt.hash('pw', 10), ['finance']);
    const token = await loginAs(app, 'finance1', 'pw');

    const res = await request(app)
      .get('/admin/v1/transactions?cursor=not-base64url-json')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /admin/v1/audit — roles + filter + cursor', () => {
  it('viewer → 403 FORBIDDEN', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);
    const token = await loginAs(app, 'viewer1', 'pw');

    const res = await request(app)
      .get('/admin/v1/audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('admin → 200; payload decoded to object', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/audit?limit=200')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    // Payload should be decoded to object, not a raw JSON string
    const itemWithPayload = (res.body.items as Array<{ payload: unknown }>).find((i) => i.payload !== null);
    if (itemWithPayload) {
      expect(typeof itemWithPayload.payload).toBe('object');
    }
  });

  it('?action= filter returns only matching rows', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/audit?action=operator.create&limit=200')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ action: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.action === 'operator.create')).toBe(true);
  });

  it('bad cursor → 400 INVALID_CURSOR', async () => {
    const { app, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const token = await loginAs(app, 'admin1', 'pw');

    const res = await request(app)
      .get('/admin/v1/audit?cursor=ZZZZ')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('EXPLAIN QUERY PLAN — index coverage', () => {
  it('bets-by-operatorId filter uses idx_betlog_operator index (not full scan)', () => {
    const { db } = makeHarness();

    // Run EXPLAIN QUERY PLAN for the operator-only filter query
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT * FROM bet_log
       WHERE operator_id = ?
       ORDER BY created_at DESC, bet_id DESC
       LIMIT 50`,
    ).all('any-op') as Array<{ detail: string }>;

    const planText = plan.map((r) => r.detail).join(' ');
    // Should use the index, not scan the full table without index guidance
    // Accept either 'USING INDEX' or 'USING COVERING INDEX'
    expect(planText.toUpperCase()).toContain('USING INDEX');
  });

  it('uses index for operator-filtered transactions query (no SCAN of txn_idempotency)', () => {
    const { db } = makeHarness();

    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM txn_idempotency
      WHERE operator_id = ?
      ORDER BY created_at DESC, txn_id DESC
      LIMIT 50`).all('any-op') as Array<{ detail: string }>;

    const planText = plan.map((r) => r.detail).join(' | ').toUpperCase();
    expect(planText).toContain('USING INDEX');
  });
});

describe('GET /admin/v1/rounds — HAVING-cursor pagination traversal', () => {
  it('paginates rounds with HAVING-cursor: 2 pages, no dups, no gaps', async () => {
    const { app, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    const seed = seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    const seenRoundIds = new Set<string>();

    const res1 = await request(app)
      .get('/admin/v1/rounds?limit=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res1.status).toBe(200);
    expect(res1.body.items).toHaveLength(3);
    expect(res1.body.nextCursor).toBeTruthy();
    for (const r of res1.body.items as Array<{ roundId: string }>) {
      seenRoundIds.add(r.roundId);
    }

    const res2 = await request(app)
      .get(`/admin/v1/rounds?limit=3&cursor=${encodeURIComponent(res1.body.nextCursor as string)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res2.status).toBe(200);
    expect(res2.body.items).toHaveLength(2); // 5 rounds total: 3 + 2
    expect(res2.body.nextCursor).toBeNull();
    for (const r of res2.body.items as Array<{ roundId: string }>) {
      seenRoundIds.add(r.roundId);
    }

    // Union equals total, no dups, no gaps
    expect(seenRoundIds.size).toBe(5);
    for (const expected of seed.rounds) {
      expect(seenRoundIds.has(expected)).toBe(true);
    }
  });
});

describe('GET /admin/v1/transactions — keyset pagination traversal', () => {
  it('paginates transactions across 3 pages, no dups, no gaps', async () => {
    const { app, db, betLog, adminAudit, adminUsers } = makeHarness();
    adminUsers.create('admin1', await bcrypt.hash('pw', 10), ['admin']);
    seedFixture(betLog, adminAudit);
    const token = await loginAs(app, 'admin1', 'pw');

    // Count fixture txns up front so the assertion is honest about the total.
    const totalTxns = db.prepare('SELECT COUNT(*) as c FROM txn_idempotency').get() as { c: number };
    const limit = 10;

    const seenTxnIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    while (true) {
      const url = cursor
        ? `/admin/v1/transactions?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
        : `/admin/v1/transactions?limit=${limit}`;

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);

      for (const item of res.body.items as Array<{ txnId: string }>) {
        expect(seenTxnIds.has(item.txnId)).toBe(false); // no dup across pages
        seenTxnIds.add(item.txnId);
      }

      pages++;
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor as string;
      if (pages > 10) throw new Error('runaway pagination');
    }

    // Union equals total, no dups, no gaps
    expect(seenTxnIds.size).toBe(totalTxns.c);
  });
});
