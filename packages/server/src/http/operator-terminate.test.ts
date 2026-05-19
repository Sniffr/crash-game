/**
 * Integration tests for POST /op/v1/sessions/:sessionId/terminate (Task 3.3).
 *
 * Tests the full middleware+handler stack:
 *   verifyOperatorSignature → createOperatorRouter → handler
 *
 * Uses a real operator stub (startServer(0)), real OperatorRegistry + BetLog
 * (:memory: SQLite), real WalletClientCache. Store (RocksDB) is mocked.
 * WS hub is partially mocked (sendToSession spied; sessionSockets is the real
 * exported Map, populated manually per test).
 *
 * Request signing mirrors tools/operator-stub/src/index.test.ts signedHeaders().
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Store mock — must be hoisted BEFORE any imports that pull in store.ts
// ---------------------------------------------------------------------------

const sessionStore = new Map<string, Record<string, unknown>>();

vi.mock('../store.js', () => ({
  DEFAULT_DEMO_BALANCE: 1000,
  StoreOfflineError: class StoreOfflineError extends Error {
    constructor() { super('session store offline'); }
  },
  isOnline: vi.fn(() => true),
  getSession: vi.fn(async (sessionId: string) => {
    return sessionStore.get(sessionId) ?? null;
  }),
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
// Hub: spy on sendToSession but use the REAL sessionSockets Map
// ---------------------------------------------------------------------------

vi.mock('../ws/hub.js', () => {
  // We want sessionSockets to be a real Map we can mutate per test
  const sessionSockets = new Map<string, Set<import('ws').WebSocket>>();
  const sendToSession = vi.fn();
  const broadcast = vi.fn();
  const safeSend = vi.fn();
  return { sessionSockets, sendToSession, broadcast, safeSend };
});

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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { BetLog, OperatorRegistry } from '@crash/wallet';
import type { Server } from 'node:http';
import type { WebSocket } from 'ws';

import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import { WalletClientCache } from '../wallet/client-cache.js';
import { setOperatorWiringDeps } from '../game/operator-deps.js';
import { _internal__setCurrentRoundForTesting } from '../game/round.js';
import { verifyOperatorSignature } from './middleware/verify-operator-signature.js';
import { createOperatorRouter } from './operator.js';

import { sessionSockets, sendToSession } from '../ws/hub.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

const OPERATOR_A_ID = 'op-a';
const OPERATOR_B_ID = 'op-b';
const PLAYER_ID = 'pid-1';
const CURRENCY = 'EUR';
const INITIAL_BALANCE = 100_000;

// ---------------------------------------------------------------------------
// Signing helpers (mirror tools/operator-stub/src/index.test.ts)
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacHex(data: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Build signed headers for a request.
 * path MUST be the full external path the operator signs (e.g. /op/v1/sessions/x/terminate).
 * key and apiKey must come from the live registry (fetched in beforeAll).
 */
function buildSignedHeaders(
  method: string,
  path: string,
  body: object,
  key: Buffer,
  apiKey: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const bodyBytes = Buffer.from(JSON.stringify(body));
  const bodyHash = sha256Hex(bodyBytes);
  const sigString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = hmacHex(sigString, key);
  return {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let stubServer: Server;
let stubPort: number;

let db: InstanceType<typeof Database>;
let registry: OperatorRegistry;
let betLog: BetLog;
let walletClientCache: WalletClientCache;

// Operator A credentials (resolved in beforeAll after registry.create())
let OP_A_KEY: Buffer;
let OP_A_API_KEY: string;

// Operator B credentials
let OP_B_KEY: Buffer;
let OP_B_API_KEY: string;

// The express app under test — replicates the /op/v1 mount from index.ts
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

  // 2. In-memory SQLite: registry + betLog share the same db
  db = new Database(':memory:');
  betLog = new BetLog(db);
  registry = new OperatorRegistry(db);

  // Register operator A — points at the real stub
  // Override the auto-generated signing key with the stub's fixed key so wallet calls work
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
  // Fetch the actual API key (auto-generated by registry) and the overridden signing key
  const opA = registry.getById(OPERATOR_A_ID)!;
  OP_A_API_KEY = opA.apiKey;
  OP_A_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

  // Register operator B — also points at the stub but with a DIFFERENT signing key
  // so its requests produce a different (valid) HMAC, but for A's session → 404
  registry.create({
    operatorId: OPERATOR_B_ID,
    name: 'Operator B',
    walletBaseUrl: `http://localhost:${stubPort}`,
    currencies: [CURRENCY],
    status: 'active',
  });
  const opB = registry.getById(OPERATOR_B_ID)!;
  OP_B_API_KEY = opB.apiKey;
  OP_B_KEY = opB.signingKey; // random key auto-generated by registry

  // 3. Build WalletClientCache + wire DI seam
  walletClientCache = new WalletClientCache(registry, betLog);
  setOperatorWiringDeps({ walletClientCache, betLog });

  // 4. Build the test express app, replicating the /op/v1 mount from index.ts
  testApp = express();
  testApp.use(express.json({ verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  }}));
  testApp.use(
    '/op/v1',
    verifyOperatorSignature(registry, { getSignedPath: (req) => req.originalUrl.split('?')[0] }),
    createOperatorRouter(),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    stubServer.close((err) => (err ? reject(err) : resolve())),
  );
  db.close();
});

beforeEach(() => {
  resetStubState();
  vi.clearAllMocks();
  sessionStore.clear();
  sessionSockets.clear();
  _internal__setCurrentRoundForTesting(null);
  // Re-wire deps after clearAllMocks (setOperatorWiringDeps itself is not a mock, but
  // the betLog/walletClientCache are real objects — no re-wiring needed)
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpASession(sessionId: string, extra: Record<string, unknown> = {}) {
  const sess = {
    sessionId,
    displayName: 'test-player',
    balance: INITIAL_BALANCE,
    createdAt: Date.now(),
    expiresAt: Date.now() + 8 * 3600 * 1000,
    operatorId: OPERATOR_A_ID,
    playerId: PLAYER_ID,
    currency: CURRENCY,
    balanceMinor: INITIAL_BALANCE,
    ...extra,
  };
  sessionStore.set(sessionId, sess);
  return sess;
}

function makeFakeWs(): WebSocket {
  return { readyState: 1 /* OPEN */, close: vi.fn(), send: vi.fn() } as unknown as WebSocket;
}

function terminatePath(sessionId: string) {
  return `/op/v1/sessions/${sessionId}/terminate`;
}

/** Sign a terminate request as operator A (the default signing operator in tests). */
function signedTerminate(
  sessionId: string,
  body: object = {},
) {
  return buildSignedHeaders('POST', terminatePath(sessionId), body, OP_A_KEY, OP_A_API_KEY);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /op/v1/sessions/:sessionId/terminate', () => {

  // ─── Test 1: valid terminate, no in-flight bet ──────────────────────────────

  it('valid terminate, no in-flight bet → 204; session_terminated frame; ws closed; sessionSockets cleared', async () => {
    const sessionId = 'sess-terminate-1';
    makeOpASession(sessionId);

    // Install a fake WS into sessionSockets
    const fakeWs = makeFakeWs();
    sessionSockets.set(sessionId, new Set([fakeWs]));

    const body = { reason: 'self_excluded', message: 'Session closed by operator.' };
    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set(signedTerminate(sessionId, body))
      .send(body);

    expect(res.status).toBe(204);

    // sendToSession must have been called with the session_terminated frame
    expect(vi.mocked(sendToSession)).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        type: 'session_terminated',
        data: expect.objectContaining({
          reason: 'self_excluded',
          message: 'Session closed by operator.',
        }),
      }),
    );

    // The fake WS must have been closed with code 4001
    expect(fakeWs.close).toHaveBeenCalledWith(4001, 'session_terminated');

    // sessionSockets must no longer have this session
    expect(sessionSockets.has(sessionId)).toBe(false);
  });

  // ─── Test 2: valid terminate WITH an in-flight ARMED operator bet ───────────

  it('valid terminate with in-flight ARMED bet → 204; betLog VOIDED; bet.cashedOut; ws closed', async () => {
    const sessionId = 'sess-terminate-2';
    makeOpASession(sessionId);

    // Place a real bet through the stub so we have an ARMED betLog row
    const betId = `bet-${sessionId}-99`;
    const betTxnId = crypto.randomUUID();
    const client = walletClientCache.get(OPERATOR_A_ID)!;

    // Manually create the betLog row and call /bet on the stub
    betLog.create({
      betId,
      operatorId: OPERATOR_A_ID,
      playerId: PLAYER_ID,
      sessionId,
      roundId: 'rnd-terminate-2',
      currency: CURRENCY,
      amountMinor: 10_000,
      betTxnId,
    });
    const betResp = await client.bet({
      playerId: PLAYER_ID,
      sessionId,
      roundId: 'rnd-terminate-2',
      betId,
      txnId: betTxnId,
      amountMinor: 10_000,
      currency: CURRENCY,
      gameId: 'galaxy-crash',
      placedAt: Math.floor(Date.now() / 1000),
    });
    betLog.transition(betId, 'bet_accepted', { betOpTxnId: betResp.operatorTxnId });
    expect(betLog.getById(betId)?.state).toBe('ARMED');

    // Inject the bet into the in-memory round
    const inMemoryBet = {
      playerId: sessionId,
      operatorId: OPERATOR_A_ID,
      betId,
      betTxnId,
      amountMinor: 10_000,
      currency: CURRENCY,
      amount: 100,
      cashedOut: false,
      isBot: false,
    };
    _internal__setCurrentRoundForTesting({
      roundNumber: 99,
      phase: 'BETTING',
      crashPoint: 3.0,
      currentMultiplier: 1.0,
      startTime: Date.now(),
      bets: [inMemoryBet as import('@crash/shared/types').Bet],
      serverSeedHash: 'abc',
    });

    // Install fake WS
    const fakeWs = makeFakeWs();
    sessionSockets.set(sessionId, new Set([fakeWs]));

    const body = { reason: 'rg_limit', message: 'RG limit reached.' };
    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set(signedTerminate(sessionId, body))
      .send(body);

    expect(res.status).toBe(204);

    // In-memory bet must be marked cashedOut
    expect(inMemoryBet.cashedOut).toBe(true);

    // betLog row must be VOIDED (rollback succeeded via stub)
    const row = betLog.getById(betId);
    expect(row?.state === 'VOIDED' || row?.state === 'ROLLBACK_PENDING').toBe(true);

    // Stub balance must reflect the refund: 100000 - 10000 + 10000 = 100000
    if (row?.state === 'VOIDED') {
      const balResp = await client.balance({ playerId: PLAYER_ID, sessionId });
      expect(balResp.balance).toBe(100_000);
    }

    // WS closed
    expect(fakeWs.close).toHaveBeenCalledWith(4001, 'session_terminated');
    expect(sessionSockets.has(sessionId)).toBe(false);

    // session_terminated frame sent
    expect(vi.mocked(sendToSession)).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ type: 'session_terminated' }),
    );
  });

  // ─── Test 3: cross-tenant — operator B terminates operator A's session → 404 ─

  it('cross-tenant: operator B terminates operator A session → 404 SESSION_NOT_FOUND; no rollback; no ws close; no sendToSession', async () => {
    const sessionId = 'sess-terminate-3';
    makeOpASession(sessionId);

    const fakeWs = makeFakeWs();
    sessionSockets.set(sessionId, new Set([fakeWs]));

    // Sign with operator B's key and API key — the request is validly signed for B
    // but B does not own this session (it belongs to A).
    const body = {};
    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set(buildSignedHeaders('POST', terminatePath(sessionId), body, OP_B_KEY, OP_B_API_KEY))
      .send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');

    // No sendToSession, no ws close
    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();
    expect(fakeWs.close).not.toHaveBeenCalled();
    expect(sessionSockets.has(sessionId)).toBe(true);
  });

  // ─── Test 4: demo session → 404 SESSION_NOT_FOUND ──────────────────────────

  it('demo session (no operatorId) → 404 SESSION_NOT_FOUND', async () => {
    const sessionId = 'sess-terminate-demo';
    sessionStore.set(sessionId, {
      sessionId,
      displayName: 'demo-user',
      balance: 1000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600 * 1000,
      // no operatorId
    });

    const fakeWs = makeFakeWs();
    sessionSockets.set(sessionId, new Set([fakeWs]));

    const body = {};
    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set(signedTerminate(sessionId, body))
      .send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');

    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();
    expect(fakeWs.close).not.toHaveBeenCalled();
  });

  // ─── Test 5: unknown sessionId → 404 SESSION_NOT_FOUND ──────────────────────

  it('unknown sessionId → 404 SESSION_NOT_FOUND', async () => {
    const sessionId = 'sess-does-not-exist';
    // sessionStore is empty — getSession will return null

    const body = {};
    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set(signedTerminate(sessionId, body))
      .send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();
  });

  // ─── Test 6: bad signature → 401 INVALID_SIGNATURE (middleware rejects) ─────

  it('bad signature → 401 INVALID_SIGNATURE from middleware; handler not reached', async () => {
    const sessionId = 'sess-terminate-badsig';
    makeOpASession(sessionId);

    const fakeWs = makeFakeWs();
    sessionSockets.set(sessionId, new Set([fakeWs]));

    const body = {};
    const headers = signedTerminate(sessionId, body);
    // Tamper the signature
    headers['X-Signature'] = 'deadbeef'.repeat(8);

    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set(headers)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');

    // Handler was NOT reached — no side effects
    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();
    expect(fakeWs.close).not.toHaveBeenCalled();
  });

  // ─── Test 7: missing signing headers → 401 INVALID_REQUEST ──────────────────

  it('missing signing headers → 401 INVALID_REQUEST', async () => {
    const sessionId = 'sess-terminate-noheaders';
    makeOpASession(sessionId);

    const body = {};
    const res = await request(testApp)
      .post(terminatePath(sessionId))
      .set({ 'Content-Type': 'application/json' })  // no X-* headers
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REQUEST');

    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();
  });
});
