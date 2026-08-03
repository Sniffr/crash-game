/**
 * Integration tests for POST /admin/v1/bet-log/:betId/force-credit (Task 4.2 → 5.2).
 *
 * Migrated from X-Admin-Token to JWT (Task 5.2): setup creates an admin user,
 * calls POST /admin/v1/auth/login, and sends Authorization: Bearer <token>.
 *
 * Uses a real operator stub (startServer(0)), real PgOperatorRegistry + PgBetLog
 * (isolated Postgres schema), real WalletClientCache, PgAdminAudit + PgAdminUsers on the same pool.
 *
 * Mirror of operator-terminate.test.ts harness.
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
  recordWin: vi.fn(),
  recordLoss: vi.fn(),
  checkRateLimit: vi.fn(async () => true),
  refreshTtl: vi.fn(),
  setBalance: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Hub mock (transitively imported by bets.ts)
// ---------------------------------------------------------------------------

vi.mock('../ws/hub.js', () => ({
  sessionSockets: new Map(),
  sendToSession: vi.fn(),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock theme loader and game history (transitively imported)
// ---------------------------------------------------------------------------

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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import { PgBetLog, PgOperatorRegistry, PgGamesRepo, PgReconciler, WalletClient } from '@crash/wallet';
import type { Operator } from '@crash/wallet';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import type { Server } from 'node:http';
import * as bcrypt from 'bcryptjs';

import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import { WalletClientCache } from '../wallet/client-cache.js';
import { setOperatorWiringDeps } from '../game/operator-deps.js';
import { _internal__setCurrentRoundForTesting } from '../game/round.js';
import { createAdminRouter } from './admin.js';
import { PgAdminAudit, PgAdminUsers } from '../admin/admin-store-pg.js';

// Also import helpers to place/settle bets in tests
import { placeOperatorBet, cashOutOperatorBet } from '../game/bets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

const OPERATOR_A_ID = 'op-a';
const PLAYER_ID = 'pid-1';
const CURRENCY = 'EUR';
const INITIAL_BALANCE = 100_000;

const TEST_ADMIN_USER = 'tester';
const TEST_ADMIN_PASS = 'pw';
const TEST_JWT_SECRET = 'test-force-credit-secret';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let stubServer: Server;
let stubPort: number;

let testDb: TestDb;
let registry: PgOperatorRegistry;
let betLog: PgBetLog;
let adminAudit: PgAdminAudit;
let adminUsers: PgAdminUsers;
let walletClientCache: WalletClientCache;
let revoked: Set<string>;

// WalletClient instances (for placing bets in tests)
let goodClient: WalletClient;

// The express app under test
let testApp: express.Application;

// JWT token obtained at login
let authToken: string;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start operator stub on ephemeral port
  stubServer = startServer(0) as unknown as Server;
  await new Promise<void>((resolve) => stubServer.once('listening', resolve));
  const addr = stubServer.address();
  stubPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!stubPort) throw new Error('Could not determine stub port');

  // 2. Isolated Postgres schema: registry + betLog + adminAudit + adminUsers share the same pool
  testDb = await makeTestDb();
  betLog = new PgBetLog(testDb.pool);
  registry = new PgOperatorRegistry(testDb.pool);
  adminAudit = new PgAdminAudit(testDb.pool);
  adminUsers = new PgAdminUsers(testDb.pool);
  revoked = new Set<string>();

  // Register operator A — points at the real stub with stub's fixed signing key
  await registry.create({
    operatorId: OPERATOR_A_ID,
    name: 'Operator A',
    walletBaseUrl: `http://localhost:${stubPort}`,
    currencies: [CURRENCY],
    status: 'active',
  });
  await testDb.pool.query(
    `UPDATE operators SET signing_key_b64 = $1 WHERE operator_id = $2`,
    [STUB_DEFAULT_KEY_B64, OPERATOR_A_ID],
  );
  // The signing key was patched out-of-band; refresh the in-memory cache so the
  // registry (and any WalletClient built from it) uses the stub's key.
  await registry.refresh();

  // 3. Build WalletClientCache + wire DI seam
  walletClientCache = new WalletClientCache(registry, betLog);
  setOperatorWiringDeps({ walletClientCache, betLog });

  // Build a WalletClient for placing/settling bets in tests (fast no-op sleep)
  const opA = registry.getById(OPERATOR_A_ID)!;
  const operatorConfig: Operator = {
    operatorId: OPERATOR_A_ID,
    name: 'Operator A',
    walletBaseUrl: `http://localhost:${stubPort}`,
    apiKey: opA.apiKey,
    signingKey: Buffer.from(STUB_DEFAULT_KEY_B64, 'base64'),
    adapter: 'native',
    currencies: [CURRENCY],
    minBetMinor: 1,
    maxBetMinor: 10_000_000,
    rtpVariant: 97,
    jurisdictions: [],
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };

  goodClient = new WalletClient(operatorConfig, {
    betLog,
    sleep: async () => {},  // instant backoff
  });

  // 4. Create admin user for JWT login
  await adminUsers.create(TEST_ADMIN_USER, await bcrypt.hash(TEST_ADMIN_PASS, 10), ['admin']);

  // 5. Build the test express app with admin routes (JWT-based)
  const games = new PgGamesRepo(testDb.pool);
  const reconciler = new PgReconciler(testDb.pool, { source: async () => [], betLog });
  testApp = express();
  testApp.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  testApp.use(
    '/admin/v1',
    createAdminRouter({ walletClientCache, betLog, adminAudit, adminUsers, registry, games, revoked, reconciler }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    stubServer.close((err) => (err ? reject(err) : resolve())),
  );
  await testDb.cleanup();
});

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let savedJwtSecret: string | undefined;

beforeEach(async () => {
  resetStubState();
  vi.clearAllMocks();
  _internal__setCurrentRoundForTesting(null);
  setOperatorWiringDeps({ walletClientCache, betLog });

  // Save and set JWT_SECRET
  savedJwtSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = TEST_JWT_SECRET;

  // Clear revocation set
  revoked.clear();

  // Clear admin_audit rows so each test sees an isolated audit trail
  await testDb.pool.query('DELETE FROM admin_audit');

  // Obtain a fresh JWT token by logging in
  const loginRes = await request(testApp)
    .post('/admin/v1/auth/login')
    .set('Content-Type', 'application/json')
    .send({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PASS });

  authToken = (loginRes.body as { token: string }).token;
});

afterEach(() => {
  // Restore JWT_SECRET
  if (savedJwtSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = savedJwtSecret;
  }
  // Clear STUB_FAIL_NEXT_WIN in case a test left it set
  delete process.env['STUB_FAIL_NEXT_WIN'];
  resetStubState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

function forceCreditPath(betId: string) {
  return `/admin/v1/bet-log/${betId}/force-credit`;
}

/**
 * Poll adminAudit.list() until `predicate` holds. Admin audit `.record()` is
 * fire-and-forget (the handler returns before the INSERT commits), so under
 * concurrent Postgres load the row may not be visible the instant the HTTP
 * response arrives. This bounded poll makes audit assertions deterministic.
 */
async function listAuditUntil(
  predicate: (rows: Awaited<ReturnType<typeof adminAudit.list>>) => boolean,
): Promise<Awaited<ReturnType<typeof adminAudit.list>>> {
  let rows = await adminAudit.list({ limit: 100 });
  for (let i = 0; i < 50 && !predicate(rows); i++) {
    await new Promise((r) => setTimeout(r, 20));
    rows = await adminAudit.list({ limit: 100 });
  }
  return rows;
}

/** Authenticated admin request with valid JWT. */
function adminRequest(betId: string, body: object = { reason: 'test-force-credit' }) {
  return request(testApp)
    .post(forceCreditPath(betId))
    .set('Authorization', `Bearer ${authToken}`)
    .set('Content-Type', 'application/json')
    .send(body);
}

/**
 * Place a bet and immediately drive it to WIN_FAILED using a failing /win client.
 * Returns the betId of the WIN_FAILED row.
 */
async function induceWinFailed(opts: {
  betId?: string;
  betTxnId?: string;
  playerId?: string;
  sessionId?: string;
  roundId?: string;
  amountMinor?: number;
  multiplier?: number;
  currency?: string;
}): Promise<string> {
  const betId = opts.betId ?? uid('bet');
  const betTxnId = opts.betTxnId ?? uid('btxn');
  const winTxnId = uid('wtxn');
  const playerId = opts.playerId ?? PLAYER_ID;
  const sessionId = opts.sessionId ?? `sess-${playerId}`;
  const roundId = opts.roundId ?? uid('round');
  const amountMinor = opts.amountMinor ?? 5_000;
  const multiplier = opts.multiplier ?? 2.0;
  const currency = opts.currency ?? CURRENCY;
  const winAmountMinor = Math.round(amountMinor * multiplier);

  // Place bet against the real stub → ARMED
  const placeResult = await placeOperatorBet(
    { walletClient: goodClient, betLog },
    {
      operatorId: OPERATOR_A_ID,
      playerId,
      sessionId,
      roundId,
      currency,
      amountMinor,
      betId,
      betTxnId,
      gameId: 'galaxy-crash',
    },
  );
  if (placeResult.row.state !== 'ARMED') {
    throw new Error(`Expected ARMED, got ${placeResult.row.state}`);
  }

  // Build a WalletClient whose fetch always rejects — simulates exhausted retries
  const alwaysThrowFetch: typeof fetch = async () => {
    throw new Error('econnrefused');
  };
  const opA = registry.getById(OPERATOR_A_ID)!;
  const failingClient = new WalletClient(
    {
      operatorId: OPERATOR_A_ID,
      name: 'Operator A',
      walletBaseUrl: `http://localhost:${stubPort}`,
      apiKey: opA.apiKey,
      signingKey: Buffer.from(STUB_DEFAULT_KEY_B64, 'base64'),
      adapter: 'native',
      currencies: [CURRENCY],
      minBetMinor: 1,
      maxBetMinor: 10_000_000,
      rtpVariant: 97,
      jurisdictions: [],
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    },
    { fetchImpl: alwaysThrowFetch, sleep: async () => {} },
  );

  // Drive cashout → WIN_FAILED (will throw — that's expected)
  try {
    await cashOutOperatorBet(
      { walletClient: failingClient, betLog },
      { betId, winTxnId, multiplier, winAmountMinor, settledAt: Math.floor(Date.now() / 1000) },
    );
  } catch {
    // expected — cashOut exhausted retries
  }

  // Confirm WIN_FAILED state
  const row = await betLog.getById(betId);
  if (row?.state !== 'WIN_FAILED') {
    throw new Error(`Expected WIN_FAILED, got ${row?.state}`);
  }
  if (row.winTxnId == null || row.winAmountMinor == null || row.multiplier == null) {
    throw new Error(`WIN_FAILED row missing reconstructible fields: ${JSON.stringify(row)}`);
  }

  return betId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /admin/v1/bet-log/:betId/force-credit', () => {

  // ─── Test 1: JWT_SECRET unset → 503 ADMIN_DISABLED ──────────────────────────

  it('JWT_SECRET unset → any force-credit request → 503 ADMIN_DISABLED', async () => {
    delete process.env['JWT_SECRET'];

    const res = await request(testApp)
      .post(forceCreditPath('any-bet-id'))
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'application/json')
      .send({ reason: 'test' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ADMIN_DISABLED');
  });

  // ─── Test 2: missing/array Authorization → 401 INVALID_JWT ──────────────────

  it('missing Authorization header → 401 INVALID_JWT', async () => {
    const res = await request(testApp)
      .post(forceCreditPath('any-bet-id'))
      .set('Content-Type', 'application/json')
      .send({ reason: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JWT');
  });

  it('array Authorization header → 401 INVALID_JWT', async () => {
    // Test the typeof !== 'string' guard in requireAdminJwt directly
    const { requireAdminJwt: rawMw } = await import('./middleware/admin-auth.js');
    const mw = rawMw({ revoked });
    let statusCode = 0;
    let jsonBody: unknown = undefined;
    let nextCalled = false;

    const fakeReq = {
      headers: { 'authorization': [authToken] },  // string[] — the typeof guard branch
    } as unknown as import('express').Request;

    const fakeRes = {
      headersSent: false,
      status(code: number) { statusCode = code; return fakeRes; },
      json(body: unknown) { jsonBody = body; return fakeRes; },
    } as unknown as import('express').Response;

    await new Promise<void>((resolve) => {
      void mw(fakeReq, fakeRes, () => { nextCalled = true; resolve(); });
      if (!nextCalled) setTimeout(resolve, 100);
    });

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(401);
    expect((jsonBody as { error: { code: string } }).error.code).toBe('INVALID_JWT');
  });

  // ─── Test 3: valid token, missing/blank reason → 400 INVALID_REQUEST ─────────

  it('valid token, missing reason → 400 INVALID_REQUEST (no audit row)', async () => {
    const res = await adminRequest('any-bet-id', {});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');

    // No audit row for a pre-validation 400 (design choice documented in handler)
    const auditRows = await adminAudit.list({ limit: 100 });
    // May have login audit rows — filter for force_credit only
    const forceCreditRows = auditRows.filter((r) => r.action === 'force_credit');
    expect(forceCreditRows).toHaveLength(0);
  });

  it('valid token, blank reason string → 400 INVALID_REQUEST', async () => {
    const res = await adminRequest('any-bet-id', { reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  // ─── Test 4: unknown betId → 404 BET_NOT_FOUND + audit row ─────────────────

  it('unknown betId → 404 BET_NOT_FOUND + admin_audit row (result not_found)', async () => {
    const betId = 'does-not-exist-' + uid('x');
    // Clear audit rows before this specific test to isolate force_credit rows
    await testDb.pool.query('DELETE FROM admin_audit');
    const res = await adminRequest(betId, { reason: 'checking if it exists' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BET_NOT_FOUND');

    const auditRows = await listAuditUntil((rows) => rows.some((r) => r.action === 'force_credit'));
    const forceCreditRows = auditRows.filter((r) => r.action === 'force_credit');
    expect(forceCreditRows).toHaveLength(1);
    const auditRow = forceCreditRows[0]!;
    expect(auditRow.action).toBe('force_credit');
    expect(auditRow.target).toBe(betId);
    expect((auditRow.payload as Record<string, unknown>)['result']).toBe('not_found');
  });

  // ─── Test 5: non-WIN_FAILED state → 409 BET_NOT_WIN_FAILED + audit row ──────

  it('bet in ARMED state → 409 BET_NOT_WIN_FAILED + audit row (result rejected_state)', async () => {
    const betId = uid('bet');
    const betTxnId = uid('btxn');

    // Place a bet → ARMED state
    await placeOperatorBet(
      { walletClient: goodClient, betLog },
      {
        operatorId: OPERATOR_A_ID,
        playerId: PLAYER_ID,
        sessionId: `sess-${PLAYER_ID}`,
        roundId: uid('round'),
        currency: CURRENCY,
        amountMinor: 5_000,
        betId,
        betTxnId,
        gameId: 'galaxy-crash',
      },
    );
    expect((await betLog.getById(betId))?.state).toBe('ARMED');

    await testDb.pool.query('DELETE FROM admin_audit');
    const res = await adminRequest(betId, { reason: 'trying to force-credit an ARMED bet' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BET_NOT_WIN_FAILED');

    const auditRows = await listAuditUntil((rows) => rows.some((r) => r.action === 'force_credit'));
    const forceCreditRows = auditRows.filter((r) => r.action === 'force_credit');
    expect(forceCreditRows).toHaveLength(1);
    const auditRow = forceCreditRows[0]!;
    expect(auditRow.action).toBe('force_credit');
    expect(auditRow.target).toBe(betId);
    const payload = auditRow.payload as Record<string, unknown>;
    expect(payload['result']).toBe('rejected_state');
    expect(payload['state']).toBe('ARMED');
  });

  // ─── Test 6: HAPPY PATH — WIN_FAILED → force-credit → 200 SETTLED ───────────

  it('HAPPY: WIN_FAILED bet with healthy stub → 200 ok:true state SETTLED; betLog SETTLED; exactly one audit row result settled with operatorTxnId', async () => {
    // Induce a WIN_FAILED row (place bet, fail /win, reach WIN_FAILED)
    const betId = await induceWinFailed({ playerId: PLAYER_ID });
    expect((await betLog.getById(betId))?.state).toBe('WIN_FAILED');

    await testDb.pool.query('DELETE FROM admin_audit');
    // The stub is now healthy (default state) — force-credit should succeed
    const res = await adminRequest(betId, { reason: 'ops manual recovery - operator back online' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.betId).toBe(betId);
    expect(res.body.state).toBe('SETTLED');
    expect(typeof res.body.operatorTxnId).toBe('string');
    expect(res.body.operatorTxnId).toBeTruthy();

    // BetLog must show SETTLED
    expect((await betLog.getById(betId))?.state).toBe('SETTLED');

    // Exactly one force_credit audit row
    const auditRows = await listAuditUntil((rows) => rows.some((r) => r.action === 'force_credit'));
    const forceCreditRows = auditRows.filter((r) => r.action === 'force_credit');
    expect(forceCreditRows).toHaveLength(1);
    const auditRow = forceCreditRows[0]!;
    expect(auditRow.action).toBe('force_credit');
    expect(auditRow.target).toBe(betId);
    // actor must be the JWT subject (not 'admin-token')
    expect(auditRow.actor).toBe(TEST_ADMIN_USER);
    const payload = auditRow.payload as Record<string, unknown>;
    expect(payload['result']).toBe('settled');
    expect(typeof payload['operatorTxnId']).toBe('string');
    expect(payload['operatorTxnId']).toBeTruthy();
    expect(typeof payload['balanceMinor']).toBe('number');
  });

  // ─── Test 7: operator STILL failing → 502 ok:false state WIN_FAILED ─────────

  it('operator still failing (idempotency-recorded WalletError): force-credit → 502 ok:false state WIN_FAILED; row stays WIN_FAILED; audit row result failed', async () => {
    const betId = uid('bet');
    const betTxnId = uid('btxn');
    const winTxnId = uid('wtxn');

    // Step 1: Place bet → ARMED (real stub, pid-1 EUR)
    const placeResult = await placeOperatorBet(
      { walletClient: goodClient, betLog },
      {
        operatorId: OPERATOR_A_ID,
        playerId: PLAYER_ID,
        sessionId: `sess-${PLAYER_ID}`,
        roundId: uid('round'),
        currency: CURRENCY,
        amountMinor: 5_000,
        betId,
        betTxnId,
        gameId: 'galaxy-crash',
      },
    );
    expect(placeResult.row.state).toBe('ARMED');

    // Step 2: Compute fingerprint and insert a confirmed-rejection idempotency row
    const row = (await betLog.getById(betId))!;
    const winReqStableFields = {
      playerId: row.playerId,
      sessionId: row.sessionId,
      roundId: row.roundId,
      betId: row.betId,
      betTxnId: row.betTxnId,
      txnId: winTxnId,
      amountMinor: 10_000,   // winAmountMinor = 5000 * 2.0
      multiplier: 2.0,
      currency: row.currency,
      // settledAt is EXCLUDED from fingerprint (volatile key)
    };
    const requestHash = crypto
      .createHash('sha256')
      .update(Buffer.from(JSON.stringify(winReqStableFields)))
      .digest('hex');

    const errorPayload = JSON.stringify({
      ok: false,
      error: {
        code: 'BET_LIMIT_EXCEEDED',
        message: 'Win amount exceeds operator limit',
        httpStatus: 409,
        retryable: false,
        balanceMinor: undefined,
      },
    });
    await betLog.putIdempotency({
      txnId: winTxnId,
      operatorId: OPERATOR_A_ID,
      kind: 'win',
      requestHash,
      responseJson: errorPayload,
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Step 3: Transition betLog row to SETTLING → WIN_FAILED with the winTxnId
    await betLog.transition(betId, 'cashout_requested', {
      winTxnId,
      multiplier: 2.0,
      winAmountMinor: 10_000,
    });
    await betLog.transition(betId, 'win_failed', { errorCode: 'BET_LIMIT_EXCEEDED' });
    expect((await betLog.getById(betId))?.state).toBe('WIN_FAILED');

    await testDb.pool.query('DELETE FROM admin_audit');
    // Step 4 & 5: Force-credit — WalletClient finds the idempotency entry and
    // replays the WalletError immediately (no HTTP call → no timeout).
    const res = await adminRequest(betId, { reason: 'operator BET_LIMIT_EXCEEDED — still refusing' });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.betId).toBe(betId);
    expect(res.body.state).toBe('WIN_FAILED');
    expect(res.body.error).toBeTruthy();

    // Row must still be WIN_FAILED
    expect((await betLog.getById(betId))?.state).toBe('WIN_FAILED');

    // Audit row with result 'failed'
    const auditRows = await listAuditUntil((rows) => rows.some((r) => r.action === 'force_credit'));
    const forceCreditRows = auditRows.filter((r) => r.action === 'force_credit');
    expect(forceCreditRows).toHaveLength(1);
    const failedAuditRow = forceCreditRows[0]!;
    expect(failedAuditRow.action).toBe('force_credit');
    expect(failedAuditRow.target).toBe(betId);
    const payload = failedAuditRow.payload as Record<string, unknown>;
    expect(payload['result']).toBe('failed');
    expect(payload['error']).toBeTruthy();
  });

  // ─── Test 8: operator unavailable (paused/unknown) → 503 OPERATOR_UNAVAILABLE ─

  it('operator paused: WIN_FAILED row whose operator is paused → 503 OPERATOR_UNAVAILABLE; row stays WIN_FAILED; audit result operator_unavailable', async () => {
    // Register a third operator and create a WIN_FAILED row for it
    const OP_C_ID = 'op-c-paused';
    try {
      await registry.create({
        operatorId: OP_C_ID,
        name: 'Operator C (paused)',
        walletBaseUrl: `http://localhost:${stubPort}`,
        currencies: [CURRENCY],
        status: 'active',
      });
      await testDb.pool.query(
        `UPDATE operators SET signing_key_b64 = $1 WHERE operator_id = $2`,
        [STUB_DEFAULT_KEY_B64, OP_C_ID],
      );
      // Reflect the out-of-band signing-key patch in the in-memory cache.
      await registry.refresh();
    } catch {
      // may already exist
    }

    // Create a WIN_FAILED row for op-c
    const betId = uid('bet');
    const betTxnId = uid('btxn');
    const winTxnId = uid('wtxn');
    await betLog.create({
      betId,
      operatorId: OP_C_ID,
      playerId: 'pid-1',
      sessionId: 'sess-pid-1',
      roundId: uid('round'),
      currency: CURRENCY,
      amountMinor: 5_000,
      betTxnId,
    });
    await betLog.transition(betId, 'bet_accepted', { betOpTxnId: 'fake-op-txn-c' });
    await betLog.transition(betId, 'cashout_requested', {
      winTxnId,
      multiplier: 2.0,
      winAmountMinor: 10_000,
    });
    await betLog.transition(betId, 'win_failed', { errorCode: 'UPSTREAM_ERROR' });

    expect((await betLog.getById(betId))?.state).toBe('WIN_FAILED');

    // Pause the operator — walletClientCache.get() returns null
    await testDb.pool.query(`UPDATE operators SET status = 'paused' WHERE operator_id = $1`, [OP_C_ID]);
    // Refresh the registry cache + invalidate the client cache so the paused status is picked up
    await registry.refresh();
    walletClientCache.invalidate(OP_C_ID);

    const res = await adminRequest(betId, { reason: 'operator paused, testing unavailable path' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OPERATOR_UNAVAILABLE');

    // Row stays WIN_FAILED
    expect((await betLog.getById(betId))?.state).toBe('WIN_FAILED');

    // Audit row with result operator_unavailable
    const auditRows = await listAuditUntil((rows) =>
      rows.some(
        (r) => r.target === betId &&
          (r.payload as Record<string, unknown>)['result'] === 'operator_unavailable',
      ),
    );
    const unavailableRow = auditRows.find(
      (r) => r.target === betId &&
        (r.payload as Record<string, unknown>)['result'] === 'operator_unavailable',
    );
    expect(unavailableRow).toBeDefined();

    // Restore operator to active for other tests
    await testDb.pool.query(`UPDATE operators SET status = 'active' WHERE operator_id = $1`, [OP_C_ID]);
    await registry.refresh();
    walletClientCache.invalidate(OP_C_ID);
  });
});
