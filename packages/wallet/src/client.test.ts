import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { WalletClient } from './client.js';
import { WalletError, WalletNetworkError, ResponseSignatureError } from './errors.js';
import { sign, signResponse, verify } from './signing.js';
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

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
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
