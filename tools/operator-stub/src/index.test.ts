/**
 * Smoke tests for the operator stub server.
 * Uses supertest — no real network required.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { app, startServer, resetStubState } from './index.js';
import type { Server } from 'node:http';

// ---------------------------------------------------------------------------
// Signing helpers (mirror spec §4.2)
// ---------------------------------------------------------------------------

const KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLWZvcmRldg==';
const KEY = Buffer.from(KEY_B64, 'base64');
const API_KEY = 'test-operator';

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacHex(data: string): string {
  return crypto.createHmac('sha256', KEY).update(data).digest('hex');
}

function signedHeaders(method: string, path: string, body: object) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const bodyBytes = Buffer.from(JSON.stringify(body));
  const bodyHash = sha256Hex(bodyBytes);
  const sigString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = hmacHex(sigString);
  return {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server;

beforeAll(() => {
  server = startServer(0); // port 0 = OS-assigned
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resetStubState();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /authenticate', () => {
  it('happy path — returns player data for valid token', async () => {
    const body = { token: 'tok-pid-1', ip: '1.2.3.4', userAgent: 'test', gameId: 'galaxy-crash' };
    const res = await request(app)
      .post('/authenticate')
      .set(signedHeaders('POST', '/authenticate', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.playerId).toBe('pid-1');
    expect(res.body.currency).toBe('EUR');
    expect(res.body.displayName).toBe('lucky_falcon_42');
    expect(res.body.balance).toBe(100000);
    expect(res.body.rgLimits.maxBetMinor).toBe(500000);
    expect(res.headers['x-signature']).toBeTruthy();
  });

  it('returns 401 INVALID_TOKEN for unknown token', async () => {
    const body = { token: 'bad-token', ip: '1.2.3.4', userAgent: 'test', gameId: 'galaxy-crash' };
    const res = await request(app)
      .post('/authenticate')
      .set(signedHeaders('POST', '/authenticate', body))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('POST /bet', () => {
  it('returns 409 INSUFFICIENT_FUNDS when balance is too low', async () => {
    // pid-2 has 100000 minor; bet 200000
    const body = {
      playerId: 'pid-2',
      sessionId: 'ses-1',
      roundId: 'rnd-1',
      betId: 'bet-1',
      txnId: crypto.randomUUID(),
      amountMinor: 200000,
      currency: 'USD',
      gameId: 'galaxy-crash',
      placedAt: Math.floor(Date.now() / 1000),
    };
    const res = await request(app)
      .post('/bet')
      .set(signedHeaders('POST', '/bet', body))
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.error.balanceMinor).toBe(100000);
  });

  it('returns the same response on replay (idempotency)', async () => {
    const txnId = crypto.randomUUID();
    const body = {
      playerId: 'pid-1',
      sessionId: 'ses-2',
      roundId: 'rnd-2',
      betId: 'bet-2',
      txnId,
      amountMinor: 5000,
      currency: 'EUR',
      gameId: 'galaxy-crash',
      placedAt: Math.floor(Date.now() / 1000),
    };

    const headers1 = signedHeaders('POST', '/bet', body);
    const res1 = await request(app).post('/bet').set(headers1).send(body);
    expect(res1.status).toBe(200);

    // Replay with fresh nonce/timestamp but same txnId
    const headers2 = signedHeaders('POST', '/bet', body);
    const res2 = await request(app).post('/bet').set(headers2).send(body);
    expect(res2.status).toBe(200);

    // Same operatorTxnId and balance
    expect(res2.body.operatorTxnId).toBe(res1.body.operatorTxnId);
    expect(res2.body.balanceMinor).toBe(res1.body.balanceMinor);
  });
});

describe('POST /win', () => {
  it('credits player and returns 200 on happy path', async () => {
    // First place a bet to know starting balance
    const betTxnId = crypto.randomUUID();
    const betBody = {
      playerId: 'pid-1',
      sessionId: 'ses-3',
      roundId: 'rnd-3',
      betId: 'bet-3',
      txnId: betTxnId,
      amountMinor: 1000,
      currency: 'EUR',
      gameId: 'galaxy-crash',
      placedAt: Math.floor(Date.now() / 1000),
    };
    const betRes = await request(app)
      .post('/bet')
      .set(signedHeaders('POST', '/bet', betBody))
      .send(betBody);
    expect(betRes.status).toBe(200);
    const balanceAfterBet = betRes.body.balanceMinor as number;

    const winBody = {
      playerId: 'pid-1',
      sessionId: 'ses-3',
      roundId: 'rnd-3',
      betId: 'bet-3',
      betTxnId,
      txnId: crypto.randomUUID(),
      amountMinor: 2000,
      multiplier: 2.0,
      currency: 'EUR',
      settledAt: Math.floor(Date.now() / 1000),
    };
    const winRes = await request(app)
      .post('/win')
      .set(signedHeaders('POST', '/win', winBody))
      .send(winBody);

    expect(winRes.status).toBe(200);
    expect(winRes.body.balanceMinor).toBe(balanceAfterBet + 2000);
    expect(winRes.headers['x-signature']).toBeTruthy();
  });

  it('STUB_FAIL_NEXT_WIN — first call returns 500, retry with same txnId succeeds', async () => {
    // Place a bet first so there is a valid betTxnId
    const betTxnId = crypto.randomUUID();
    const betBody = {
      playerId: 'pid-2',
      sessionId: 'ses-4',
      roundId: 'rnd-4',
      betId: 'bet-4',
      txnId: betTxnId,
      amountMinor: 500,
      currency: 'USD',
      gameId: 'galaxy-crash',
      placedAt: Math.floor(Date.now() / 1000),
    };
    const betRes = await request(app)
      .post('/bet')
      .set(signedHeaders('POST', '/bet', betBody))
      .send(betBody);
    expect(betRes.status).toBe(200);

    // Arm the forced-failure flag at runtime — shouldFailNextWin() reads it lazily.
    process.env['STUB_FAIL_NEXT_WIN'] = '1';

    const winTxnId = crypto.randomUUID();
    const winBody = {
      playerId: 'pid-2',
      sessionId: 'ses-4',
      roundId: 'rnd-4',
      betId: 'bet-4',
      betTxnId,
      txnId: winTxnId,
      amountMinor: 750,
      multiplier: 1.5,
      currency: 'USD',
      settledAt: Math.floor(Date.now() / 1000),
    };

    // First call must return 500 — flag is consumed (one-shot).
    const failRes = await request(app)
      .post('/win')
      .set(signedHeaders('POST', '/win', winBody))
      .send(winBody);
    expect(failRes.status).toBe(500);
    expect(failRes.body.error.code).toBe('UPSTREAM_ERROR');

    // Retry with the same txnId — failure was NOT cached, so this must succeed.
    const retryRes = await request(app)
      .post('/win')
      .set(signedHeaders('POST', '/win', winBody))
      .send(winBody);
    expect(retryRes.status).toBe(200);

    // Guard: flag should already be consumed; clean up just in case.
    delete process.env['STUB_FAIL_NEXT_WIN'];
  });
});

describe('POST /rollback', () => {
  it('noop for unknown betTxnId', async () => {
    const body = {
      playerId: 'pid-1',
      betTxnId: crypto.randomUUID(),
      txnId: crypto.randomUUID(),
      reason: 'round_voided',
    };
    const res = await request(app)
      .post('/rollback')
      .set(signedHeaders('POST', '/rollback', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('noop');
    expect(res.body.operatorTxnId).toBe('op-tx-noop');
  });

  it('credits back the original bet amount', async () => {
    const betTxnId = crypto.randomUUID();
    const betBody = {
      playerId: 'pid-3',
      sessionId: 'ses-5',
      roundId: 'rnd-5',
      betId: 'bet-5',
      txnId: betTxnId,
      amountMinor: 10000,
      currency: 'BTC',
      gameId: 'galaxy-crash',
      placedAt: Math.floor(Date.now() / 1000),
    };
    const betRes = await request(app)
      .post('/bet')
      .set(signedHeaders('POST', '/bet', betBody))
      .send(betBody);
    expect(betRes.status).toBe(200);
    const balanceAfterBet = betRes.body.balanceMinor as number;

    const rollbackBody = {
      playerId: 'pid-3',
      betTxnId,
      txnId: crypto.randomUUID(),
      reason: 'round_voided',
    };
    const rbRes = await request(app)
      .post('/rollback')
      .set(signedHeaders('POST', '/rollback', rollbackBody))
      .send(rollbackBody);

    expect(rbRes.status).toBe(200);
    expect(rbRes.body.status).toBe('rolled_back');
    expect(rbRes.body.balanceMinor).toBe(balanceAfterBet + 10000);
  });
});

describe('Signature verification', () => {
  it('rejects requests with invalid HMAC', async () => {
    const body = { token: 'tok-pid-1' };
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post('/authenticate')
      .set({
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-Timestamp': ts,
        'X-Nonce': crypto.randomUUID(),
        'X-Signature': 'deadbeef'.repeat(8), // bad sig
      })
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects stale timestamps', async () => {
    const body = { token: 'tok-pid-1' };
    const staleTs = String(Math.floor(Date.now() / 1000) - 400); // 400s ago
    const nonce = crypto.randomUUID();
    const bodyHash = sha256Hex(Buffer.from(JSON.stringify(body)));
    const sigString = `POST\n/authenticate\n${staleTs}\n${nonce}\n${bodyHash}`;
    const sig = hmacHex(sigString);

    const res = await request(app)
      .post('/authenticate')
      .set({
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-Timestamp': staleTs,
        'X-Nonce': nonce,
        'X-Signature': sig,
      })
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('STALE_REQUEST');
  });

  it('rejects replayed nonce (NONCE_REUSED)', async () => {
    const body = { token: 'tok-pid-1', ip: '1.2.3.4', userAgent: 'test', gameId: 'galaxy-crash' };
    const headers = signedHeaders('POST', '/authenticate', body);

    // First request must succeed
    const res1 = await request(app).post('/authenticate').set(headers).send(body);
    expect(res1.status).toBe(200);

    // Exact same request (same headers, same body) must be rejected
    const res2 = await request(app).post('/authenticate').set(headers).send(body);
    expect(res2.status).toBe(401);
    expect(res2.body.error.code).toBe('NONCE_REUSED');
  });
});

describe('POST /balance', () => {
  it('returns 200 with balance and currency for a known player', async () => {
    const body = { playerId: 'pid-1', sessionId: 'ses-test' };
    const res = await request(app)
      .post('/balance')
      .set(signedHeaders('POST', '/balance', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(100000);
    expect(res.body.currency).toBe('EUR');
    expect(res.headers['x-signature']).toBeTruthy();
  });
});

describe('POST /round-end', () => {
  it('returns 204 with X-Signature matching spec §4.3', async () => {
    const body = { roundId: 'rnd-test', playerId: 'pid-1', bets: [] };
    const headers = signedHeaders('POST', '/round-end', body);
    const res = await request(app)
      .post('/round-end')
      .set(headers)
      .send(body);

    expect(res.status).toBe(204);
    expect(res.headers['x-signature']).toBeTruthy();

    // Verify the signature: HMAC(key, "204\n<x-timestamp>\n<sha256 of empty body>")
    const timestamp = headers['X-Timestamp'];
    const emptyBodyHash = sha256Hex(Buffer.alloc(0));
    const expectedSig = hmacHex(`204\n${timestamp}\n${emptyBodyHash}`);
    expect(res.headers['x-signature']).toBe(expectedSig);
  });
});
