import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { WalletClient } from './client.js';
import { WalletError, WalletNetworkError, ResponseSignatureError } from './errors.js';
import { sign, signResponse, verify } from './signing.js';
import { IdempotencyMismatchError } from './bet-log.js';
import { PgBetLog } from './bet-log-pg.js';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import type { Operator } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** 32-byte signing key shared between client fixture and mock server. */
const TEST_KEY = Buffer.from('abcdef0123456789abcdef0123456789');  // exactly 32 bytes

const TEST_OPERATOR: Operator = {
  operatorId: 'test-op',
  name: 'Test Operator',
  walletBaseUrl: 'http://op.test',
  apiKey: 'ak-test-key',
  signingKey: TEST_KEY,
  adapter: 'native',
  currencies: ['EUR'],
  minBetMinor: 10,
  maxBetMinor: 500000,
  rtpVariant: 97.0,
  jurisdictions: ['MT'],
  status: 'sandbox',
  createdAt: 1700000000,
  updatedAt: 1700000000,
};

/** Signs a response body the same way the operator stub does (spec §4.3).
 *  Uses the request's X-Timestamp that was sent in the request. */
function makeSignedResponse(
  status: number,
  body: object | null,
  requestTimestamp: number,
): { body: string; headers: Record<string, string> } {
  const bodyStr = body !== null ? JSON.stringify(body) : '';
  const bodyBuf = Buffer.from(bodyStr);
  const sig = signResponse({ status, timestamp: requestTimestamp, body: bodyBuf }, TEST_KEY);
  return {
    body: bodyStr,
    headers: { 'Content-Type': 'application/json', 'X-Signature': sig },
  };
}

/** Sign a 204 response (empty body) */
function makeSigned204Response(requestTimestamp: number): { headers: Record<string, string> } {
  const emptyBuf = Buffer.alloc(0);
  const sig = signResponse({ status: 204, timestamp: requestTimestamp, body: emptyBuf }, TEST_KEY);
  return { headers: { 'X-Signature': sig } };
}

// ---------------------------------------------------------------------------
// Captured-request helper
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: number;
  nonce: string;
}

// ---------------------------------------------------------------------------
// MSW server setup
// ---------------------------------------------------------------------------

const server = setupServer();

// Track PgBetLog test databases created per test so we can drop them after.
const testDbs: TestDb[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(async () => {
  server.resetHandlers();
  await Promise.all(testDbs.splice(0).map((db) => db.cleanup()));
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Fake sleep that records delays without actually waiting
// ---------------------------------------------------------------------------

function makeFakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

// ---------------------------------------------------------------------------
// Build a WalletClient with test fixtures and a deterministic nonce sequence
// ---------------------------------------------------------------------------

let nonceCounter = 0;

function makeClient(opts?: {
  sleep?: (ms: number) => Promise<void>;
  nowSeconds?: () => number;
  maxRollbackAttempts?: number;
  fetchImpl?: typeof fetch;
}) {
  nonceCounter = 0;
  return new WalletClient(TEST_OPERATOR, {
    generateNonce: () => `nonce-${++nonceCounter}`,
    nowSeconds: opts?.nowSeconds ?? (() => 1716000000),
    sleep: opts?.sleep,
    maxRollbackAttempts: opts?.maxRollbackAttempts,
    fetchImpl: opts?.fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Helpers to build captured request info from the msw Request object
// ---------------------------------------------------------------------------

async function captureRequest(req: Request): Promise<CapturedRequest> {
  const url = req.url;
  const method = req.method;
  const body = await req.json().catch(() => null);
  const timestamp = parseInt(req.headers.get('x-timestamp') ?? '0', 10);
  const nonce = req.headers.get('x-nonce') ?? '';
  const headers: Record<string, string> = {};
  req.headers.forEach((val, key) => { headers[key] = val; });
  return { url, method, headers, body, timestamp, nonce };
}

const FIXED_TIMESTAMP = 1716000000;

// ---------------------------------------------------------------------------
// Bet request / response fixtures
// ---------------------------------------------------------------------------

const BET_REQ = {
  playerId: 'pid-1',
  sessionId: 'ses-abc',
  roundId: 'rnd-001',
  betId: 'bet-001',
  txnId: 'txn-001',
  amountMinor: 1000,
  currency: 'EUR',
  gameId: 'galaxy-crash',
  placedAt: 1716000010,
};

const BET_RESP_BODY = {
  operatorTxnId: 'op-tx-001',
  balanceMinor: 99000,
  currency: 'EUR',
};

// ---------------------------------------------------------------------------
// Test 1: Happy bet — handler returns correctly signed 200; client resolves
// ---------------------------------------------------------------------------

it('happy bet — signed 200 resolves with correct shape and valid request signature', async () => {
  const captured: CapturedRequest[] = [];

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      const cap = await captureRequest(request);
      captured.push(cap);
      const signed = makeSignedResponse(200, BET_RESP_BODY, cap.timestamp);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const client = makeClient();
  const result = await client.bet(BET_REQ);

  expect(result).toEqual(BET_RESP_BODY);
  expect(captured).toHaveLength(1);

  // Verify the intercepted request had a valid X-Signature
  const cap = captured[0];
  const bodyBytes = Buffer.from(JSON.stringify(BET_REQ));
  const valid = verify(
    {
      method: 'POST',
      path: '/bet',
      timestamp: cap.timestamp,
      nonce: cap.nonce,
      body: bodyBytes,
      signature: cap.headers['x-signature'],
    },
    TEST_KEY,
  );
  expect(valid).toBe(true);

  // Body round-trips
  expect(cap.body).toMatchObject({ txnId: 'txn-001', amountMinor: 1000 });
});

// ---------------------------------------------------------------------------
// Test 2: 5xx then ok — resolves after retry with correct backoff recorded
// ---------------------------------------------------------------------------

it('5xx then ok — bet resolves on attempt 2; backoff 500ms recorded', async () => {
  let attempts = 0;
  const { sleep, delays } = makeFakeSleep();

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      attempts++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);

      if (attempts === 1) {
        const errBody = { error: { code: 'UPSTREAM_ERROR', message: 'Upstream down' } };
        const signed = makeSignedResponse(500, errBody, ts);
        return HttpResponse.json(errBody, { status: 500, headers: signed.headers });
      }

      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const client = makeClient({ sleep });
  const result = await client.bet(BET_REQ);

  expect(result).toEqual(BET_RESP_BODY);
  expect(attempts).toBe(2);
  expect(delays).toEqual([500]);
});

// ---------------------------------------------------------------------------
// Test 3: 5xx exhaust — rejects after 4 attempts (bet maxAttempts); backoff [500, 1500, 4000]
// ---------------------------------------------------------------------------

it('5xx exhaust — bet rejects after 4 attempts with retryable error and correct backoff sequence', async () => {
  let attempts = 0;
  const { sleep, delays } = makeFakeSleep();

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      attempts++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const errBody = { error: { code: 'UPSTREAM_ERROR', message: 'Down' } };
      const signed = makeSignedResponse(500, errBody, ts);
      return HttpResponse.json(errBody, { status: 500, headers: signed.headers });
    }),
  );

  const client = makeClient({ sleep });
  await expect(client.bet(BET_REQ)).rejects.toMatchObject({
    retryable: true,
    code: 'UPSTREAM_ERROR',
  });

  expect(attempts).toBe(4);
  expect(delays).toEqual([500, 1500, 4000]);
});

// ---------------------------------------------------------------------------
// Test 4: 409 INSUFFICIENT_FUNDS — non-retryable, 1 attempt, balanceMinor present
// ---------------------------------------------------------------------------

it('409 INSUFFICIENT_FUNDS — rejects immediately with non-retryable WalletError; balanceMinor set', async () => {
  let attempts = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      attempts++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const errBody = {
        error: { code: 'INSUFFICIENT_FUNDS', message: 'Balance 50 < bet 100', balanceMinor: 50 },
      };
      const signed = makeSignedResponse(409, errBody, ts);
      return HttpResponse.json(errBody, { status: 409, headers: signed.headers });
    }),
  );

  const client = makeClient();
  const err = await client.bet(BET_REQ).catch((e) => e);

  expect(err).toBeInstanceOf(WalletError);
  expect(err.code).toBe('INSUFFICIENT_FUNDS');
  expect(err.retryable).toBe(false);
  expect(err.balanceMinor).toBe(50);
  expect(err.httpStatus).toBe(409);
  expect(attempts).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 5: Timeout retried — simulate timeout by using a custom fetch that fails on first call
// ---------------------------------------------------------------------------

it('timeout retried — network error on attempt 1, success on attempt 2', async () => {
  let attempts = 0;
  const { sleep, delays } = makeFakeSleep();

  // We simulate a network/abort error by having a custom fetchImpl that throws on the first call
  const baseFetch = globalThis.fetch.bind(globalThis);
  let serverHandlerTimestamp = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      attempts++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      serverHandlerTimestamp = ts;
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  let fetchCallCount = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      throw new Error('The operation was aborted.');  // simulate timeout/abort
    }
    return baseFetch(input, init);
  };

  const client = makeClient({ sleep, fetchImpl: mockFetch });
  const result = await client.bet(BET_REQ);

  expect(result).toEqual(BET_RESP_BODY);
  expect(fetchCallCount).toBe(2);
  expect(delays).toEqual([500]);  // first bet retry backoff
  expect(attempts).toBe(1);  // only 1 request reached the server
});

// ---------------------------------------------------------------------------
// Test 6: Request signature valid — recompute and assert X-Signature matches
// ---------------------------------------------------------------------------

it('request signature valid — X-Signature matches recomputed value (spec §4.2 compliance)', async () => {
  const captured: CapturedRequest[] = [];

  server.use(
    http.post('http://op.test/balance', async ({ request }) => {
      const cap = await captureRequest(request);
      captured.push(cap);
      const respBody = { balance: 100000, currency: 'EUR' };
      const signed = makeSignedResponse(200, respBody, cap.timestamp);
      return HttpResponse.json(respBody, { headers: signed.headers });
    }),
  );

  const client = makeClient();
  await client.balance({ playerId: 'pid-1', sessionId: 'ses-1' });

  const cap = captured[0];
  const expectedSig = sign(
    {
      method: 'POST',
      path: '/balance',
      timestamp: cap.timestamp,
      nonce: cap.nonce,
      body: Buffer.from(JSON.stringify({ playerId: 'pid-1', sessionId: 'ses-1' })),
    },
    TEST_KEY,
  );

  expect(cap.headers['x-signature']).toBe(expectedSig);
});

// ---------------------------------------------------------------------------
// Test 7: txnId constant across retries — idempotency property per spec §9
// ---------------------------------------------------------------------------

it('txnId constant across retries — body txnId identical on all attempts, X-Nonce differs', async () => {
  let attempts = 0;
  const capturedBodies: { txnId: string; nonce: string }[] = [];
  const { sleep } = makeFakeSleep();

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      attempts++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const nonce = request.headers.get('x-nonce') ?? '';
      const body = await request.json() as { txnId: string };
      capturedBodies.push({ txnId: body.txnId, nonce });

      if (attempts === 1) {
        const errBody = { error: { code: 'UPSTREAM_ERROR', message: 'Down' } };
        const signed = makeSignedResponse(500, errBody, ts);
        return HttpResponse.json(errBody, { status: 500, headers: signed.headers });
      }

      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const client = makeClient({ sleep });
  await client.bet(BET_REQ);

  expect(attempts).toBe(2);

  // txnId must be constant across both attempts (idempotency key)
  expect(capturedBodies[0].txnId).toBe('txn-001');
  expect(capturedBodies[1].txnId).toBe('txn-001');

  // Nonces MUST differ between retry attempts (each attempt is a fresh signed request)
  expect(capturedBodies[0].nonce).not.toBe(capturedBodies[1].nonce);
});

// ---------------------------------------------------------------------------
// Test 8: Bad response signature → ResponseSignatureError (non-retryable, 1 attempt)
// ---------------------------------------------------------------------------

it('bad response signature — ResponseSignatureError is thrown; non-retryable; 1 attempt; no backoff sleep', async () => {
  let attempts = 0;
  const { sleep, delays } = makeFakeSleep();

  server.use(
    http.post('http://op.test/bet', async () => {
      attempts++;
      return HttpResponse.json(BET_RESP_BODY, {
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': 'deadbeef'.repeat(8),  // wrong signature (64 hex chars of garbage)
        },
      });
    }),
  );

  const client = makeClient({ sleep });
  const err = await client.bet(BET_REQ).catch((e) => e);

  expect(err).toBeInstanceOf(ResponseSignatureError);
  expect(err.code).toBe('RESPONSE_SIGNATURE_INVALID');
  expect(err.retryable).toBe(false);
  expect(err.httpStatus).toBe(200);
  expect(attempts).toBe(1);
  expect(delays).toEqual([]);  // non-retryable: no backoff sleep must occur
});

// ---------------------------------------------------------------------------
// Test 9: roundEnd never throws — handler returns 500; client resolves to undefined
// ---------------------------------------------------------------------------

it('roundEnd never throws — 500 from operator; client resolves undefined; 1 attempt only', async () => {
  let attempts = 0;

  server.use(
    http.post('http://op.test/round-end', async ({ request }) => {
      attempts++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const errBody = { error: { code: 'UPSTREAM_ERROR', message: 'Down' } };
      const signed = makeSignedResponse(500, errBody, ts);
      return HttpResponse.json(errBody, { status: 500, headers: signed.headers });
    }),
  );

  const client = makeClient();
  const result = await client.roundEnd({
    roundId: 'rnd-001',
    playerId: 'pid-1',
    crashPoint: 2.5,
    serverSeedHash: 'abc123',
    serverSeed: 'seed456',
    bets: [],
  });

  expect(result).toBeUndefined();
  expect(attempts).toBe(1);
});

// ---------------------------------------------------------------------------
// Additional test: authenticate happy path
// ---------------------------------------------------------------------------

it('authenticate — resolves with full player shape on signed 200', async () => {
  const authRespBody = {
    playerId: 'pid-1',
    displayName: 'lucky_falcon_42',
    currency: 'EUR',
    balance: 100000,
    country: 'MT',
    jurisdiction: 'MT',
    language: 'en',
    rgLimits: { maxBetMinor: 500000, sessionEndsAt: 1716050000 },
  };

  server.use(
    http.post('http://op.test/authenticate', async ({ request }) => {
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, authRespBody, ts);
      return HttpResponse.json(authRespBody, { headers: signed.headers });
    }),
  );

  const client = makeClient();
  const result = await client.authenticate({
    token: 'tok-pid-1',
    ip: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    gameId: 'galaxy-crash',
  });

  expect(result.playerId).toBe('pid-1');
  expect(result.currency).toBe('EUR');
  expect(result.balance).toBe(100000);
});

// ===========================================================================
// Idempotency tests — Task 2.2
// ===========================================================================

// Helper: make a WalletClient with a BetLog
function makeClientWithBetLog(betLog: PgBetLog, opts?: {
  sleep?: (ms: number) => Promise<void>;
  nowSeconds?: () => number;
  maxRollbackAttempts?: number;
}) {
  nonceCounter = 0;
  return new WalletClient(TEST_OPERATOR, {
    generateNonce: () => `nonce-${++nonceCounter}`,
    nowSeconds: opts?.nowSeconds ?? (() => 1716000000),
    sleep: opts?.sleep,
    maxRollbackAttempts: opts?.maxRollbackAttempts,
    betLog,
  });
}

// Fresh isolated Postgres-backed BetLog for each idempotency test
async function makeBetLog(): Promise<PgBetLog> {
  const db = await makeTestDb();
  testDbs.push(db);
  return new PgBetLog(db.pool);
}

// Win / rollback fixtures
const WIN_REQ = {
  playerId: 'pid-1',
  sessionId: 'ses-abc',
  roundId: 'rnd-001',
  betId: 'bet-001',
  betTxnId: 'txn-001',
  txnId: 'win-txn-001',
  amountMinor: 2000,
  multiplier: 2.0,
  currency: 'EUR',
  settledAt: 1716000100,
};

const WIN_RESP_BODY = {
  operatorTxnId: 'op-win-001',
  balanceMinor: 101000,
  currency: 'EUR',
};

const ROLLBACK_REQ = {
  playerId: 'pid-1',
  betTxnId: 'txn-001',
  txnId: 'rb-txn-001',
  reason: 'round_voided' as const,
};

const ROLLBACK_RESP_BODY = {
  operatorTxnId: 'op-rb-001',
  balanceMinor: 100000,
  currency: 'EUR',
  status: 'rolled_back' as const,
};

// ---------------------------------------------------------------------------
// Idempotency Test 1: no betLog — two identical calls with same txnId → 2 HTTP
// ---------------------------------------------------------------------------

it('no betLog passthrough — two calls with same txnId make 2 HTTP requests (no deduplication)', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const client = makeClient(); // no betLog
  const r1 = await client.bet(BET_REQ);
  const r2 = await client.bet(BET_REQ); // same txnId, no betLog → goes to operator again

  expect(r1).toEqual(BET_RESP_BODY);
  expect(r2).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(2); // proves no idempotency without betLog
});

// ---------------------------------------------------------------------------
// Idempotency Test 2: success short-circuits replay (same client, then fresh client)
// ---------------------------------------------------------------------------

it('success short-circuits replay — 2nd call skips HTTP; fresh client replays from DB', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  // First call — should hit HTTP
  const r1 = await client.bet(BET_REQ);
  expect(r1).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(1);

  // Second call (same client, same req) — must NOT hit HTTP
  const r2 = await client.bet(BET_REQ);
  expect(r2).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(1); // still 1

  // Fresh client (simulates crash/restart) with SAME betLog — must also skip HTTP
  const freshClient = makeClientWithBetLog(betLog);
  const r3 = await freshClient.bet(BET_REQ);
  expect(r3).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(1); // still 1 — proof of crash-restart safety
});

// ---------------------------------------------------------------------------
// Idempotency Test 3: confirmed rejection persists & replays as throw
// ---------------------------------------------------------------------------

it('confirmed rejection (409) persists and replays as throw with no additional HTTP', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const errBody = {
        error: { code: 'INSUFFICIENT_FUNDS', message: 'Balance 50 < bet 1000', balanceMinor: 50 },
      };
      const signed = makeSignedResponse(409, errBody, ts);
      return HttpResponse.json(errBody, { status: 409, headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  // First call — hits HTTP, stores confirmed rejection
  const err1 = await client.bet(BET_REQ).catch((e) => e);
  expect(err1).toBeInstanceOf(WalletError);
  expect(err1.code).toBe('INSUFFICIENT_FUNDS');
  expect(err1.httpStatus).toBe(409);
  expect(err1.balanceMinor).toBe(50);
  expect(callCount).toBe(1);

  // Second call — must short-circuit (no HTTP), reconstruct WalletError from cache
  const err2 = await client.bet(BET_REQ).catch((e) => e);
  expect(err2).toBeInstanceOf(WalletError);
  expect(err2.code).toBe('INSUFFICIENT_FUNDS');
  expect(err2.httpStatus).toBe(409);
  expect(err2.balanceMinor).toBe(50);
  expect(callCount).toBe(1); // counter unchanged — no HTTP made
});

// ---------------------------------------------------------------------------
// Idempotency Test 4: non-confirmed failure (5xx) does NOT persist; recovery can retry
// ---------------------------------------------------------------------------

it('non-confirmed failure (5xx) does not persist — recovery can retry freely', async () => {
  let callCount = 0;
  const { sleep } = makeFakeSleep(); // instant backoff

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const errBody = { error: { code: 'UPSTREAM_ERROR', message: 'Down' } };
      const signed = makeSignedResponse(500, errBody, ts);
      return HttpResponse.json(errBody, { status: 500, headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog, { sleep, maxRollbackAttempts: 1 });

  // First round: 4 attempts (bet maxAttempts)
  await client.bet(BET_REQ).catch(() => {});
  const afterFirstRound = callCount;
  expect(afterFirstRound).toBe(4); // bet exhausts 4 attempts

  // Must NOT have persisted an idempotency row
  expect(await betLog.getIdempotency(TEST_OPERATOR.operatorId, BET_REQ.txnId)).toBeNull();

  // Second round: same txnId+body → makes NEW HTTP calls (no short-circuit)
  await client.bet(BET_REQ).catch(() => {});
  expect(callCount).toBeGreaterThan(afterFirstRound); // counter increased
});

// ---------------------------------------------------------------------------
// Idempotency Test 5: divergent body (same txnId) → IdempotencyMismatchError, no send
// ---------------------------------------------------------------------------

it('divergent body with same txnId → IdempotencyMismatchError; no additional HTTP call', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  // First call: succeeds (txnId = 'txn-001', amountMinor = 1000)
  await client.bet(BET_REQ);
  expect(callCount).toBe(1);

  // Second call: same txnId but different amountMinor → mismatch
  const reqB = { ...BET_REQ, amountMinor: 9999 };
  const err = await client.bet(reqB).catch((e) => e);
  expect(err).toBeInstanceOf(IdempotencyMismatchError);
  expect(callCount).toBe(1); // no HTTP was sent for the divergent request
});

// ---------------------------------------------------------------------------
// Idempotency Test 6a: win success persists and replays without HTTP
// ---------------------------------------------------------------------------

it('win success persists and replays without HTTP', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/win', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, WIN_RESP_BODY, ts);
      return HttpResponse.json(WIN_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  const r1 = await client.win(WIN_REQ);
  expect(r1).toEqual(WIN_RESP_BODY);
  expect(callCount).toBe(1);

  // Replay: must not hit HTTP
  const r2 = await client.win(WIN_REQ);
  expect(r2).toEqual(WIN_RESP_BODY);
  expect(callCount).toBe(1); // no additional HTTP

  // Verify row stored with kind='win' and correct txnId
  const entry = await betLog.getIdempotency(TEST_OPERATOR.operatorId, WIN_REQ.txnId);
  expect(entry).not.toBeNull();
  expect(entry!.kind).toBe('win');
  expect(entry!.txnId).toBe(WIN_REQ.txnId);
});

// ---------------------------------------------------------------------------
// Idempotency Test 6b: rollback success persists and replays without HTTP
// ---------------------------------------------------------------------------

it('rollback success persists and replays without HTTP', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/rollback', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, ROLLBACK_RESP_BODY, ts);
      return HttpResponse.json(ROLLBACK_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog, { maxRollbackAttempts: 4 });

  const r1 = await client.rollback(ROLLBACK_REQ);
  expect(r1).toEqual(ROLLBACK_RESP_BODY);
  expect(callCount).toBe(1);

  // Replay: must not hit HTTP
  const r2 = await client.rollback(ROLLBACK_REQ);
  expect(r2).toEqual(ROLLBACK_RESP_BODY);
  expect(callCount).toBe(1); // no additional HTTP

  // Verify row stored with kind='rollback' and correct txnId
  const entry = await betLog.getIdempotency(TEST_OPERATOR.operatorId, ROLLBACK_REQ.txnId);
  expect(entry).not.toBeNull();
  expect(entry!.kind).toBe('rollback');
  expect(entry!.txnId).toBe(ROLLBACK_REQ.txnId);
});

// ---------------------------------------------------------------------------
// Idempotency Test 7: authenticate/balance/roundEnd with betLog — 2 HTTP each, no idempotency rows
// ---------------------------------------------------------------------------

it('authenticate and roundEnd with betLog — no idempotency rows written; 2 HTTP calls each', async () => {
  let authCount = 0;
  let roundEndCount = 0;

  const authRespBody = {
    playerId: 'pid-1',
    displayName: 'lucky_falcon_42',
    currency: 'EUR',
    balance: 100000,
    country: 'MT',
    jurisdiction: 'MT',
    language: 'en',
    rgLimits: { maxBetMinor: 500000, sessionEndsAt: 1716050000 },
  };

  server.use(
    http.post('http://op.test/authenticate', async ({ request }) => {
      authCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, authRespBody, ts);
      return HttpResponse.json(authRespBody, { headers: signed.headers });
    }),
    http.post('http://op.test/round-end', async ({ request }) => {
      roundEndCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const emptyBuf = Buffer.alloc(0);
      const { signResponse: _sr, ...signing } = await import('./signing.js');
      const sig = _sr({ status: 204, timestamp: ts, body: emptyBuf }, TEST_KEY);
      return new HttpResponse(null, { status: 204, headers: { 'X-Signature': sig } });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  const authReq = { token: 'tok-1', ip: '1.2.3.4', userAgent: 'Mozilla/5.0', gameId: 'galaxy-crash' };
  const roundEndReq = {
    roundId: 'rnd-001', playerId: 'pid-1', crashPoint: 2.5,
    serverSeedHash: 'abc', serverSeed: 'xyz', bets: [],
  };

  // Call authenticate twice — must make 2 HTTP calls (no idempotency)
  await client.authenticate(authReq);
  await client.authenticate(authReq);
  expect(authCount).toBe(2);

  // Call roundEnd twice — must make 2 HTTP calls (no idempotency)
  await client.roundEnd(roundEndReq);
  await client.roundEnd(roundEndReq);
  expect(roundEndCount).toBe(2);

  // No idempotency rows at all
  // (authenticate/roundEnd have no txnId; we verify the table is empty)
  const pool = (betLog as unknown as { pool: import('pg').Pool }).pool;
  const { rows } = await pool.query('SELECT * FROM txn_idempotency');
  expect(rows).toHaveLength(0);
});

// ===========================================================================
// Task 2.2 review hardening tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Review Test a: success-path putIdempotency failure does NOT mask success
// ---------------------------------------------------------------------------

it('success persistence failure does NOT mask success — bet resolves even when putIdempotency throws', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  // Stub betLog: getIdempotency returns null (no existing record), putIdempotency throws
  const stubbedBetLog: PgBetLog = {
    getIdempotency: (_operatorId: string, _txnId: string) => null,
    putIdempotency: (_entry: unknown) => { throw new Error('DB write failed'); },
  } as unknown as PgBetLog;

  nonceCounter = 0;
  const client = new WalletClient(TEST_OPERATOR, {
    generateNonce: () => `nonce-${++nonceCounter}`,
    nowSeconds: () => 1716000000,
    betLog: stubbedBetLog,
  });

  // Must resolve (not reject) despite persistence failure
  const result = await client.bet(BET_REQ);
  expect(result).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(1); // exactly 1 HTTP call
});

// ---------------------------------------------------------------------------
// Review Test b: confirmed-rejection persistence failure still throws the ORIGINAL WalletError
// ---------------------------------------------------------------------------

it('confirmed-rejection persistence failure — original WalletError propagates unchanged (not persistence error)', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const errBody = {
        error: { code: 'INSUFFICIENT_FUNDS', message: 'Balance 50 < bet 1000', balanceMinor: 50 },
      };
      const signed = makeSignedResponse(409, errBody, ts);
      return HttpResponse.json(errBody, { status: 409, headers: signed.headers });
    }),
  );

  // Stub betLog: getIdempotency returns null, putIdempotency throws
  const stubbedBetLog: PgBetLog = {
    getIdempotency: (_operatorId: string, _txnId: string) => null,
    putIdempotency: (_entry: unknown) => { throw new Error('DB write failed'); },
  } as unknown as PgBetLog;

  nonceCounter = 0;
  const client = new WalletClient(TEST_OPERATOR, {
    generateNonce: () => `nonce-${++nonceCounter}`,
    nowSeconds: () => 1716000000,
    betLog: stubbedBetLog,
  });

  const err = await client.bet(BET_REQ).catch((e) => e);

  // Must be the original WalletError, not the persistence error, not IdempotencyMismatchError
  expect(err).toBeInstanceOf(WalletError);
  expect(err.code).toBe('INSUFFICIENT_FUNDS');
  expect(err.httpStatus).toBe(409);
  expect(err.balanceMinor).toBe(50);
  expect(callCount).toBe(1); // exactly 1 HTTP call
});

// ---------------------------------------------------------------------------
// Review Test c: replay differing ONLY in volatile timing fields short-circuits (no IdempotencyMismatchError)
// ---------------------------------------------------------------------------

it('replay differing only in placedAt short-circuits to cached BetResponse (no IdempotencyMismatchError)', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  // First call succeeds (1 HTTP call)
  const r1 = await client.bet(BET_REQ);
  expect(r1).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(1);

  // Second call: same txnId + everything except placedAt (different timestamp)
  const reqB = { ...BET_REQ, placedAt: BET_REQ.placedAt + 9999 };
  // Must short-circuit to cached result without new HTTP call or IdempotencyMismatchError
  const r2 = await client.bet(reqB);
  expect(r2).toEqual(BET_RESP_BODY);
  expect(callCount).toBe(1); // no new HTTP call — served from cache
});

it('replay differing only in settledAt short-circuits to cached WinResponse (no IdempotencyMismatchError)', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/win', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, WIN_RESP_BODY, ts);
      return HttpResponse.json(WIN_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  // First call succeeds (1 HTTP call)
  const r1 = await client.win(WIN_REQ);
  expect(r1).toEqual(WIN_RESP_BODY);
  expect(callCount).toBe(1);

  // Replay with different settledAt (as recovery.ts would produce with Date.now())
  const winReqReplay = { ...WIN_REQ, settledAt: WIN_REQ.settledAt + 5000 };
  const r2 = await client.win(winReqReplay);
  expect(r2).toEqual(WIN_RESP_BODY);
  expect(callCount).toBe(1); // no new HTTP call — served from cache
});

// ---------------------------------------------------------------------------
// Review Test d: genuine different-transaction (same txnId, different amountMinor) still caught
// ---------------------------------------------------------------------------

it('genuine different-transaction (same txnId, different amountMinor) still throws IdempotencyMismatchError', async () => {
  let callCount = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCount++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, BET_RESP_BODY, ts);
      return HttpResponse.json(BET_RESP_BODY, { headers: signed.headers });
    }),
  );

  const betLog = await makeBetLog();
  const client = makeClientWithBetLog(betLog);

  // First call: succeeds (txnId = 'txn-001', amountMinor = 1000)
  await client.bet(BET_REQ);
  expect(callCount).toBe(1);

  // Second call: same txnId but DIFFERENT amountMinor — real caller bug
  const reqC = { ...BET_REQ, amountMinor: 5555 };
  const err = await client.bet(reqC).catch((e) => e);
  expect(err).toBeInstanceOf(IdempotencyMismatchError);
  expect(callCount).toBe(1); // no additional HTTP call was made
});

// ---------------------------------------------------------------------------
// Spec §9 cross-operator isolation: two operators, same txnId → independent rows
// ---------------------------------------------------------------------------

it('spec §9 cross-operator isolation — two operators with same txnId persist independently, each replays its own row', async () => {
  // Operator B (different from TEST_OPERATOR which is 'test-op')
  const OP_B_KEY = Buffer.from('fedcba9876543210fedcba9876543210');  // different 32-byte key
  const OP_B: Operator = {
    operatorId: 'test-op-B',
    name: 'Test Operator B',
    walletBaseUrl: 'http://op-b.test',
    apiKey: 'ak-test-key-B',
    signingKey: OP_B_KEY,
    adapter: 'native',
    currencies: ['EUR'],
    minBetMinor: 10,
    maxBetMinor: 500000,
    rtpVariant: 97.0,
    jurisdictions: ['MT'],
    status: 'sandbox',
    createdAt: 1700000000,
    updatedAt: 1700000000,
  };

  const betReqSharedTxnId = { ...BET_REQ, txnId: 'cross-op-txn-shared' };

  const respBodyA = { operatorTxnId: 'op-A-tx-cross', balanceMinor: 99000, currency: 'EUR' };
  const respBodyB = { operatorTxnId: 'op-B-tx-cross', balanceMinor: 88000, currency: 'EUR' };

  let callCountA = 0;
  let callCountB = 0;

  server.use(
    http.post('http://op.test/bet', async ({ request }) => {
      callCountA++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      const signed = makeSignedResponse(200, respBodyA, ts);
      return HttpResponse.json(respBodyA, { headers: signed.headers });
    }),
    http.post('http://op-b.test/bet', async ({ request }) => {
      callCountB++;
      const ts = parseInt(request.headers.get('x-timestamp') ?? '0', 10);
      // Sign with op-B's key
      const bodyStr = JSON.stringify(respBodyB);
      const bodyBuf = Buffer.from(bodyStr);
      const sig = signResponse({ status: 200, timestamp: ts, body: bodyBuf }, OP_B_KEY);
      return HttpResponse.json(respBodyB, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig } });
    }),
  );

  // Both clients share the SAME betLog (the key invariant being tested)
  const betLog = await makeBetLog();

  let nonceCounterLocal = 0;
  const clientA = new WalletClient(TEST_OPERATOR, {
    generateNonce: () => `nonce-A-${++nonceCounterLocal}`,
    nowSeconds: () => 1716000000,
    betLog,
  });
  const clientB = new WalletClient(OP_B, {
    generateNonce: () => `nonce-B-${++nonceCounterLocal}`,
    nowSeconds: () => 1716000000,
    betLog,
  });

  // First call from each operator — both must make HTTP, no cross-contamination
  const rA1 = await clientA.bet(betReqSharedTxnId);
  const rB1 = await clientB.bet(betReqSharedTxnId);
  expect(rA1).toEqual(respBodyA);
  expect(rB1).toEqual(respBodyB);
  expect(callCountA).toBe(1); // op-A hit HTTP exactly once
  expect(callCountB).toBe(1); // op-B hit HTTP exactly once

  // Replay from each operator — must short-circuit to their OWN row, no new HTTP
  const rA2 = await clientA.bet(betReqSharedTxnId);
  const rB2 = await clientB.bet(betReqSharedTxnId);
  expect(rA2).toEqual(respBodyA); // op-A gets op-A's response
  expect(rB2).toEqual(respBodyB); // op-B gets op-B's response
  expect(callCountA).toBe(1); // still 1 — op-A's replay short-circuited
  expect(callCountB).toBe(1); // still 1 — op-B's replay short-circuited

  // Verify both rows exist in the DB, scoped to their respective operators
  const rowA = await betLog.getIdempotency(TEST_OPERATOR.operatorId, betReqSharedTxnId.txnId);
  const rowB = await betLog.getIdempotency(OP_B.operatorId, betReqSharedTxnId.txnId);
  expect(rowA).not.toBeNull();
  expect(rowB).not.toBeNull();
  expect(rowA!.operatorId).toBe(TEST_OPERATOR.operatorId);
  expect(rowB!.operatorId).toBe(OP_B.operatorId);
  // Responses are different — no cross-contamination
  expect(JSON.parse(rowA!.responseJson).value).toEqual(respBodyA);
  expect(JSON.parse(rowB!.responseJson).value).toEqual(respBodyB);
});
