/**
 * Unit tests for verifyOperatorSignature middleware (Task 2.1).
 *
 * Pure unit test — no HTTP server, no operator stub.
 * Uses an in-memory OperatorRegistry and injectable clock/NonceCache for determinism.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import Database from 'better-sqlite3';
import { OperatorRegistry, NonceCache, sign } from '@crash/wallet';
import type { Operator } from '@crash/wallet';
import {
  verifyOperatorSignature,
  type OperatorAuthedRequest,
} from './verify-operator-signature.js';

// ---------------------------------------------------------------------------
// Test clock (deterministic, injectable)
// ---------------------------------------------------------------------------

const FIXED_NOW_SECONDS = 1_700_000_000; // arbitrary fixed unix timestamp

// ---------------------------------------------------------------------------
// Fake Express helpers
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  jsonBody: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
}

function makeFakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    jsonBody: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res;
}

interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody?: Buffer;
  operator?: Operator;
}

function makeFakeReq(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    method: 'POST',
    path: '/op/balance',
    headers: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Request builder: creates a correctly-signed fake request
// ---------------------------------------------------------------------------

interface BuildSignedReqOpts {
  method?: string;
  path?: string;
  body?: Buffer;
  nonce?: string;
  timestamp?: number;
  apiKey: string;
  signingKey: Buffer;
  /** Override only the signature value (to test bad signatures). */
  overrideSignature?: string;
  /** Override only the rawBody (to test body tampering). */
  overrideRawBody?: Buffer;
}

function buildSignedReq(opts: BuildSignedReqOpts): FakeRequest {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/op/balance';
  const body = opts.body ?? Buffer.from(JSON.stringify({ playerId: 'pid-1' }));
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
  const timestamp = opts.timestamp ?? FIXED_NOW_SECONDS;

  const signature = sign(
    { method, path, timestamp, nonce, body },
    opts.signingKey,
  );

  return {
    method,
    path,
    headers: {
      'x-api-key': opts.apiKey,
      'x-timestamp': String(timestamp),
      'x-nonce': nonce,
      'x-signature': opts.overrideSignature ?? signature,
    },
    rawBody: opts.overrideRawBody ?? body,
  };
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

let registry: OperatorRegistry;
let operator: Operator;
let operatorApiKey: string;
let operatorSigningKey: Buffer;

/**
 * Creates a fresh in-memory registry + one operator before each test.
 * Also returns a shared NonceCache with the injectable clock so tests
 * control time deterministically.
 */
function freshSetup(): { sharedNonceCache: NonceCache } {
  const db = new Database(':memory:');
  registry = new OperatorRegistry(db);

  const { operator: op, credentials } = registry.create({
    operatorId: 'op-test-001',
    name: 'Test Operator',
    walletBaseUrl: 'http://localhost:4000',
    currencies: ['EUR'],
    status: 'active',
  });

  operator = op;
  operatorApiKey = credentials.apiKey;
  operatorSigningKey = Buffer.from(credentials.signingKeyBase64, 'base64');

  const sharedNonceCache = new NonceCache({
    ttlMs: 10 * 60 * 1000,
    clock: () => FIXED_NOW_SECONDS * 1000, // NonceCache uses ms
  });

  return { sharedNonceCache };
}

// ---------------------------------------------------------------------------
// Helper: run the middleware synchronously
// ---------------------------------------------------------------------------

async function runMiddleware(
  req: FakeRequest,
  opts: Parameters<typeof verifyOperatorSignature>[1],
): Promise<{ res: FakeResponse; nextCalled: boolean }> {
  const res = makeFakeRes();
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  const mw = verifyOperatorSignature(registry, opts);
  await new Promise<void>((resolve) => {
    mw(req as unknown as Request, res as unknown as Response, () => {
      next();
      resolve();
    });
    // If next wasn't called the middleware responded synchronously; resolve.
    if (!nextCalled) resolve();
  });

  return { res, nextCalled };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyOperatorSignature', () => {
  // ─── Test 1: happy path ──────────────────────────────────────────────────

  it('happy path: correctly signed request → next() called, req.operator populated', async () => {
    const { sharedNonceCache } = freshSetup();

    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
    });

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200); // status was never set by middleware
    expect((req as unknown as OperatorAuthedRequest).operator.operatorId).toBe(
      operator.operatorId,
    );
  });

  // ─── Test 2: missing header ──────────────────────────────────────────────

  it('missing X-Signature → 401 INVALID_REQUEST, next not called', async () => {
    const { sharedNonceCache } = freshSetup();

    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
    });
    // Remove the signature header
    delete (req.headers as Record<string, string | undefined>)['x-signature'];

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  // ─── Test 3: unknown API key ─────────────────────────────────────────────

  it('unknown apiKey → 401 INVALID_SIGNATURE, next not called', async () => {
    const { sharedNonceCache } = freshSetup();

    const req = buildSignedReq({
      apiKey: 'ak_live_doesnotexist',
      signingKey: operatorSigningKey, // signing key doesn't matter — key lookup fails first
    });

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');
  });

  // ─── Test 4: bad signature ───────────────────────────────────────────────

  it('bad signature (wrong key) → 401 INVALID_SIGNATURE, next not called', async () => {
    const { sharedNonceCache } = freshSetup();

    const wrongKey = Buffer.alloc(32, 0xde); // random wrong key
    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: wrongKey, // signed with wrong key
    });

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');
  });

  // ─── Test 5: body tamper ─────────────────────────────────────────────────

  it('body tamper: signed over body A, delivered rawBody B → 401 INVALID_SIGNATURE', async () => {
    const { sharedNonceCache } = freshSetup();

    const originalBody = Buffer.from(JSON.stringify({ playerId: 'pid-1' }));
    const tamperedBody = Buffer.from(JSON.stringify({ playerId: 'pid-EVIL' }));

    // Sign over originalBody but deliver tamperedBody
    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      body: originalBody,
      overrideRawBody: tamperedBody,
    });

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');
  });

  // ─── Test 6: stale timestamp ─────────────────────────────────────────────

  it('stale timestamp (>300s) → 401 STALE_REQUEST; timestamp at exactly 300s is accepted', async () => {
    const { sharedNonceCache } = freshSetup();

    // Stale: timestamp = now - 301
    const staleTs = FIXED_NOW_SECONDS - 301;
    const staleReq = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      timestamp: staleTs,
    });

    const { res: staleRes, nextCalled: staleNext } = await runMiddleware(staleReq, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(staleNext).toBe(false);
    expect(staleRes.statusCode).toBe(401);
    expect((staleRes.jsonBody as { error: { code: string } }).error.code).toBe('STALE_REQUEST');

    // Boundary: timestamp = now - 300 (exactly at limit — should be accepted)
    // Use a fresh nonce cache so the boundary test has its own nonce
    const boundaryCacheMs = new NonceCache({
      clock: () => FIXED_NOW_SECONDS * 1000,
    });
    const boundaryTs = FIXED_NOW_SECONDS - 300;
    const boundaryReq = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      timestamp: boundaryTs,
      nonce: 'boundary-nonce-unique',
    });

    const { res: boundaryRes, nextCalled: boundaryNext } = await runMiddleware(boundaryReq, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: boundaryCacheMs,
    });

    expect(boundaryNext).toBe(true);
    expect(boundaryRes.statusCode).toBe(200);
  });

  // ─── Test 7: replayed nonce ──────────────────────────────────────────────

  it('replayed nonce: first call succeeds, second → 401 NONCE_REUSED', async () => {
    const { sharedNonceCache } = freshSetup();
    const fixedNonce = 'nonce-replay-test-fixed';

    // First request — should succeed
    const req1 = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      nonce: fixedNonce,
    });

    const { res: res1, nextCalled: next1 } = await runMiddleware(req1, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(next1).toBe(true);
    expect(res1.statusCode).toBe(200);

    // Second request — same nonce, same shared cache → NONCE_REUSED
    const req2 = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      nonce: fixedNonce,
    });

    const { res: res2, nextCalled: next2 } = await runMiddleware(req2, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(next2).toBe(false);
    expect(res2.statusCode).toBe(401);
    expect((res2.jsonBody as { error: { code: string } }).error.code).toBe('NONCE_REUSED');
  });

  it('bad-sig request does NOT poison nonce: attacker sends bad-sig, real request with same nonce still succeeds', async () => {
    const { sharedNonceCache } = freshSetup();
    const contestedNonce = 'nonce-contested-by-attacker';

    // Attacker sends invalid signature with the nonce
    const attackerReq = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: Buffer.alloc(32, 0xff), // wrong key → INVALID_SIGNATURE
      nonce: contestedNonce,
    });

    const { res: attackRes, nextCalled: attackNext } = await runMiddleware(attackerReq, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(attackNext).toBe(false);
    expect((attackRes.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');

    // Real operator now sends valid request with the same nonce — must succeed
    // (nonce cache was NOT poisoned because replay check is AFTER sig verify)
    const realReq = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey, // correct key
      nonce: contestedNonce,
    });

    const { res: realRes, nextCalled: realNext } = await runMiddleware(realReq, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(realNext).toBe(true);
    expect(realRes.statusCode).toBe(200);
  });

  // ─── Test 8: paused operator ─────────────────────────────────────────────

  it('paused operator → 403 OPERATOR_PAUSED, next not called', async () => {
    const { sharedNonceCache } = freshSetup();

    // Pause the operator
    registry.update(operator.operatorId, { status: 'paused' });

    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
    });

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('OPERATOR_PAUSED');
  });

  it('sandbox operator → proceeds (next called)', async () => {
    // Create a sandbox operator specifically
    const db = new Database(':memory:');
    const sandboxRegistry = new OperatorRegistry(db);
    const { operator: sandboxOp, credentials: sandboxCreds } = sandboxRegistry.create({
      operatorId: 'op-sandbox-001',
      name: 'Sandbox Operator',
      walletBaseUrl: 'http://localhost:4000',
      currencies: ['EUR'],
      status: 'sandbox',
    });

    const sandboxApiKey = sandboxCreds.apiKey;
    const sandboxSigningKey = Buffer.from(sandboxCreds.signingKeyBase64, 'base64');

    const sandboxNonceCache = new NonceCache({
      clock: () => FIXED_NOW_SECONDS * 1000,
    });

    const req = buildSignedReq({
      apiKey: sandboxApiKey,
      signingKey: sandboxSigningKey,
    });

    let sandboxNextCalled = false;
    const mw = verifyOperatorSignature(sandboxRegistry, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sandboxNonceCache,
    });

    await new Promise<void>((resolve) => {
      mw(req as unknown as Request, makeFakeRes() as unknown as Response, () => {
        sandboxNextCalled = true;
        resolve();
      });
      if (sandboxNextCalled) resolve();
    });

    expect(sandboxNextCalled).toBe(true);
    expect((req as unknown as OperatorAuthedRequest).operator.operatorId).toBe(
      sandboxOp.operatorId,
    );
  });

  // ─── Test 11: rawBody absent → fail closed ───────────────────────────────

  it('rawBody absent: falls back to empty body hash → 401 INVALID_SIGNATURE, next not called', async () => {
    const { sharedNonceCache } = freshSetup();

    // Build a correctly-signed request (with a real body)
    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      body: Buffer.from(JSON.stringify({ playerId: 'pid-1' })),
    });

    // Remove rawBody so the default extractor falls back to Buffer.alloc(0)
    delete (req as Record<string, unknown>)['rawBody'];

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    // The empty-body hash ≠ the signed body hash → verify fails → fail closed
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');
  });

  // ─── Test 12: array-typed header → INVALID_REQUEST ──────────────────────

  it('array-typed header (x-signature is string[]): 401 INVALID_REQUEST, next not called', async () => {
    const { sharedNonceCache } = freshSetup();

    const req = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
    });

    // Express delivers duplicated headers as string[]; simulate that
    (req.headers as Record<string, unknown>)['x-signature'] = ['a', 'b'];

    const { res, nextCalled } = await runMiddleware(req, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: sharedNonceCache,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  // ─── Test 13: getSignedPath option is honored ────────────────────────────

  it('getSignedPath: injected extractor is used; default req.path fails the same request', async () => {
    const { sharedNonceCache } = freshSetup();

    // Operator signs for the FULL external path /op/balance
    const fullPath = '/op/balance';
    const routerRelativePath = '/balance';
    const originalUrl = '/op/balance?x=1';

    // Build signed req: signed over fullPath but req.path is router-relative
    const signedForFullPath = buildSignedReq({
      apiKey: operatorApiKey,
      signingKey: operatorSigningKey,
      path: fullPath, // sign over the full path
      nonce: 'nonce-getSignedPath-test',
    });

    // Simulate sub-Router: req.path is router-relative, but originalUrl has the full path
    (signedForFullPath as Record<string, unknown>)['path'] = routerRelativePath;
    (signedForFullPath as Record<string, unknown>)['originalUrl'] = originalUrl;

    // Without getSignedPath option: uses req.path ('/balance') → mismatch → 401
    const nonceCacheA = new NonceCache({ clock: () => FIXED_NOW_SECONDS * 1000 });
    const { res: resDefault, nextCalled: nextDefault } = await runMiddleware(signedForFullPath, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: nonceCacheA,
    });

    expect(nextDefault).toBe(false);
    expect(resDefault.statusCode).toBe(401);
    expect((resDefault.jsonBody as { error: { code: string } }).error.code).toBe('INVALID_SIGNATURE');

    // With getSignedPath option: reconstructs full path from originalUrl → matches → success
    const nonceCacheB = new NonceCache({ clock: () => FIXED_NOW_SECONDS * 1000 });
    const { res: resFixed, nextCalled: nextFixed } = await runMiddleware(signedForFullPath, {
      nowSeconds: () => FIXED_NOW_SECONDS,
      nonceCache: nonceCacheB,
      getSignedPath: (r) => (r as unknown as { originalUrl: string }).originalUrl.split('?')[0],
    });

    expect(nextFixed).toBe(true);
    expect(resFixed.statusCode).toBe(200);
    expect((signedForFullPath as unknown as OperatorAuthedRequest).operator.operatorId).toBe(
      operator.operatorId,
    );
  });
});
