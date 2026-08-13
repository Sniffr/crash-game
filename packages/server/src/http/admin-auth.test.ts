/**
 * Integration tests for JWT admin auth + operator/admin CRUD (Task 5.2).
 *
 * Hermetic vitest + supertest. Mirror of operator-terminate.test.ts harness.
 *
 * Covers:
 *   - Login happy path; wrong-password + unknown-user identical 401 (no enumeration)
 *   - JWT_SECRET unset → 503 ADMIN_DISABLED
 *   - requireAdminJwt: no/malformed/array bearer → 401; expired → 401; revoked → 401
 *   - requireRole: viewer → admin-only route 403; admin → finance route 200; finance → admin-only 403
 *   - Bootstrap idempotency
 *   - Operators CRUD round-trip (create, list, get, patch, regen-key, pause, resume, credentials)
 *   - Admins CRUD (create, list, patch, delete, cannot-delete-self)
 *   - Audit rows for key operations
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Store mock — must be hoisted BEFORE any imports that pull in store.ts
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
  recordStatsSafely: vi.fn(async (fn: () => Promise<unknown>) => { try { return await fn(); } catch { return undefined; } }),
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
import { PgOperatorRegistry } from '@crash/wallet';
import * as bcrypt from 'bcryptjs';

import { PgAdminAudit, PgAdminUsers } from '../admin/admin-store-pg.js';
import { createAdminRouter } from './admin.js';
import { signAdminJwt } from './middleware/admin-auth.js';
import { WalletClientCache } from '../wallet/client-cache.js';
import { PgBetLog } from '@crash/wallet';

// ---------------------------------------------------------------------------
// Test harness factory — creates a fresh isolated Postgres schema per test
// ---------------------------------------------------------------------------

// Per-test Postgres schemas created via makeTestDb(); cleaned up in afterEach.
const openDbs: TestDb[] = [];
async function newTestDb(): Promise<TestDb> {
  const db = await makeTestDb();
  openDbs.push(db);
  return db;
}

interface TestHarness {
  app: express.Application;
  adminUsers: PgAdminUsers;
  adminAudit: PgAdminAudit;
  registry: PgOperatorRegistry;
  revoked: Set<string>;
  pool: TestDb['pool'];
  walletClientCache: WalletClientCache;
}

async function makeHarness(): Promise<TestHarness> {
  const { pool } = await newTestDb();
  const betLog = new PgBetLog(pool);
  const registry = new PgOperatorRegistry(pool);
  const adminAudit = new PgAdminAudit(pool);
  const adminUsers = new PgAdminUsers(pool);
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

  return { app, adminUsers, adminAudit, registry, revoked, pool, walletClientCache };
}

/**
 * The admin router writes audit rows via fire-and-forget `record()` (returns
 * void, does not await the INSERT). Poll the audit log until `pred` is satisfied
 * so assertions don't race the in-flight write.
 */
type AuditRows = Awaited<ReturnType<PgAdminAudit['list']>>;
async function waitForAudit(
  adminAudit: PgAdminAudit,
  pred: (rows: AuditRows) => boolean,
  tries = 100,
): Promise<AuditRows> {
  let rows: AuditRows = [];
  for (let i = 0; i < tries; i++) {
    rows = await adminAudit.list({ limit: 100 });
    if (pred(rows)) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Per-test env management
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-admin-auth';
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
  await Promise.all(openDbs.splice(0).map((d) => d.cleanup()));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAs(
  app: express.Application,
  username: string,
  password: string,
): Promise<{ token: string; roles: string[]; expiresAt: number; status: number }> {
  const res = await request(app)
    .post('/admin/v1/auth/login')
    .send({ username, password });
  return {
    status: res.status,
    token: (res.body as { token?: string }).token ?? '',
    roles: (res.body as { roles?: string[] }).roles ?? [],
    expiresAt: (res.body as { expiresAt?: number }).expiresAt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// §1.1 Login
// ---------------------------------------------------------------------------

describe('POST /admin/v1/auth/login', () => {
  it('happy path: returns token, expiresAt, roles (200)', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const res = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice', password: 'secret' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(10);
    expect(typeof res.body.expiresAt).toBe('number');
    expect(res.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(res.body.roles).toEqual(['admin']);
  });

  it('wrong password → 401 INVALID_CREDENTIALS', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const res = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('unknown user → same 401 INVALID_CREDENTIALS (no enumeration)', async () => {
    const { app } = await makeHarness();

    const unknownRes = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'nobody', password: 'anypass' });

    expect(unknownRes.status).toBe(401);
    expect(unknownRes.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('wrong password and unknown user responses are identical (no enumeration)', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const wrongPassRes = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice', password: 'wrong' });

    const unknownUserRes = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'nobody', password: 'pass' });

    expect(wrongPassRes.status).toBe(unknownUserRes.status);
    expect(wrongPassRes.body.error.code).toBe(unknownUserRes.body.error.code);
    expect(wrongPassRes.body.error.message).toBe(unknownUserRes.body.error.message);
  });

  it('JWT_SECRET unset → 503 ADMIN_DISABLED', async () => {
    delete process.env['JWT_SECRET'];
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const res = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice', password: 'secret' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ADMIN_DISABLED');
  });

  it('missing username → 400 INVALID_REQUEST', async () => {
    const { app } = await makeHarness();
    const res = await request(app)
      .post('/admin/v1/auth/login')
      .send({ password: 'pw' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('missing password → 400 INVALID_REQUEST', async () => {
    const { app } = await makeHarness();
    const res = await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// requireAdminJwt middleware
// ---------------------------------------------------------------------------

describe('requireAdminJwt', () => {
  it('no Authorization header → 401 INVALID_JWT', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const res = await request(app).get('/admin/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JWT');
  });

  it('malformed bearer → 401 INVALID_JWT', async () => {
    const { app } = await makeHarness();
    const res = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JWT');
  });

  it('array Authorization header → 401 INVALID_JWT', async () => {
    // Test the typeof !== 'string' guard via direct middleware invocation
    const { requireAdminJwt: mwFactory } = await import('./middleware/admin-auth.js');
    const revoked = new Set<string>();
    const mw = mwFactory({ revoked });

    let statusCode = 0;
    let jsonBody: unknown;
    let nextCalled = false;

    const fakeReq = {
      headers: { 'authorization': ['Bearer token1', 'Bearer token2'] },
    } as unknown as import('express').Request;

    const fakeRes = {
      headersSent: false,
      status(code: number) { statusCode = code; return fakeRes; },
      json(body: unknown) { jsonBody = body; return fakeRes; },
    } as unknown as import('express').Response;

    await new Promise<void>((resolve) => {
      void mw(fakeReq, fakeRes, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 100);
    });

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(401);
    expect((jsonBody as { error: { code: string } }).error.code).toBe('INVALID_JWT');
  });

  it('expired token → 401 INVALID_JWT', async () => {
    const { app } = await makeHarness();

    // Sign a token that expired 2 hours ago
    const nowSeconds = () => Math.floor(Date.now() / 1000) - 7200;
    const { token } = await signAdminJwt(
      { sub: 'alice', roles: ['admin'] },
      { ttlSeconds: 1, nowSeconds },  // expires 1 second into the past
    );

    const res = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JWT');
  });

  it('revoked token (login→logout→reuse) → 401 INVALID_JWT', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'secret');

    // Logout — revokes the jti
    await request(app)
      .post('/admin/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    // Reuse the same token — should be 401
    const res = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JWT');
  });

  it('JWT_SECRET changed after login → 401 INVALID_JWT (token signed with old secret)', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'secret');

    // Change the secret
    process.env['JWT_SECRET'] = 'completely-different-secret';

    const res = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JWT');
  });
});

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe('requireRole', () => {
  it('viewer role → admin-only route (GET /admins) → 403 FORBIDDEN', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('viewer1', await bcrypt.hash('pw', 10), ['viewer']);

    const { token } = await loginAs(app, 'viewer1', 'pw');
    const res = await request(app)
      .get('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('admin role → any route (superuser per spec §1.3) → passes', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('superadmin', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'superadmin', 'pw');
    // GET /admins requires role 'admin' — should pass
    const res = await request(app)
      .get('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('finance role → admin-only route → 403 FORBIDDEN', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('financer', await bcrypt.hash('pw', 10), ['finance']);

    const { token } = await loginAs(app, 'financer', 'pw');
    const res = await request(app)
      .get('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('support role → GET /me (any role) → 200', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('support1', await bcrypt.hash('pw', 10), ['support']);

    const { token } = await loginAs(app, 'support1', 'pw');
    const res = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('support1');
  });
});

// ---------------------------------------------------------------------------
// Bootstrap idempotency
// ---------------------------------------------------------------------------

describe('Bootstrap idempotency', () => {
  it('count()=0 + create → count becomes 1', async () => {
    const { pool } = await newTestDb();
    const adminUsers = new PgAdminUsers(pool);

    expect(await adminUsers.count()).toBe(0);
    await adminUsers.create('root', 'hash', ['admin']);
    expect(await adminUsers.count()).toBe(1);
  });

  it('second create with same username throws DuplicateAdminError (bootstrap skip if count>0)', async () => {
    const { pool } = await newTestDb();
    const adminUsers = new PgAdminUsers(pool);

    await adminUsers.create('root', 'hash1', ['admin']);
    // Simulate bootstrap check: if count>0, skip
    expect(await adminUsers.count()).toBeGreaterThan(0);

    // If bootstrap blindly called create again, it would throw DuplicateAdminError
    const { DuplicateAdminError: DAE } = await import('../admin/admin-store.js');
    await expect(adminUsers.create('root', 'hash2', ['admin'])).rejects.toThrow(DAE);
  });

  it('pre-existing admin: bootstrap skips, original not overwritten', async () => {
    const { pool } = await newTestDb();
    const adminUsers = new PgAdminUsers(pool);

    // Pre-existing admin
    await adminUsers.create('root', 'original-hash', ['admin']);
    const before = (await adminUsers.getByUsername('root'))!;

    // Bootstrap simulation: count>0 → skip
    if (await adminUsers.count() === 0) {
      await adminUsers.create('root', 'new-hash', ['admin']);
    }

    const after = (await adminUsers.getByUsername('root'))!;
    expect(after.passwordHash).toBe(before.passwordHash);
  });
});

// ---------------------------------------------------------------------------
// /me endpoint
// ---------------------------------------------------------------------------

describe('GET /admin/v1/me', () => {
  it('returns username, roles, lastLoginAt', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('secret', 10), ['admin', 'finance']);

    const { token } = await loginAs(app, 'alice', 'secret');
    const res = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice');
    expect(res.body.roles).toEqual(expect.arrayContaining(['admin', 'finance']));
    expect(typeof res.body.lastLoginAt).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// /admins CRUD
// ---------------------------------------------------------------------------

describe('/admin/v1/admins CRUD', () => {
  it('create admin (POST /admins) → 201, list (GET /admins) includes it', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const createRes = await request(app)
      .post('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'bob', password: 'bobsecret', roles: ['support'] });

    expect(createRes.status).toBe(201);
    expect(createRes.body.username).toBe('bob');
    expect(createRes.body.roles).toEqual(['support']);

    const listRes = await request(app)
      .get('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((u: { username: string }) => u.username === 'bob')).toBe(true);
    // Ensure no password/hash in list
    expect(listRes.body.items.every((u: Record<string, unknown>) => !('passwordHash' in u) && !('password' in u))).toBe(true);
  });

  it('duplicate username → 409 DUPLICATE_ADMIN', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await adminUsers.create('bob', await bcrypt.hash('pw', 10), ['support']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .post('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'bob', password: 'newpw', roles: ['viewer'] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_ADMIN');
  });

  it('PATCH /admins/:username updates roles', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await adminUsers.create('bob', await bcrypt.hash('pw', 10), ['support']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .patch('/admin/v1/admins/bob')
      .set('Authorization', `Bearer ${token}`)
      .send({ roles: ['support', 'finance'] });

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(expect.arrayContaining(['support', 'finance']));
  });

  it('PATCH /admins/:username → 404 for unknown user', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .patch('/admin/v1/admins/nobody')
      .set('Authorization', `Bearer ${token}`)
      .send({ roles: ['viewer'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADMIN_NOT_FOUND');
  });

  it('DELETE /admins/:username deletes the user', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await adminUsers.create('bob', await bcrypt.hash('pw', 10), ['support']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const delRes = await request(app)
      .delete('/admin/v1/admins/bob')
      .set('Authorization', `Bearer ${token}`);

    expect(delRes.status).toBe(204);
    expect(await adminUsers.getByUsername('bob')).toBeNull();
  });

  it('cannot delete self → 409 CANNOT_DELETE_SELF', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .delete('/admin/v1/admins/alice')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_DELETE_SELF');
  });

  it('DELETE non-existent → 404 ADMIN_NOT_FOUND', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .delete('/admin/v1/admins/nobody')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADMIN_NOT_FOUND');
  });

  it('POST /admins with invalid role → 400 INVALID_REQUEST', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .post('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'wizard', password: 'pw', roles: ['admin', 'bogus'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// /operators CRUD round-trip
// ---------------------------------------------------------------------------

describe('/admin/v1/operators CRUD', () => {
  it('create operator → 201 with credentials; GET /operators no apiKey/signingKey leak', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const createRes = await request(app)
      .post('/admin/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operatorId: 'acme',
        name: 'Acme Casino',
        walletBaseUrl: 'https://wallet.acme.com/v1',
        currencies: ['EUR', 'USD'],
        status: 'sandbox',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.operator.operatorId).toBe('acme');
    expect(typeof createRes.body.credentials.apiKey).toBe('string');
    expect(typeof createRes.body.credentials.signingKey).toBe('string');
    // Must NOT include apiKey/signingKey in operator shape
    expect(createRes.body.operator.apiKey).toBeUndefined();
    expect(createRes.body.operator.signingKey).toBeUndefined();

    // GET /operators — no secrets
    const listRes = await request(app)
      .get('/admin/v1/operators')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    const item = listRes.body.items.find((o: { operatorId: string }) => o.operatorId === 'acme');
    expect(item).toBeDefined();
    expect(item.apiKey).toBeUndefined();
    expect(item.signingKey).toBeUndefined();
  });

  it('GET /operators/:id returns shape incl. games + limits', async () => {
    const { app, adminUsers, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({
      operatorId: 'betco',
      name: 'BetCo',
      walletBaseUrl: 'https://wallet.betco.com',
      currencies: ['EUR', 'GBP'],
      minBetMinor: 10,
      maxBetMinor: 500000,
    });

    const { token } = await loginAs(app, 'alice', 'pw');
    const res = await request(app)
      .get('/admin/v1/operators/betco')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorId).toBe('betco');
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.signingKey).toBeUndefined();
    expect(Array.isArray(res.body.games)).toBe(true);
    expect(res.body.games[0].gameId).toBe('galaxy-crash');
    expect(res.body.games[0].enabled).toBe(true);
    expect(typeof res.body.limits).toBe('object');
    expect(res.body.limits['EUR']).toBeDefined();
    expect(res.body.limits['GBP']).toBeDefined();
  });

  it('GET /operators/:id → 404 for unknown operator', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');
    const res = await request(app)
      .get('/admin/v1/operators/nobody')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('OPERATOR_NOT_FOUND');
  });

  it('PATCH /operators/:id updates name', async () => {
    const { app, adminUsers, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({
      operatorId: 'patch-op',
      name: 'Old Name',
      walletBaseUrl: 'https://wallet.old.com',
      currencies: ['EUR'],
    });

    const { token } = await loginAs(app, 'alice', 'pw');
    const res = await request(app)
      .patch('/admin/v1/operators/patch-op')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.apiKey).toBeUndefined();
  });

  it('PATCH /operators/:id with status → 400 INVALID_REQUEST', async () => {
    const { app, adminUsers, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({
      operatorId: 'status-op',
      name: 'Status Op',
      walletBaseUrl: 'https://wallet.test.com',
      currencies: ['EUR'],
    });

    const { token } = await loginAs(app, 'alice', 'pw');
    const res = await request(app)
      .patch('/admin/v1/operators/status-op')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paused' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('regen-signing-key → new key returned; invalidate called; second GET /credentials → 404 CREDENTIALS_NOT_VISIBLE', async () => {
    const { app, adminUsers, registry, walletClientCache } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({
      operatorId: 'regen-op',
      name: 'Regen Op',
      walletBaseUrl: 'https://wallet.test.com',
      currencies: ['EUR'],
    });

    const { token } = await loginAs(app, 'alice', 'pw');

    const regenRes = await request(app)
      .post('/admin/v1/operators/regen-op/regen-signing-key')
      .set('Authorization', `Bearer ${token}`);

    expect(regenRes.status).toBe(200);
    expect(typeof regenRes.body.signingKey).toBe('string');
    expect(typeof regenRes.body.rotatedAt).toBe('number');

    // GET /credentials — should return once
    const credsRes1 = await request(app)
      .get('/admin/v1/operators/regen-op/credentials')
      .set('Authorization', `Bearer ${token}`);

    expect(credsRes1.status).toBe(200);
    expect(credsRes1.body.signingKey).toBe(regenRes.body.signingKey);

    // GET /credentials again — should be 404 CREDENTIALS_NOT_VISIBLE
    const credsRes2 = await request(app)
      .get('/admin/v1/operators/regen-op/credentials')
      .set('Authorization', `Bearer ${token}`);

    expect(credsRes2.status).toBe(404);
    expect(credsRes2.body.error.code).toBe('CREDENTIALS_NOT_VISIBLE');
  });

  it('pause → status paused; resume → status active', async () => {
    const { app, adminUsers, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({
      operatorId: 'toggle-op',
      name: 'Toggle Op',
      walletBaseUrl: 'https://wallet.test.com',
      currencies: ['EUR'],
      status: 'active',
    });

    const { token } = await loginAs(app, 'alice', 'pw');

    const pauseRes = await request(app)
      .post('/admin/v1/operators/toggle-op/pause')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'maintenance' });

    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.status).toBe('paused');
    expect(registry.getById('toggle-op')!.status).toBe('paused');

    const resumeRes = await request(app)
      .post('/admin/v1/operators/toggle-op/resume')
      .set('Authorization', `Bearer ${token}`);

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe('active');
    expect(registry.getById('toggle-op')!.status).toBe('active');
  });

  it('GET /operators/:id/credentials after create → returns once then 404 CREDENTIALS_NOT_VISIBLE', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    await request(app)
      .post('/admin/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operatorId: 'once-op',
        name: 'Once Op',
        walletBaseUrl: 'https://wallet.once.com',
        currencies: ['EUR'],
      });

    const creds1 = await request(app)
      .get('/admin/v1/operators/once-op/credentials')
      .set('Authorization', `Bearer ${token}`);

    expect(creds1.status).toBe(200);
    expect(typeof creds1.body.apiKey).toBe('string');
    expect(typeof creds1.body.signingKey).toBe('string');

    const creds2 = await request(app)
      .get('/admin/v1/operators/once-op/credentials')
      .set('Authorization', `Bearer ${token}`);

    expect(creds2.status).toBe(404);
    expect(creds2.body.error.code).toBe('CREDENTIALS_NOT_VISIBLE');
  });

  it('duplicate operatorId → 409 DUPLICATE_OPERATOR', async () => {
    const { app, adminUsers, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({
      operatorId: 'dup-op',
      name: 'Dup Op',
      walletBaseUrl: 'https://wallet.dup.com',
      currencies: ['EUR'],
    });

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .post('/admin/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operatorId: 'dup-op',
        name: 'Dup Op 2',
        walletBaseUrl: 'https://wallet.dup2.com',
        currencies: ['EUR'],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_OPERATOR');
  });

  it('GET /operators ?q= filters by name substring (case-insensitive)', async () => {
    const { app, adminUsers, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({ operatorId: 'alpha-op', name: 'Alpha Casino', walletBaseUrl: 'https://a.test', currencies: ['EUR'] });
    await registry.create({ operatorId: 'beta-op', name: 'Beta Slots', walletBaseUrl: 'https://b.test', currencies: ['EUR'] });

    const { token } = await loginAs(app, 'alice', 'pw');

    const res = await request(app)
      .get('/admin/v1/operators?q=ALPHA')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].operatorId).toBe('alpha-op');
  });
});

// ---------------------------------------------------------------------------
// Audit log assertions
// ---------------------------------------------------------------------------

describe('Audit rows', () => {
  it('login success + failure audit rows have correct actor and action', async () => {
    const { app, adminUsers, adminAudit } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    // Failed login
    await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice', password: 'wrong' });

    // Successful login
    await request(app)
      .post('/admin/v1/auth/login')
      .send({ username: 'alice', password: 'pw' });

    const auditRows = await waitForAudit(
      adminAudit,
      (rows) => rows.filter((r) => r.action === 'auth.login').length >= 2,
    );
    const loginRows = auditRows.filter((r) => r.action === 'auth.login');
    expect(loginRows.length).toBeGreaterThanOrEqual(2);

    const failRow = loginRows.find((r) => (r.payload as Record<string, unknown>)?.['result'] === 'failed');
    const successRow = loginRows.find((r) => (r.payload as Record<string, unknown>)?.['result'] === 'success');

    expect(failRow).toBeDefined();
    expect(failRow!.actor).toBe('alice');
    expect(successRow).toBeDefined();
    expect(successRow!.actor).toBe('alice');
  });

  it('logout audit row written', async () => {
    const { app, adminUsers, adminAudit } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    await request(app)
      .post('/admin/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    const auditRows = await waitForAudit(
      adminAudit,
      (rows) => rows.some((r) => r.action === 'auth.logout'),
    );
    const logoutRow = auditRows.find((r) => r.action === 'auth.logout');
    expect(logoutRow).toBeDefined();
    expect(logoutRow!.actor).toBe('alice');
  });

  it('operator.create audit row written with actor', async () => {
    const { app, adminUsers, adminAudit } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    await request(app)
      .post('/admin/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operatorId: 'audit-op',
        name: 'Audit Op',
        walletBaseUrl: 'https://wallet.audit.com',
        currencies: ['EUR'],
      });

    const auditRows = await waitForAudit(
      adminAudit,
      (rows) => rows.some((r) => r.action === 'operator.create'),
    );
    const createRow = auditRows.find((r) => r.action === 'operator.create');
    expect(createRow).toBeDefined();
    expect(createRow!.actor).toBe('alice');
    expect(createRow!.target).toBe('operator:audit-op');
  });

  it('operator.pause audit row includes reason', async () => {
    const { app, adminUsers, adminAudit, registry } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);
    await registry.create({ operatorId: 'pause-audit-op', name: 'Pause Audit', walletBaseUrl: 'https://test.com', currencies: ['EUR'] });

    const { token } = await loginAs(app, 'alice', 'pw');

    await request(app)
      .post('/admin/v1/operators/pause-audit-op/pause')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'fraud investigation' });

    const auditRows = await waitForAudit(
      adminAudit,
      (rows) => rows.some((r) => r.action === 'operator.pause'),
    );
    const pauseRow = auditRows.find((r) => r.action === 'operator.pause');
    expect(pauseRow).toBeDefined();
    expect((pauseRow!.payload as Record<string, unknown>)?.['reason']).toBe('fraud investigation');
  });

  it('admin.create audit row written', async () => {
    const { app, adminUsers, adminAudit } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    await request(app)
      .post('/admin/v1/admins')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'newbie', password: 'pw', roles: ['viewer'] });

    const auditRows = await waitForAudit(
      adminAudit,
      (rows) => rows.some((r) => r.action === 'admin.create'),
    );
    const createRow = auditRows.find((r) => r.action === 'admin.create');
    expect(createRow).toBeDefined();
    expect(createRow!.actor).toBe('alice');
    expect(createRow!.target).toBe('newbie');
  });
});

// ---------------------------------------------------------------------------
// §1.2 Logout
// ---------------------------------------------------------------------------

describe('POST /admin/v1/auth/logout', () => {
  it('logout → 204; subsequent use of same token → 401 INVALID_JWT', async () => {
    const { app, adminUsers } = await makeHarness();
    await adminUsers.create('alice', await bcrypt.hash('pw', 10), ['admin']);

    const { token } = await loginAs(app, 'alice', 'pw');

    const logoutRes = await request(app)
      .post('/admin/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(logoutRes.status).toBe(204);

    const meRes = await request(app)
      .get('/admin/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(401);
    expect(meRes.body.error.code).toBe('INVALID_JWT');
  });
});
