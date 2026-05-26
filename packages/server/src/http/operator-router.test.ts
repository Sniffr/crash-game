/**
 * Tests for Task 6.2: /op/v1 router extension + tenant-scope middleware.
 *
 * Covers:
 *   1. GET /op/v1/health is PUBLIC — no auth required, no INVALID_SIGNATURE even
 *      with bad/missing headers.
 *   2. GET /op/v1/games requires auth — 401 without signature, 200 + correct
 *      shape with valid signature.
 *   3. enforceTenantScope unit tests — matching/mismatching operator ids, defensive
 *      "no req.operator" branch.
 *   4. Cross-tenant 404 no-leak smoke — cross-tenant + truly-not-found produce
 *      BYTE-IDENTICAL 404 bodies (terminate route; existing operator-terminate.test.ts
 *      covers the full matrix; this is a quick regression guard that also verifies
 *      the router still accepts deps after Task 6.2).
 *
 * Uses the same harness pattern as operator-terminate.test.ts:
 *   real OperatorRegistry + BetLog (:memory: SQLite), real WalletClientCache,
 *   verifyOperatorSignature + createOperatorRouter under supertest.
 *   Store + WS hub are mocked.
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
  recordWin: vi.fn(),
  recordLoss: vi.fn(),
  checkRateLimit: vi.fn(async () => true),
  refreshTtl: vi.fn(),
  setBalance: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Hub mock
// ---------------------------------------------------------------------------

vi.mock('../ws/hub.js', () => {
  const sessionSockets = new Map<string, Set<import('ws').WebSocket>>();
  const sendToSession = vi.fn();
  const broadcast = vi.fn();
  const safeSend = vi.fn();
  return { sessionSockets, sendToSession, broadcast, safeSend };
});

// ---------------------------------------------------------------------------
// Transitively-imported singletons
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

import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import { WalletClientCache } from '../wallet/client-cache.js';
import { setOperatorWiringDeps } from '../game/operator-deps.js';
import { _internal__setCurrentRoundForTesting } from '../game/round.js';
import { verifyOperatorSignature } from './middleware/verify-operator-signature.js';
import { createOperatorRouter } from './operator.js';
import { OperatorAudit } from './operator-audit.js';
import { enforceTenantScope } from './middleware/tenant-scope.js';
import type { OperatorAuthedRequest } from './middleware/verify-operator-signature.js';

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacHex(data: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Build signed headers for a request.
 * bodyBytes must be the exact bytes that will be sent as the request body.
 * Pass Buffer.alloc(0) for GET requests (no body).
 * Pass Buffer.from(JSON.stringify(body)) for POST/PUT with a body.
 */
function buildSignedHeaders(
  method: string,
  path: string,
  bodyBytes: Buffer,
  key: Buffer,
  apiKey: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
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

/** Convenience: build signed headers for a GET request (no body). */
function getSignedHeaders(path: string, key: Buffer, apiKey: string): Record<string, string> {
  return buildSignedHeaders('GET', path, Buffer.alloc(0), key, apiKey);
}

/** Convenience: build signed headers for a POST request with a JSON body. */
function postSignedHeaders(path: string, body: object, key: Buffer, apiKey: string): Record<string, string> {
  return buildSignedHeaders('POST', path, Buffer.from(JSON.stringify(body)), key, apiKey);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const OPERATOR_A_ID = 'router-test-op-a';
const OPERATOR_B_ID = 'router-test-op-b';
const CURRENCY_EUR = 'EUR';
const CURRENCY_USD = 'USD';

let stubServer: Server;
let stubPort: number;

let db: InstanceType<typeof Database>;
let registry: OperatorRegistry;
let betLog: BetLog;
let walletClientCache: WalletClientCache;

let OP_A_KEY: Buffer;
let OP_A_API_KEY: string;
let OP_B_KEY: Buffer;
let OP_B_API_KEY: string;

// testApp mirrors the /op/v1 mount from index.ts, INCLUDING the public
// /health route mounted BEFORE the signed /op/v1 chain.
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

  // 2. In-memory SQLite
  db = new Database(':memory:');
  betLog = new BetLog(db);
  registry = new OperatorRegistry(db);

  // Register operator A with two currencies (EUR + USD) to test per-currency fanout
  registry.create({
    operatorId: OPERATOR_A_ID,
    name: 'Router Test Operator A',
    walletBaseUrl: `http://localhost:${stubPort}`,
    currencies: [CURRENCY_EUR, CURRENCY_USD],
    status: 'active',
  });
  db.prepare(`UPDATE operators SET signing_key_b64 = ? WHERE operator_id = ?`).run(
    STUB_DEFAULT_KEY_B64,
    OPERATOR_A_ID,
  );
  const opA = registry.getById(OPERATOR_A_ID)!;
  OP_A_API_KEY = opA.apiKey;
  OP_A_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

  // Register operator B — different signing key, used for cross-tenant tests
  registry.create({
    operatorId: OPERATOR_B_ID,
    name: 'Router Test Operator B',
    walletBaseUrl: `http://localhost:${stubPort}`,
    currencies: [CURRENCY_EUR],
    status: 'active',
  });
  const opB = registry.getById(OPERATOR_B_ID)!;
  OP_B_API_KEY = opB.apiKey;
  OP_B_KEY = opB.signingKey;

  // 3. WalletClientCache + DI seam
  walletClientCache = new WalletClientCache(registry, betLog);
  setOperatorWiringDeps({ walletClientCache, betLog });

  // 4. Build the test express app — replicates the index.ts wiring for /op/v1.
  //    /health is mounted BEFORE the verifyOperatorSignature chain so it is public.
  testApp = express();
  testApp.use(express.json({ verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  }}));

  // PUBLIC — mounted before the signed chain (mirrors index.ts)
  testApp.get('/op/v1/health', (_req, res) => {
    res.json({ ok: true, version: '1.0.0', gamesAvailable: ['galaxy-crash'] });
  });

  // Signed /op/v1 chain
  testApp.use(
    '/op/v1',
    verifyOperatorSignature(registry, { getSignedPath: (req) => req.originalUrl.split('?')[0] }),
    createOperatorRouter({ betLog, registry, walletClientCache, operatorAudit: new OperatorAudit(db) }),
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
  _internal__setCurrentRoundForTesting(null);
});

// ---------------------------------------------------------------------------
// Test 1: GET /op/v1/health is PUBLIC
// ---------------------------------------------------------------------------

describe('GET /op/v1/health (public)', () => {
  it('returns 200 + expected JSON with NO auth headers', async () => {
    const res = await request(testApp).get('/op/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      version: '1.0.0',
      gamesAvailable: ['galaxy-crash'],
    });
    // Absolutely no auth error codes in the response
    expect(res.body.error).toBeUndefined();
  });

  it('returns 200 even when bad X-Signature is sent — route bypasses auth middleware', async () => {
    const res = await request(testApp)
      .get('/op/v1/health')
      .set({
        'X-API-Key': 'bad-key',
        'X-Timestamp': '12345',
        'X-Nonce': 'bad-nonce',
        'X-Signature': 'deadbeef',
      });
    expect(res.status).toBe(200);
    // No INVALID_SIGNATURE or INVALID_REQUEST — health is before the auth chain
    expect(res.body.error).toBeUndefined();
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: GET /op/v1/games requires auth + returns correct shape
// ---------------------------------------------------------------------------

describe('GET /op/v1/games (signed)', () => {
  it('401 INVALID_REQUEST when no signing headers provided', async () => {
    const res = await request(testApp).get('/op/v1/games');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('401 INVALID_SIGNATURE when signature is tampered', async () => {
    const headers = getSignedHeaders('/op/v1/games', OP_A_KEY, OP_A_API_KEY);
    headers['X-Signature'] = 'deadbeef'.repeat(8);
    const res = await request(testApp).get('/op/v1/games').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('200 + correct games shape with valid operator A signature', async () => {
    const headers = getSignedHeaders('/op/v1/games', OP_A_KEY, OP_A_API_KEY);
    const res = await request(testApp).get('/op/v1/games').set(headers);

    expect(res.status).toBe(200);

    const opA = registry.getById(OPERATOR_A_ID)!;
    expect(res.body).toEqual({
      games: [
        {
          gameId: 'galaxy-crash',
          name: 'Galaxy Crash',
          rtpVariant: opA.rtpVariant,
          enabled: true,
          minBetMinor: {
            [CURRENCY_EUR]: opA.minBetMinor,
            [CURRENCY_USD]: opA.minBetMinor,
          },
          maxBetMinor: {
            [CURRENCY_EUR]: opA.maxBetMinor,
            [CURRENCY_USD]: opA.maxBetMinor,
          },
        },
      ],
    });
  });

  it('200 + correct games shape for operator B (single currency EUR)', async () => {
    const headers = getSignedHeaders('/op/v1/games', OP_B_KEY, OP_B_API_KEY);
    const res = await request(testApp).get('/op/v1/games').set(headers);

    expect(res.status).toBe(200);
    const opB = registry.getById(OPERATOR_B_ID)!;
    const game = res.body.games[0];
    // Only EUR in the fanout (opB has one currency)
    expect(Object.keys(game.minBetMinor)).toEqual([CURRENCY_EUR]);
    expect(game.rtpVariant).toBe(opB.rtpVariant);
    expect(game.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Cross-tenant 404 no-leak smoke (terminate route)
// Regression guard: confirms router with deps still enforces the byte-identical
// 404 pattern from Phase 3.3. operator-terminate.test.ts covers the full matrix.
// ---------------------------------------------------------------------------

describe('cross-tenant 404 no-leak (terminate route smoke)', () => {
  it('cross-tenant 404 and truly-not-found 404 have BYTE-IDENTICAL bodies', async () => {
    // Set up a session belonging to operator A
    const sessionId = 'router-test-ct-sess-1';
    sessionStore.set(sessionId, {
      sessionId,
      operatorId: OPERATOR_A_ID,
      playerId: 'p1',
      currency: CURRENCY_EUR,
      balanceMinor: 1000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    });

    const path = `/op/v1/sessions/${sessionId}/terminate`;
    const body = {};

    // Operator B (cross-tenant) request — valid HMAC for B but A owns the session
    const crossTenantRes = await request(testApp)
      .post(path)
      .set(postSignedHeaders(path, body, OP_B_KEY, OP_B_API_KEY))
      .send(body);

    expect(crossTenantRes.status).toBe(404);
    expect(crossTenantRes.body.error.code).toBe('SESSION_NOT_FOUND');

    // Operator A request for a non-existent session
    const unknownSessPath = `/op/v1/sessions/does-not-exist/terminate`;
    const trulyNotFoundRes = await request(testApp)
      .post(unknownSessPath)
      .set(postSignedHeaders(unknownSessPath, body, OP_A_KEY, OP_A_API_KEY))
      .send(body);

    expect(trulyNotFoundRes.status).toBe(404);
    expect(trulyNotFoundRes.body.error.code).toBe('SESSION_NOT_FOUND');

    // Both 404 bodies must be byte-identical (no existence leak)
    expect(crossTenantRes.body).toEqual(trulyNotFoundRes.body);
  });
});

// ---------------------------------------------------------------------------
// Test 4: enforceTenantScope unit tests
// ---------------------------------------------------------------------------

describe('enforceTenantScope (unit)', () => {
  /**
   * Build a minimal mock Request with req.operator set.
   */
  function mockReq(operatorId: string | undefined): Partial<OperatorAuthedRequest> {
    if (operatorId === undefined) {
      return {} as Partial<OperatorAuthedRequest>;
    }
    return {
      operator: {
        operatorId,
        name: 'Test Op',
        walletBaseUrl: 'http://localhost',
        apiKey: 'key',
        signingKey: Buffer.alloc(32),
        status: 'active',
        currencies: ['EUR'],
        minBetMinor: 10,
        maxBetMinor: 500_000,
        rtpVariant: 97,
        adapter: 'native',
        jurisdictions: [],
        shareBps: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    } as Partial<OperatorAuthedRequest>;
  }

  /**
   * Build a minimal mock Response that captures status + json calls.
   */
  function mockRes(): { res: Partial<import('express').Response>; status: number | null; body: unknown } {
    const ctx = { status: null as number | null, body: undefined as unknown };
    const res = {
      status(code: number) { ctx.status = code; return this; },
      json(body: unknown) { ctx.body = body; return this; },
    } as unknown as Partial<import('express').Response>;
    return { res, ...ctx };
  }

  it('returns true when rowOperatorId matches req.operator.operatorId', () => {
    const req = mockReq('op-a');
    const { res } = mockRes();
    const result = enforceTenantScope(
      'op-a',
      req as import('express').Request,
      res as import('express').Response,
      'NOT_FOUND',
      'not found',
    );
    expect(result).toBe(true);
  });

  it('returns false + sends 404 when rowOperatorId belongs to a different operator', () => {
    const req = mockReq('op-a');
    const ctx = { status: null as number | null, body: undefined as unknown };
    const res = {
      status(code: number) { ctx.status = code; return this; },
      json(body: unknown) { ctx.body = body; return this; },
    } as unknown as import('express').Response;

    const result = enforceTenantScope(
      'op-b',
      req as import('express').Request,
      res,
      'SESSION_NOT_FOUND',
      'No such session',
    );
    expect(result).toBe(false);
    expect(ctx.status).toBe(404);
    expect((ctx.body as { error: { code: string } }).error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns false + sends 404 when rowOperatorId is null (row not found)', () => {
    const req = mockReq('op-a');
    const ctx = { status: null as number | null, body: undefined as unknown };
    const res = {
      status(code: number) { ctx.status = code; return this; },
      json(body: unknown) { ctx.body = body; return this; },
    } as unknown as import('express').Response;

    const result = enforceTenantScope(
      null,
      req as import('express').Request,
      res,
      'SESSION_NOT_FOUND',
      'No such session',
    );
    expect(result).toBe(false);
    expect(ctx.status).toBe(404);
  });

  it('cross-tenant 404 and null-row 404 produce BYTE-IDENTICAL bodies (no existence leak)', () => {
    const req = mockReq('op-a');

    const ctx1 = { status: null as number | null, body: undefined as unknown };
    const res1 = {
      status(code: number) { ctx1.status = code; return this; },
      json(body: unknown) { ctx1.body = body; return this; },
    } as unknown as import('express').Response;

    const ctx2 = { status: null as number | null, body: undefined as unknown };
    const res2 = {
      status(code: number) { ctx2.status = code; return this; },
      json(body: unknown) { ctx2.body = body; return this; },
    } as unknown as import('express').Response;

    // cross-tenant (row exists but belongs to different operator)
    enforceTenantScope('op-b', req as import('express').Request, res1, 'BET_NOT_FOUND', 'Bet not found');
    // not-found (row is null)
    enforceTenantScope(null, req as import('express').Request, res2, 'BET_NOT_FOUND', 'Bet not found');

    expect(ctx1.status).toBe(404);
    expect(ctx2.status).toBe(404);
    // Bodies MUST be byte-identical — no existence leak
    expect(JSON.stringify(ctx1.body)).toBe(JSON.stringify(ctx2.body));
  });

  it('returns false + sends 401 when req.operator is missing (defensive branch)', () => {
    // This branch should never happen in production (verifyOperatorSignature guards
    // all routes), but the defensive code must behave correctly.
    const req = mockReq(undefined); // no operator on request
    const ctx = { status: null as number | null, body: undefined as unknown };
    const res = {
      status(code: number) { ctx.status = code; return this; },
      json(body: unknown) { ctx.body = body; return this; },
    } as unknown as import('express').Response;

    const result = enforceTenantScope(
      'op-a',
      req as import('express').Request,
      res,
      'NOT_FOUND',
      'not found',
    );
    expect(result).toBe(false);
    expect(ctx.status).toBe(401);
    expect((ctx.body as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');
  });
});
