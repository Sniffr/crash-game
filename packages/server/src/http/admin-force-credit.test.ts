/**
 * Integration tests for POST /admin/v1/bet-log/:betId/force-credit (Task 4.2).
 *
 * Tests the full middleware+handler stack:
 *   requireAdminToken → createAdminRouter → handler
 *
 * Uses a real operator stub (startServer(0)), real OperatorRegistry + BetLog
 * (:memory: SQLite), real WalletClientCache, AdminAudit on the same `:memory:` db.
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
import Database from 'better-sqlite3';
import { BetLog, OperatorRegistry, WalletClient } from '@crash/wallet';
import type { Operator } from '@crash/wallet';
import type { Server } from 'node:http';

import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import { WalletClientCache } from '../wallet/client-cache.js';
import { setOperatorWiringDeps } from '../game/operator-deps.js';
import { _internal__setCurrentRoundForTesting } from '../game/round.js';
import { requireAdminToken } from './middleware/require-admin-token.js';
import { createAdminRouter } from './admin.js';
import { AdminAudit } from '../admin/admin-store.js';

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

const VALID_TOKEN = 'test-admin-secret-token';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let stubServer: Server;
let stubPort: number;

let db: InstanceType<typeof Database>;
let registry: OperatorRegistry;
let betLog: BetLog;
let adminAudit: AdminAudit;
let walletClientCache: WalletClientCache;

// WalletClient instances (for placing bets in tests)
let goodClient: WalletClient;

// The express app under test
let testApp: express.Application;

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

  // 2. In-memory SQLite: registry + betLog + adminAudit share the same db
  db = new Database(':memory:');
  betLog = new BetLog(db);
  registry = new OperatorRegistry(db);
  adminAudit = new AdminAudit(db);

  // Register operator A — points at the real stub with stub's fixed signing key
  registry.create({
    operatorId: OPERATOR_A_ID,
    name: 'Operator A',
    walletBaseUrl: `http://localhost:${stubPort}`,
    currencies: [CURRENCY],
    status: 'active',
  });
  db.prepare(`UPDATE operators SET signing_key_b64 = ? WHERE operator_id = ?`).run(
    STUB_DEFAULT_KEY_B64,
    OPERATOR_A_ID,
  );

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

  // 4. Build the test express app with admin routes
  testApp = express();
  testApp.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  testApp.use(
    '/admin/v1',
    requireAdminToken(),
    createAdminRouter({ walletClientCache, betLog, adminAudit }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    stubServer.close((err) => (err ? reject(err) : resolve())),
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let savedToken: string | undefined;

beforeEach(() => {
  resetStubState();
  vi.clearAllMocks();
  _internal__setCurrentRoundForTesting(null);
  setOperatorWiringDeps({ walletClientCache, betLog });
  // Save env token and set a default valid token
  savedToken = process.env['ADMIN_API_TOKEN'];
  process.env['ADMIN_API_TOKEN'] = VALID_TOKEN;
  // Clear admin_audit rows so each test sees an isolated audit trail
  db.exec('DELETE FROM admin_audit');
});

afterEach(() => {
  // Restore env token
  if (savedToken === undefined) {
    delete process.env['ADMIN_API_TOKEN'];
  } else {
    process.env['ADMIN_API_TOKEN'] = savedToken;
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

/** Authenticated admin request with valid token. */
function adminRequest(betId: string, body: object = { reason: 'test-force-credit' }) {
  return request(testApp)
    .post(forceCreditPath(betId))
    .set('X-Admin-Token', VALID_TOKEN)
    .set('Content-Type', 'application/json')
    .send(body);
}

/**
 * Place a bet and immediately drive it to WIN_FAILED using a failing /win client.
 * Returns the betId of the WIN_FAILED row.
 *
 * Method: place against the real stub (ARMED), then call cashOutOperatorBet with
 * a client whose fetch always throws — exhausts retries → WIN_FAILED with
 * winTxnId/winAmountMinor/multiplier persisted at SETTLING (Phase 1.6).
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
  const row = betLog.getById(betId);
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

  // ─── Test 1: ADMIN_API_TOKEN unset → 503 ADMIN_DISABLED ─────────────────────

  it('ADMIN_API_TOKEN unset → any force-credit request → 503 ADMIN_DISABLED', async () => {
    delete process.env['ADMIN_API_TOKEN'];

    const res = await request(testApp)
      .post(forceCreditPath('any-bet-id'))
      .set('X-Admin-Token', VALID_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ reason: 'test' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ADMIN_DISABLED');
  });

  // ─── Test 2: missing/wrong token → 401 INVALID_ADMIN_TOKEN ──────────────────

  it('missing X-Admin-Token header → 401 INVALID_ADMIN_TOKEN', async () => {
    const res = await request(testApp)
      .post(forceCreditPath('any-bet-id'))
      .set('Content-Type', 'application/json')
      .send({ reason: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_ADMIN_TOKEN');
  });

  it('wrong X-Admin-Token → 401 INVALID_ADMIN_TOKEN', async () => {
    const res = await request(testApp)
      .post(forceCreditPath('any-bet-id'))
      .set('X-Admin-Token', 'wrong-token-value')
      .set('Content-Type', 'application/json')
      .send({ reason: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_ADMIN_TOKEN');
  });

  // ─── Test 3: valid token, missing/blank reason → 400 INVALID_REQUEST ─────────

  it('valid token, missing reason → 400 INVALID_REQUEST (no audit row)', async () => {
    const res = await adminRequest('any-bet-id', {});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');

    // No audit row for a pre-validation 400 (design choice documented in handler)
    const auditRows = adminAudit.list({ limit: 100 });
    expect(auditRows).toHaveLength(0);
  });

  it('valid token, blank reason string → 400 INVALID_REQUEST', async () => {
    const res = await adminRequest('any-bet-id', { reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  // ─── Test 4: unknown betId → 404 BET_NOT_FOUND + audit row ─────────────────

  it('unknown betId → 404 BET_NOT_FOUND + admin_audit row (result not_found)', async () => {
    const betId = 'does-not-exist-' + uid('x');
    const res = await adminRequest(betId, { reason: 'checking if it exists' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BET_NOT_FOUND');

    const auditRows = adminAudit.list({ limit: 100 });
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0]!;
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
    expect(betLog.getById(betId)?.state).toBe('ARMED');

    const res = await adminRequest(betId, { reason: 'trying to force-credit an ARMED bet' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BET_NOT_WIN_FAILED');

    const auditRows = adminAudit.list({ limit: 100 });
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0]!;
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
    expect(betLog.getById(betId)?.state).toBe('WIN_FAILED');

    // The stub is now healthy (default state) — force-credit should succeed
    const res = await adminRequest(betId, { reason: 'ops manual recovery - operator back online' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.betId).toBe(betId);
    expect(res.body.state).toBe('SETTLED');
    expect(typeof res.body.operatorTxnId).toBe('string');
    expect(res.body.operatorTxnId).toBeTruthy();

    // BetLog must show SETTLED
    expect(betLog.getById(betId)?.state).toBe('SETTLED');

    // Exactly one audit row
    const auditRows = adminAudit.list({ limit: 100 });
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0]!;
    expect(auditRow.action).toBe('force_credit');
    expect(auditRow.target).toBe(betId);
    const payload = auditRow.payload as Record<string, unknown>;
    expect(payload['result']).toBe('settled');
    expect(typeof payload['operatorTxnId']).toBe('string');
    expect(payload['operatorTxnId']).toBeTruthy();
    expect(typeof payload['balanceMinor']).toBe('number');
  });

  // ─── Test 7: operator STILL failing → 502 ok:false state WIN_FAILED ─────────
  //
  // Strategy: use Phase 2.2 outbound idempotency to make client.win() short-circuit
  // to a stored WalletError without any HTTP calls.
  //
  // Mechanics:
  //   1. Place a bet → ARMED (real stub).
  //   2. Manually record a confirmed 4xx WalletError in the txn_idempotency table
  //      for the winTxnId (simulates a prior /win call that got INSUFFICIENT_FUNDS).
  //   3. Manually transition the betLog row to SETTLING → WIN_FAILED with the same winTxnId.
  //   4. Force-credit: WalletClient.withIdempotency() finds the existing idempotency
  //      entry, replays the stored WalletError immediately (no HTTP call, no timeout).
  //   5. Handler gets WalletError → 502; row stays WIN_FAILED; audit result 'failed'.

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

    // Step 2: Record a confirmed 4xx WalletError in txn_idempotency for the winTxnId.
    //
    // The fingerprint must match the request that force-credit will build.
    // WalletClient.withIdempotency uses idempotencyFingerprint which strips settledAt
    // (volatile). The stable fields are: playerId, sessionId, roundId, betId, betTxnId,
    // txnId, amountMinor, multiplier, currency.
    //
    // We record the error directly in the table, bypassing the WalletClient.
    // The WalletClient.withIdempotency() will find this entry and short-circuit.
    //
    // Note: the fingerprint function is internal to @crash/wallet. We need the
    // request payload hash. Since we can't call it directly, we store a "wrong"
    // hash... BUT the idempotency lookup checks requestHash for equality.
    // If the hash mismatches, it throws IdempotencyMismatchError, not WalletError.
    //
    // To avoid computing the fingerprint, we use a different approach:
    // Place the bet with the failing client (induceWinFailed style) to naturally
    // record the WalletNetworkError in the idempotency table... but WalletNetworkError
    // is NOT persisted (only 4xx confirmed rejections are).
    //
    // Real solution: compute the fingerprint manually for the WinRequest that
    // force-credit will build, and insert the error row with that hash.
    // The fingerprint is SHA256(JSON.stringify(payload_without_volatile_keys)).
    const row = betLog.getById(betId)!;
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

    // Insert a confirmed-rejection idempotency row for this winTxnId
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
    betLog.putIdempotency({
      txnId: winTxnId,
      operatorId: OPERATOR_A_ID,
      kind: 'win',
      requestHash,
      responseJson: errorPayload,
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Step 3: Transition betLog row to SETTLING → WIN_FAILED with the winTxnId
    betLog.transition(betId, 'cashout_requested', {
      winTxnId,
      multiplier: 2.0,
      winAmountMinor: 10_000,
    });
    betLog.transition(betId, 'win_failed', { errorCode: 'BET_LIMIT_EXCEEDED' });
    expect(betLog.getById(betId)?.state).toBe('WIN_FAILED');

    // Step 4 & 5: Force-credit — WalletClient finds the idempotency entry and
    // replays the WalletError immediately (no HTTP call → no timeout).
    const res = await adminRequest(betId, { reason: 'operator BET_LIMIT_EXCEEDED — still refusing' });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.betId).toBe(betId);
    expect(res.body.state).toBe('WIN_FAILED');
    expect(res.body.error).toBeTruthy();

    // Row must still be WIN_FAILED
    expect(betLog.getById(betId)?.state).toBe('WIN_FAILED');

    // Audit row with result 'failed'
    const auditRows = adminAudit.list({ limit: 100 });
    expect(auditRows).toHaveLength(1);
    const failedAuditRow = auditRows[0]!;
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
      registry.create({
        operatorId: OP_C_ID,
        name: 'Operator C (paused)',
        walletBaseUrl: `http://localhost:${stubPort}`,
        currencies: [CURRENCY],
        status: 'active',
      });
      db.prepare(`UPDATE operators SET signing_key_b64 = ? WHERE operator_id = ?`).run(
        STUB_DEFAULT_KEY_B64,
        OP_C_ID,
      );
    } catch {
      // may already exist
    }

    // Create a WIN_FAILED row for op-c
    const betId = uid('bet');
    const betTxnId = uid('btxn');
    const winTxnId = uid('wtxn');
    betLog.create({
      betId,
      operatorId: OP_C_ID,
      playerId: 'pid-1',
      sessionId: 'sess-pid-1',
      roundId: uid('round'),
      currency: CURRENCY,
      amountMinor: 5_000,
      betTxnId,
    });
    betLog.transition(betId, 'bet_accepted', { betOpTxnId: 'fake-op-txn-c' });
    betLog.transition(betId, 'cashout_requested', {
      winTxnId,
      multiplier: 2.0,
      winAmountMinor: 10_000,
    });
    betLog.transition(betId, 'win_failed', { errorCode: 'UPSTREAM_ERROR' });

    expect(betLog.getById(betId)?.state).toBe('WIN_FAILED');

    // Pause the operator — walletClientCache.get() returns null
    db.prepare(`UPDATE operators SET status = 'paused' WHERE operator_id = ?`).run(OP_C_ID);
    // Invalidate cache so the paused status is picked up
    walletClientCache.invalidate(OP_C_ID);

    const res = await adminRequest(betId, { reason: 'operator paused, testing unavailable path' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OPERATOR_UNAVAILABLE');

    // Row stays WIN_FAILED
    expect(betLog.getById(betId)?.state).toBe('WIN_FAILED');

    // Audit row with result operator_unavailable
    const auditRows = adminAudit.list({ limit: 100 });
    const unavailableRow = auditRows.find(
      (r) => r.target === betId &&
        (r.payload as Record<string, unknown>)['result'] === 'operator_unavailable',
    );
    expect(unavailableRow).toBeDefined();

    // Restore operator to active for other tests
    db.prepare(`UPDATE operators SET status = 'active' WHERE operator_id = ?`).run(OP_C_ID);
    walletClientCache.invalidate(OP_C_ID);
  });
});
