import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { softswissAdapter } from './softswiss.js';
import {
  WalletClient,
  WalletError,
  ResponseSignatureError,
  type Operator,
  type AdapterRequestContext,
  type AdapterResponseContext,
  type AdapterEndpoint,
  type BetRequest,
  type WinRequest,
  type RollbackRequest,
  type BalanceRequest,
  type AuthenticateRequest,
} from '@crash/wallet';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = Buffer.from('softswiss-key-32-bytes-aaaaaaaaaa'); // 32 bytes

const OP: Operator = {
  operatorId: 'ss-op',
  name: 'SoftSwiss Test Operator',
  walletBaseUrl: 'http://ss.test',
  apiKey: 'ak-softswiss',
  signingKey: KEY,
  adapter: 'softswiss',
  currencies: ['EUR'],
  minBetMinor: 10,
  maxBetMinor: 500000,
  rtpVariant: 97.0,
  jurisdictions: ['MT'],
  status: 'sandbox',
  shareBps: 1500,
  createdAt: 1700000000,
  updatedAt: 1700000000,
};

const TS = 1716000000;
const NONCE = 'nonce-abc';

/** Independent expected HMAC — recomputed in the test, not via the adapter. */
function expectedSign(body: string): string {
  return createHmac('sha256', KEY).update(body, 'utf8').digest('hex');
}

function reqCtx(endpoint: AdapterEndpoint, payload: unknown): AdapterRequestContext {
  return { endpoint, payload, operator: OP, timestamp: TS, nonce: NONCE };
}

function resCtx(
  endpoint: AdapterEndpoint,
  status: number,
  bodyText: string,
  opts?: { sign?: string; omitSign?: boolean },
): AdapterResponseContext {
  const headers = new Headers();
  if (!opts?.omitSign) {
    headers.set('X-Sign', opts?.sign ?? expectedSign(bodyText));
  }
  return {
    endpoint,
    status,
    headers,
    bodyText,
    requestTimestamp: TS,
    requestNonce: NONCE,
    operator: OP,
  };
}

const BET: BetRequest = {
  playerId: 'p1', sessionId: 's1', roundId: 'r1', betId: 'b1', txnId: 't1',
  amountMinor: 100, currency: 'EUR', gameId: 'crash', placedAt: TS,
};
const WIN: WinRequest = {
  playerId: 'p1', sessionId: 's1', roundId: 'r1', betId: 'b1', betTxnId: 't1',
  txnId: 't2', amountMinor: 250, multiplier: 2.5, currency: 'EUR', settledAt: TS,
};
const ROLLBACK: RollbackRequest = {
  playerId: 'p1', betTxnId: 't1', txnId: 't3', reason: 'round_voided',
};
const BAL: BalanceRequest = { playerId: 'p1', sessionId: 's1' };
const AUTH: AuthenticateRequest = {
  token: 'tok-xyz', ip: '1.2.3.4', userAgent: 'UA/1.0', gameId: 'crash',
};

// ---------------------------------------------------------------------------
// encodeRequest — golden vectors (URL, method, snake_case body, X-Sign HMAC)
// ---------------------------------------------------------------------------

describe('softswissAdapter.encodeRequest golden vectors', () => {
  it('bet → action/bet, snake_case body, correct X-Sign over raw body', () => {
    const wire = softswissAdapter.encodeRequest(reqCtx('bet', BET));
    expect(wire.method).toBe('POST');
    expect(wire.url).toBe('http://ss.test/callback');
    expect(wire.headers['Content-Type']).toBe('application/json');
    expect(wire.headers['X-Api-Key']).toBe('ak-softswiss');
    expect(JSON.parse(wire.body)).toEqual({
      action: 'bet',
      request_uuid: 't1',
      timestamp: TS,
      user: 'p1',
      session_id: 's1',
      game: 'crash',
      game_round: 'r1',
      bet_id: 'b1',
      amount: 100,
      currency: 'EUR',
    });
    // Independently-computed HMAC must match the adapter's X-Sign.
    expect(wire.headers['X-Sign']).toBe(expectedSign(wire.body));
  });

  it('win → action/win with reference_transaction_uuid + multiplier', () => {
    const wire = softswissAdapter.encodeRequest(reqCtx('win', WIN));
    expect(wire.url).toBe('http://ss.test/callback');
    expect(JSON.parse(wire.body)).toEqual({
      action: 'win',
      request_uuid: 't2',
      timestamp: TS,
      reference_transaction_uuid: 't1',
      user: 'p1',
      game_round: 'r1',
      bet_id: 'b1',
      amount: 250,
      multiplier: 2.5,
      currency: 'EUR',
    });
    expect(wire.headers['X-Sign']).toBe(expectedSign(wire.body));
  });

  it('rollback → action/rollback with reason + reference txn', () => {
    const wire = softswissAdapter.encodeRequest(reqCtx('rollback', ROLLBACK));
    expect(JSON.parse(wire.body)).toEqual({
      action: 'rollback',
      request_uuid: 't3',
      timestamp: TS,
      reference_transaction_uuid: 't1',
      user: 'p1',
      reason: 'round_voided',
    });
    expect(wire.headers['X-Sign']).toBe(expectedSign(wire.body));
  });

  it('balance → action/balance, request_uuid derived from nonce', () => {
    const wire = softswissAdapter.encodeRequest(reqCtx('balance', BAL));
    expect(JSON.parse(wire.body)).toEqual({
      action: 'balance',
      request_uuid: NONCE,
      timestamp: TS,
      user: 'p1',
      session_id: 's1',
    });
    expect(wire.headers['X-Sign']).toBe(expectedSign(wire.body));
  });

  it('authenticate → action/authenticate, token/ip/user_agent/game', () => {
    const wire = softswissAdapter.encodeRequest(reqCtx('authenticate', AUTH));
    expect(JSON.parse(wire.body)).toEqual({
      action: 'authenticate',
      request_uuid: NONCE,
      timestamp: TS,
      token: 'tok-xyz',
      ip: '1.2.3.4',
      user_agent: 'UA/1.0',
      game: 'crash',
    });
    expect(wire.headers['X-Sign']).toBe(expectedSign(wire.body));
  });

  it('is deterministic — same inputs produce byte-identical body + sign', () => {
    const a = softswissAdapter.encodeRequest(reqCtx('bet', BET));
    const b = softswissAdapter.encodeRequest(reqCtx('bet', BET));
    expect(a.body).toBe(b.body);
    expect(a.headers['X-Sign']).toBe(b.headers['X-Sign']);
  });
});

// ---------------------------------------------------------------------------
// decodeResponse — success mapping
// ---------------------------------------------------------------------------

describe('softswissAdapter.decodeResponse RS_OK success', () => {
  it('bet RS_OK → canonical BetResponse', () => {
    const body = JSON.stringify({
      status: 'RS_OK', transaction_uuid: 'op-1', balance: 9900, currency: 'EUR',
    });
    expect(softswissAdapter.decodeResponse(resCtx('bet', 200, body))).toEqual({
      operatorTxnId: 'op-1', balanceMinor: 9900, currency: 'EUR',
    });
  });

  it('win RS_OK → canonical WinResponse', () => {
    const body = JSON.stringify({
      status: 'RS_OK', transaction_uuid: 'op-2', balance: 12000, currency: 'EUR',
    });
    expect(softswissAdapter.decodeResponse(resCtx('win', 200, body))).toEqual({
      operatorTxnId: 'op-2', balanceMinor: 12000, currency: 'EUR',
    });
  });

  it('rollback RS_OK → RollbackResponse with status rolled_back', () => {
    const body = JSON.stringify({
      status: 'RS_OK', transaction_uuid: 'op-3', balance: 10000, currency: 'EUR',
    });
    expect(softswissAdapter.decodeResponse(resCtx('rollback', 200, body))).toEqual({
      operatorTxnId: 'op-3', balanceMinor: 10000, currency: 'EUR', status: 'rolled_back',
    });
  });

  it('balance RS_OK → BalanceResponse', () => {
    const body = JSON.stringify({ status: 'RS_OK', balance: 5000, currency: 'EUR' });
    expect(softswissAdapter.decodeResponse(resCtx('balance', 200, body))).toEqual({
      balance: 5000, currency: 'EUR',
    });
  });

  it('authenticate RS_OK → AuthenticateResponse with synthesized fields', () => {
    const body = JSON.stringify({
      status: 'RS_OK', user: 'player-42', balance: 7777, currency: 'EUR',
    });
    expect(softswissAdapter.decodeResponse(resCtx('authenticate', 200, body))).toEqual({
      playerId: 'player-42',
      displayName: 'player-42',
      currency: 'EUR',
      balance: 7777,
      country: '',
      jurisdiction: '',
      language: 'en',
      rgLimits: { maxBetMinor: 0, sessionEndsAt: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// decodeResponse — business error mapping (HTTP 200 + RS_ERROR_*)
// ---------------------------------------------------------------------------

describe('softswissAdapter.decodeResponse RS_ERROR_* mapping', () => {
  it('RS_ERROR_INSUFFICIENT_FUNDS → 402, non-retryable, balanceMinor', () => {
    const body = JSON.stringify({ status: 'RS_ERROR_INSUFFICIENT_FUNDS', balance: 50, currency: 'EUR' });
    try {
      softswissAdapter.decodeResponse(resCtx('bet', 200, body));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      const e = err as WalletError;
      expect(e.code).toBe('INSUFFICIENT_FUNDS');
      expect(e.httpStatus).toBe(402);
      expect(e.retryable).toBe(false);
      expect(e.balanceMinor).toBe(50);
    }
  });

  it('RS_ERROR_DUPLICATE_TRANSACTION → 409 non-retryable', () => {
    const body = JSON.stringify({ status: 'RS_ERROR_DUPLICATE_TRANSACTION' });
    expect(() => softswissAdapter.decodeResponse(resCtx('bet', 200, body))).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_TRANSACTION', httpStatus: 409, retryable: false }),
    );
  });

  it('RS_ERROR_TOKEN_EXPIRED → TOKEN_INVALID 401', () => {
    const body = JSON.stringify({ status: 'RS_ERROR_TOKEN_EXPIRED' });
    expect(() => softswissAdapter.decodeResponse(resCtx('authenticate', 200, body))).toThrowError(
      expect.objectContaining({ code: 'TOKEN_INVALID', httpStatus: 401, retryable: false }),
    );
  });

  it('RS_ERROR_TOKEN_INVALID → TOKEN_INVALID 401', () => {
    const body = JSON.stringify({ status: 'RS_ERROR_TOKEN_INVALID' });
    expect(() => softswissAdapter.decodeResponse(resCtx('authenticate', 200, body))).toThrowError(
      expect.objectContaining({ code: 'TOKEN_INVALID', httpStatus: 401, retryable: false }),
    );
  });

  it('rollback RS_ERROR_TRANSACTION_DOES_NOT_EXIST → noop success (idempotent)', () => {
    const body = JSON.stringify({
      status: 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST', request_uuid: 't3', balance: 10000, currency: 'EUR',
    });
    expect(softswissAdapter.decodeResponse(resCtx('rollback', 200, body))).toEqual({
      operatorTxnId: 't3', balanceMinor: 10000, currency: 'EUR', status: 'noop',
    });
  });

  it('non-rollback RS_ERROR_TRANSACTION_DOES_NOT_EXIST → TRANSACTION_NOT_FOUND 404', () => {
    const body = JSON.stringify({ status: 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST' });
    expect(() => softswissAdapter.decodeResponse(resCtx('win', 200, body))).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_NOT_FOUND', httpStatus: 404, retryable: false }),
    );
  });

  it('unknown RS_ERROR_* → code passthrough, 422 non-retryable', () => {
    const body = JSON.stringify({ status: 'RS_ERROR_PLAYER_BLOCKED' });
    expect(() => softswissAdapter.decodeResponse(resCtx('bet', 200, body))).toThrowError(
      expect.objectContaining({ code: 'RS_ERROR_PLAYER_BLOCKED', httpStatus: 422, retryable: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// decodeResponse — signature + transport + malformed
// ---------------------------------------------------------------------------

describe('softswissAdapter.decodeResponse signature/transport/malformed', () => {
  it('bad X-Sign → ResponseSignatureError', () => {
    const body = JSON.stringify({ status: 'RS_OK', transaction_uuid: 'x', balance: 1, currency: 'EUR' });
    const ctx = resCtx('bet', 200, body, { sign: 'deadbeef' });
    expect(() => softswissAdapter.decodeResponse(ctx)).toThrowError(ResponseSignatureError);
  });

  it('missing X-Sign → ResponseSignatureError', () => {
    const body = JSON.stringify({ status: 'RS_OK', balance: 1, currency: 'EUR' });
    const ctx = resCtx('bet', 200, body, { omitSign: true });
    expect(() => softswissAdapter.decodeResponse(ctx)).toThrowError(ResponseSignatureError);
  });

  it('HTTP 503 (correctly signed) → retryable UPSTREAM_ERROR', () => {
    const body = '';
    expect(() => softswissAdapter.decodeResponse(resCtx('bet', 503, body))).toThrowError(
      expect.objectContaining({ code: 'UPSTREAM_ERROR', httpStatus: 503, retryable: true }),
    );
  });

  it('HTTP 429 (correctly signed) → retryable RATE_LIMITED', () => {
    const body = '';
    expect(() => softswissAdapter.decodeResponse(resCtx('bet', 429, body))).toThrowError(
      expect.objectContaining({ code: 'RATE_LIMITED', httpStatus: 429, retryable: true }),
    );
  });

  it('HTTP 200 with non-JSON body → MALFORMED_RESPONSE non-retryable', () => {
    const body = 'not json <html>';
    expect(() => softswissAdapter.decodeResponse(resCtx('bet', 200, body))).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_RESPONSE', httpStatus: 200, retryable: false }),
    );
  });

  it('HTTP 400 with non-JSON body → MALFORMED_ERROR_BODY non-retryable', () => {
    const body = 'gateway error';
    expect(() => softswissAdapter.decodeResponse(resCtx('bet', 400, body))).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_ERROR_BODY', httpStatus: 400, retryable: false }),
    );
  });

  it('signature is verified BEFORE 5xx classification (bad sign on a 503 → ResponseSignatureError)', () => {
    const ctx = resCtx('bet', 503, '', { sign: 'deadbeef' });
    expect(() => softswissAdapter.decodeResponse(ctx)).toThrowError(ResponseSignatureError);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real WalletClient (encode → fetch → decode)
// ---------------------------------------------------------------------------

describe('softswissAdapter through WalletClient (e2e)', () => {
  it('client.bet sends SoftSwiss wire and returns canonical BetResponse', async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;

    const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      // Assert we received the SoftSwiss wire shape.
      const parsed = JSON.parse(captured.body);
      expect(parsed.action).toBe('bet');
      expect(parsed.user).toBe('p1');
      expect(parsed.amount).toBe(100);
      expect(captured.headers['X-Api-Key']).toBe('ak-softswiss');
      expect(captured.headers['X-Sign']).toBe(expectedSign(captured.body));

      const respBody = JSON.stringify({
        status: 'RS_OK', transaction_uuid: 'op-e2e', balance: 9900, currency: 'EUR',
      });
      return new Response(respBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Sign': expectedSign(respBody) },
      });
    }) as unknown as typeof fetch;

    const client = new WalletClient(OP, {
      adapter: softswissAdapter,
      fetchImpl,
      generateNonce: () => NONCE,
      nowSeconds: () => TS,
    });

    const result = await client.bet(BET);
    expect(result).toEqual({ operatorTxnId: 'op-e2e', balanceMinor: 9900, currency: 'EUR' });
    expect(captured!.url).toBe('http://ss.test/callback');
  });

  it('client.bet maps RS_ERROR_INSUFFICIENT_FUNDS to a WalletError (402)', async () => {
    const fetchImpl: typeof fetch = (async () => {
      const respBody = JSON.stringify({ status: 'RS_ERROR_INSUFFICIENT_FUNDS', balance: 5, currency: 'EUR' });
      return new Response(respBody, {
        status: 200,
        headers: { 'X-Sign': expectedSign(respBody) },
      });
    }) as unknown as typeof fetch;

    const client = new WalletClient(OP, {
      adapter: softswissAdapter,
      fetchImpl,
      generateNonce: () => NONCE,
      nowSeconds: () => TS,
    });

    await expect(client.bet(BET)).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS', httpStatus: 402, retryable: false, balanceMinor: 5,
    });
  });
});
