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
  deleteSession: vi.fn(async (sessionId: string) => {
    sessionStore.delete(sessionId);
  }),
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
import { PgBetLog, PgOperatorRegistry } from '@crash/wallet';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
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
import { PgOperatorAudit } from './operator-audit-pg.js';

import { sessionSockets, sendToSession } from '../ws/hub.js';
import { deleteSession } from '../store.js';

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

let testDb: TestDb;
let registry: PgOperatorRegistry;
let betLog: PgBetLog;
let walletClientCache: WalletClientCache;
let operatorAudit: PgOperatorAudit;

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

  // 2. Isolated Postgres schema: registry + betLog share the same pool
  testDb = await makeTestDb();
  betLog = new PgBetLog(testDb.pool);
  registry = new PgOperatorRegistry(testDb.pool);

  // Register operator A — points at the real stub
  // Override the auto-generated signing key with the stub's fixed key so wallet calls work
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
  // Raw signing-key write bypassed the registry cache — refresh so getById/getByApiKey see it.
  await registry.refresh();
  // Fetch the actual API key (auto-generated by registry) and the overridden signing key
  const opA = registry.getById(OPERATOR_A_ID)!;
  OP_A_API_KEY = opA.apiKey;
  OP_A_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

  // Register operator B — also points at the stub but with a DIFFERENT signing key
  // so its requests produce a different (valid) HMAC, but for A's session → 404
  await registry.create({
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
  operatorAudit = new PgOperatorAudit(testDb.pool);
  setOperatorWiringDeps({ walletClientCache, betLog });

  // 4. Build the test express app, replicating the /op/v1 mount from index.ts
  testApp = express();
  testApp.use(express.json({ verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  }}));
  testApp.use(
    '/op/v1',
    verifyOperatorSignature(registry, { getSignedPath: (req) => req.originalUrl.split('?')[0] }),
    createOperatorRouter({ betLog, registry, walletClientCache, operatorAudit }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    stubServer.close((err) => (err ? reject(err) : resolve())),
  );
  await testDb.cleanup();
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

/**
 * PgOperatorAudit.record() is fire-and-forget (void) — the INSERT is not awaited
 * by the handler, so an immediate listByOperator() can race the write. Poll the
 * audit log briefly until the expected row appears (or give up after ~500ms).
 */
async function waitForAudit<T>(
  operatorId: string,
  find: (rows: Awaited<ReturnType<PgOperatorAudit['listByOperator']>>) => T | undefined,
): Promise<T | undefined> {
  for (let i = 0; i < 50; i++) {
    const rows = await operatorAudit.listByOperator(operatorId);
    const hit = find(rows);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
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

    // DURABLE (Task 6.4): deleteSession must have been called with the sessionId,
    // and the session row must be gone from the store (refresh-defeat fix).
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith(sessionId);
    expect(sessionStore.has(sessionId)).toBe(false);

    // AUDIT (Task 6.4): a session.terminate row must be recorded for operator A.
    const row = await waitForAudit(OPERATOR_A_ID, (rows) =>
      rows.find((a) => a.action === 'session.terminate' && a.target === sessionId),
    );
    expect(row).toBeDefined();
    expect(row?.payload).toEqual({ reason: 'self_excluded' });
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
    await betLog.create({
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
    await betLog.transition(betId, 'bet_accepted', { betOpTxnId: betResp.operatorTxnId });
    expect((await betLog.getById(betId))?.state).toBe('ARMED');

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

    // betLog row must be deterministically VOIDED — the operator stub rollback
    // completes synchronously over localhost before the await resolves. An OR
    // branch here would mask broken rollback wiring (wrong port / signing key).
    const row = await betLog.getById(betId);
    expect(row?.state).toBe('VOIDED');

    // Stub balance must reflect the refund: 100000 - 10000 + 10000 = 100000
    const balResp = await client.balance({ playerId: PLAYER_ID, sessionId });
    expect(balResp.balance).toBe(100_000);

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

    // No sendToSession, no ws close, no durable delete
    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();
    expect(fakeWs.close).not.toHaveBeenCalled();
    expect(sessionSockets.has(sessionId)).toBe(true);
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();

    // NO audit row for the denied cross-tenant attempt (under operator B).
    expect((await operatorAudit.listByOperator(OPERATOR_B_ID)).length).toBe(0);
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

  // ─── Test 8 (Fix 1 — RG enforcement): voidOperatorBet throws → still 204; socket closed ──

  it('Fix 1 RG-enforcement: voidOperatorBet throws for every bet → still 204; session_terminated sent; ws closed; sessionSockets cleared', async () => {
    // Strategy: temporarily null-out OperatorWiringDeps so that voidOperatorBet
    // hits its bootstrap-defect `throw new Error(...)` path. This is deterministic
    // and requires no out-of-scope file changes.
    // The per-bet try/catch added in Fix 1 must catch that throw and allow the
    // socket-close + 204 to proceed unconditionally.

    const sessionId = 'sess-terminate-void-throws';
    makeOpASession(sessionId);

    // Inject an in-memory ARMED bet with a betId (no real betLog row needed;
    // voidOperatorBet will throw before it reaches getById because deps is null).
    const betId = `bet-${sessionId}-throw`;
    const inMemoryBet = {
      playerId: sessionId,
      operatorId: OPERATOR_A_ID,
      betId,
      betTxnId: crypto.randomUUID(),
      amountMinor: 5_000,
      currency: CURRENCY,
      amount: 50,
      cashedOut: false,
      isBot: false,
    };
    _internal__setCurrentRoundForTesting({
      roundNumber: 200,
      phase: 'BETTING',
      crashPoint: 2.0,
      currentMultiplier: 1.0,
      startTime: Date.now(),
      bets: [inMemoryBet as import('@crash/shared/types').Bet],
      serverSeedHash: 'xyz',
    });

    const fakeWs = makeFakeWs();
    sessionSockets.set(sessionId, new Set([fakeWs]));

    // Null the deps — voidOperatorBet will throw 'bootstrap defect'
    setOperatorWiringDeps(null);
    try {
      const body = { reason: 'aml_hold', message: 'AML hold applied.' };
      const res = await request(testApp)
        .post(terminatePath(sessionId))
        .set(signedTerminate(sessionId, body))
        .send(body);

      // Fix 1: must still be 204 even though voidOperatorBet threw
      expect(res.status).toBe(204);

      // session_terminated frame must have been sent
      expect(vi.mocked(sendToSession)).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ type: 'session_terminated' }),
      );

      // ws.close must have been called — player is disconnected
      expect(fakeWs.close).toHaveBeenCalledWith(4001, 'session_terminated');

      // sessionSockets must be cleared
      expect(sessionSockets.has(sessionId)).toBe(false);

      // in-memory bet must be marked cashedOut (set before voidOperatorBet is called)
      expect(inMemoryBet.cashedOut).toBe(true);
    } finally {
      // Always restore deps so subsequent tests (if any) are unaffected
      setOperatorWiringDeps({ walletClientCache, betLog });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 6.4 — mutating routes: player lock/unlock + limits
// ---------------------------------------------------------------------------

/** Build signed headers for an arbitrary POST as operator A. */
function signedPostA(path: string, body: object): Record<string, string> {
  return buildSignedHeaders('POST', path, body, OP_A_KEY, OP_A_API_KEY);
}

/** Build signed headers for an arbitrary POST as operator B. */
function signedPostB(path: string, body: object): Record<string, string> {
  return buildSignedHeaders('POST', path, body, OP_B_KEY, OP_B_API_KEY);
}

/** Seed a bet_log row so listDistinctSessionIdsByPlayer finds the session. */
async function seedBet(operatorId: string, playerId: string, sessionId: string) {
  await betLog.create({
    betId: `bet-${sessionId}-${crypto.randomUUID()}`,
    operatorId,
    playerId,
    sessionId,
    roundId: `rnd-${sessionId}`,
    currency: CURRENCY,
    amountMinor: 1_000,
    betTxnId: crypto.randomUUID(),
  });
}

describe('POST /op/v1/players/:playerId/lock (§6.3)', () => {
  it('player with sessions → all sessions terminated (deleteSession per live session) + player.lock audit + 204', async () => {
    const playerId = 'lock-player-1';
    const s1 = 'lock-sess-1a';
    const s2 = 'lock-sess-1b';
    // bet_log rows discover the session universe
    await seedBet(OPERATOR_A_ID, playerId, s1);
    await seedBet(OPERATOR_A_ID, playerId, s2);
    // live sessions in the store + sockets
    makeOpASession(s1, { playerId });
    makeOpASession(s2, { playerId });
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    sessionSockets.set(s1, new Set([ws1]));
    sessionSockets.set(s2, new Set([ws2]));

    const path = `/op/v1/players/${playerId}/lock`;
    const body = { reason: 'self_excluded', message: 'locked' };
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);

    expect(res.status).toBe(204);

    // Each discovered live session was durably terminated.
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith(s1);
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith(s2);
    expect(ws1.close).toHaveBeenCalledWith(4001, 'session_terminated');
    expect(ws2.close).toHaveBeenCalledWith(4001, 'session_terminated');
    expect(sessionStore.has(s1)).toBe(false);
    expect(sessionStore.has(s2)).toBe(false);

    // player.lock audit row
    const row = await waitForAudit(OPERATOR_A_ID, (rows) =>
      rows.find((a) => a.action === 'player.lock' && a.target === playerId),
    );
    expect(row).toBeDefined();
    expect(row?.payload).toEqual({ reason: 'self_excluded' });
  });

  it('player with no bet_log sessions → 404 PLAYER_NOT_FOUND, no audit', async () => {
    const playerId = 'lock-player-unknown';
    const path = `/op/v1/players/${playerId}/lock`;
    const body = {};
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PLAYER_NOT_FOUND');
    const audit = await operatorAudit.listByOperator(OPERATOR_A_ID);
    expect(audit.find((a) => a.action === 'player.lock' && a.target === playerId)).toBeUndefined();
  });

  it('cross-tenant: operator B locks operator A player → 404 PLAYER_NOT_FOUND (byte-identical), no audit for B', async () => {
    const playerId = 'lock-player-xtenant';
    await seedBet(OPERATOR_A_ID, playerId, 'xtenant-sess');
    const path = `/op/v1/players/${playerId}/lock`;
    const body = {};
    const res = await request(testApp).post(path).set(signedPostB(path, body)).send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PLAYER_NOT_FOUND');
    expect(res.body.error.message).toBe(`No player with id '${playerId}'`);
    // no terminate side effects, no audit under B
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();
    expect((await operatorAudit.listByOperator(OPERATOR_B_ID)).find((a) => a.action === 'player.lock')).toBeUndefined();
  });

  it('401 without a valid signature (signed mount smoke test)', async () => {
    const playerId = 'lock-player-auth';
    const path = `/op/v1/players/${playerId}/lock`;
    const body = {};
    const headers = signedPostA(path, body);
    headers['X-Signature'] = 'deadbeef'.repeat(8);
    const res = await request(testApp).post(path).set(headers).send(body);
    expect(res.status).toBe(401);
  });
});

describe('POST /op/v1/players/:playerId/unlock (§6.4)', () => {
  it('204 + player.unlock audit, no store mutation', async () => {
    const playerId = 'unlock-player-1';
    const path = `/op/v1/players/${playerId}/unlock`;
    const body = {};
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);

    expect(res.status).toBe(204);
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();
    expect(vi.mocked(sendToSession)).not.toHaveBeenCalled();

    const row = await waitForAudit(OPERATOR_A_ID, (rows) =>
      rows.find((a) => a.action === 'player.unlock' && a.target === playerId),
    );
    expect(row).toBeDefined();
  });

  it('401 without a valid signature', async () => {
    const playerId = 'unlock-player-auth';
    const path = `/op/v1/players/${playerId}/unlock`;
    const body = {};
    const headers = signedPostA(path, body);
    headers['X-Signature'] = 'deadbeef'.repeat(8);
    const res = await request(testApp).post(path).set(headers).send(body);
    expect(res.status).toBe(401);
  });
});

describe('POST /op/v1/limits (§9.2)', () => {
  const path = '/op/v1/limits';

  it('happy path persists + limits.update audit + 200 echo', async () => {
    const body = { currency: CURRENCY, minBetMinor: 50, maxBetMinor: 200_000 };
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);

    expect(res.status).toBe(200);
    expect(res.body.limits).toContainEqual({ currency: CURRENCY, minBetMinor: 50, maxBetMinor: 200_000 });

    // Persisted operator-wide on the registry.
    const op = registry.getById(OPERATOR_A_ID)!;
    expect(op.minBetMinor).toBe(50);
    expect(op.maxBetMinor).toBe(200_000);

    const row = await waitForAudit(OPERATOR_A_ID, (rows) =>
      rows.find((a) => a.action === 'limits.update' && a.target === CURRENCY),
    );
    expect(row).toBeDefined();
    expect(row?.payload).toEqual({ minBetMinor: 50, maxBetMinor: 200_000 });
  });

  it('422 CURRENCY_NOT_ENABLED for a currency not enabled', async () => {
    const body = { currency: 'JPY', minBetMinor: 50, maxBetMinor: 200_000 };
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CURRENCY_NOT_ENABLED');
  });

  it('422 LIMIT_OUT_OF_RANGE when max < min', async () => {
    const body = { currency: CURRENCY, minBetMinor: 500, maxBetMinor: 100 };
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LIMIT_OUT_OF_RANGE');
  });

  it('422 LIMIT_OUT_OF_RANGE when minBetMinor < 1', async () => {
    const body = { currency: CURRENCY, minBetMinor: 0, maxBetMinor: 100 };
    const res = await request(testApp).post(path).set(signedPostA(path, body)).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LIMIT_OUT_OF_RANGE');
  });

  it('401 without a valid signature', async () => {
    const body = { currency: CURRENCY, minBetMinor: 50, maxBetMinor: 200_000 };
    const headers = signedPostA(path, body);
    headers['X-Signature'] = 'deadbeef'.repeat(8);
    const res = await request(testApp).post(path).set(headers).send(body);
    expect(res.status).toBe(401);
  });
});
