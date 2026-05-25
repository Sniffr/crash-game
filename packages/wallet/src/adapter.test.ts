import { describe, it, expect } from 'vitest';
import { WalletClient } from './client.js';
import { WalletError } from './errors.js';
import { signResponse } from './signing.js';
import type { Operator } from './types.js';
import type {
  WalletAdapter,
  AdapterRequestContext,
  AdapterResponseContext,
} from './adapter.js';
import type { BetRequest, BetResponse } from './client-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('abcdef0123456789abcdef0123456789'); // 32 bytes

const TEST_OPERATOR: Operator = {
  operatorId: 'fake-op',
  name: 'Fake Adapter Operator',
  walletBaseUrl: 'http://native.test',
  apiKey: 'ak-fake',
  signingKey: TEST_KEY,
  adapter: 'softswiss',
  currencies: ['EUR'],
  minBetMinor: 10,
  maxBetMinor: 500000,
  rtpVariant: 97.0,
  jurisdictions: ['MT'],
  status: 'sandbox',
  createdAt: 1700000000,
  updatedAt: 1700000000,
};

const BET_REQ: BetRequest = {
  playerId: 'p1',
  sessionId: 's1',
  roundId: 'r1',
  betId: 'b1',
  txnId: 't1',
  amountMinor: 100,
  currency: 'EUR',
  gameId: 'crash',
  placedAt: 1716000000,
};

/** Uppercase the top-level keys of an object — proves encodeRequest controls the body. */
function uppercaseKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toUpperCase()] = v;
  return out;
}

const FAKE_ADAPTER_URL = 'http://foreign.test/api/v9/wager';

/** Fake adapter: encodes to a foreign URL with uppercased body keys + a custom
 *  header; decodes by parsing JSON on 2xx and throwing a WalletError otherwise. */
const fakeAdapter: WalletAdapter = {
  name: 'fake-uppercase',
  encodeRequest(ctx: AdapterRequestContext) {
    return {
      method: 'POST',
      url: FAKE_ADAPTER_URL,
      headers: {
        'Content-Type': 'application/json',
        'X-Fake-Adapter': '1',
        'X-Fake-Nonce': ctx.nonce,
      },
      body: JSON.stringify(uppercaseKeys(ctx.payload as Record<string, unknown>)),
    };
  },
  decodeResponse(ctx: AdapterResponseContext) {
    if (ctx.status < 200 || ctx.status >= 300) {
      // Map a foreign error to OUR canonical WalletError (matches native semantics).
      throw new WalletError({
        code: 'FAKE_REJECTED',
        message: `foreign rejected with ${ctx.status}`,
        httpStatus: ctx.status,
        retryable: false,
      });
    }
    return JSON.parse(ctx.bodyText) as BetResponse;
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletClient adapter wiring (Task 7.1)', () => {
  it('routes bet() through encodeRequest → fetch → decodeResponse', async () => {
    const decoded: BetResponse = { operatorTxnId: 'op-1', balanceMinor: 9900, currency: 'EUR' };

    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;

    const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return new Response(JSON.stringify(decoded), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new WalletClient(TEST_OPERATOR, {
      adapter: fakeAdapter,
      fetchImpl,
      generateNonce: () => 'nonce-fixed',
      nowSeconds: () => 1716000000,
    });

    const result = await client.bet(BET_REQ);

    // decodeResponse returned value flows back to the caller
    expect(result).toEqual(decoded);

    // fetch saw the adapter's URL, custom header, and uppercased body keys
    expect(captured).toBeDefined();
    expect(captured!.url).toBe(FAKE_ADAPTER_URL);
    expect(captured!.headers['X-Fake-Adapter']).toBe('1');
    const parsedBody = JSON.parse(captured!.body);
    expect(parsedBody.PLAYERID).toBe('p1');
    expect(parsedBody.TXNID).toBe('t1');
    expect(parsedBody.AMOUNTMINOR).toBe(100);
    // No native canonical key should be present (proves we sent the foreign body)
    expect(parsedBody.playerId).toBeUndefined();
  });

  it('propagates a WalletError thrown by decodeResponse on non-2xx (like native)', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{"error":"nope"}', { status: 422 })) as unknown as typeof fetch;

    const client = new WalletClient(TEST_OPERATOR, {
      adapter: fakeAdapter,
      fetchImpl,
      generateNonce: () => 'nonce-fixed',
      nowSeconds: () => 1716000000,
    });

    await expect(client.bet(BET_REQ)).rejects.toMatchObject({
      code: 'FAKE_REJECTED',
      httpStatus: 422,
      retryable: false,
    });
    await expect(client.bet(BET_REQ)).rejects.toBeInstanceOf(WalletError);
  });

  // Headline guarantee of Task 7.1: a native operator (the cache injects
  // adapter: undefined, since getAdapter('native') === undefined) takes the
  // built-in native SIGNED path — not the adapter path. Proven at the branch
  // level here; getAdapter('native') === undefined is proven in the registry test.
  it('with NO adapter (native case) uses the native signed path — canonical body + X-Signature headers', async () => {
    const decoded: BetResponse = { operatorTxnId: 'op-2', balanceMinor: 9900, currency: 'EUR' };
    const REQ_TS = 1716000000;

    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;

    const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      // Sign the response so the native verifyResponse (§4.3) passes — the
      // response signing string binds the REQUEST timestamp.
      const bodyStr = JSON.stringify(decoded);
      const sig = signResponse(
        { status: 200, timestamp: REQ_TS, body: Buffer.from(bodyStr) },
        TEST_KEY,
      );
      return new Response(bodyStr, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Signature': sig },
      });
    }) as unknown as typeof fetch;

    const nativeOperator: Operator = { ...TEST_OPERATOR, adapter: 'native', walletBaseUrl: 'http://native.test' };
    const client = new WalletClient(nativeOperator, {
      // no adapter — exactly what WalletClientCache passes for a native operator
      fetchImpl,
      generateNonce: () => 'nonce-native',
      nowSeconds: () => REQ_TS,
    });

    const result = await client.bet(BET_REQ);
    expect(result).toEqual(decoded);

    // Native wire: signed headers present, request hits walletBaseUrl + path,
    // body is the CANONICAL payload (not the adapter's uppercased shape).
    expect(captured).toBeDefined();
    expect(captured!.url).toBe('http://native.test/bet');
    expect(captured!.headers['X-API-Key']).toBe('ak-fake');
    expect(captured!.headers['X-Signature']).toEqual(expect.any(String));
    expect(captured!.headers['X-Timestamp']).toBe(String(REQ_TS));
    expect(captured!.headers['X-Nonce']).toBe('nonce-native');
    // No adapter header, and the body keys are canonical (lowercase), not uppercased.
    expect(captured!.headers['X-Fake-Adapter']).toBeUndefined();
    const parsedBody = JSON.parse(captured!.body);
    expect(parsedBody.playerId).toBe('p1');
    expect(parsedBody.PLAYERID).toBeUndefined();
  });
});
