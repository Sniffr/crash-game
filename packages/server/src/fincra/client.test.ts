import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { FincraClient, toMajor, fullName } from './client';

const SECRET = 'fincra-whsec-test';

function makeClient(fetchImpl?: typeof fetch, extra?: { currencies?: string[]; redirectUrl?: string }) {
  return new FincraClient({
    baseUrl: 'https://api.fincra.com',
    secretKey: 'sk_test_abc',
    businessId: 'biz_1',
    webhookSecret: SECRET,
    ...extra,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

const okJson = (data: Record<string, unknown>) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }) as Response) as unknown as typeof fetch;

describe('FincraClient', () => {
  it('bills in major units per currency (UGX is 0dp)', () => {
    expect(toMajor(10000, 'KES')).toBe(100);
    expect(toMajor(10150, 'KES')).toBe(101.5);
    expect(toMajor(5000, 'UGX')).toBe(5000);
  });

  it('always sends a two-part name — Fincra rejects single-token names', () => {
    // Live failure this guards: usernames are one word, and checkout answers
    // "Customer's full name is required".
    expect(fullName('smoke_1786611')).toBe('smoke_1786611 Player');
    expect(fullName('Jane Doe')).toBe('Jane Doe');
    expect(fullName('  Jane   Doe  ')).toBe('Jane Doe');
    expect(fullName(undefined)).toBe('Game Player');
    expect(fullName('   ')).toBe('Game Player');
  });

  it('supports every rail by default, and only the configured list when narrowed', () => {
    const c = makeClient();
    expect(c.supports('KES')).toBe(true);
    expect(c.supports('ZAR')).toBe(true); // checkout is currency-gated, not momo-gated
    expect(c.supports('EUR')).toBe(false);

    expect(c.supports('NGN')).toBe(true); // Fincra's home currency

    const narrowed = makeClient(undefined, { currencies: ['KES'] });
    expect(narrowed.supports('KES')).toBe(true);
    expect(narrowed.supports('ZMW')).toBe(false);

    expect(new FincraClient({ baseUrl: 'x', secretKey: '', businessId: '', webhookSecret: '' }).supports('KES')).toBe(false);
  });

  it('collect POSTs /checkout/payments and returns the hosted payment link', async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const fetchImpl = (async (u: string | URL, i?: RequestInit) => {
      url = String(u);
      init = i;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 1, link: 'https://checkout.fincra.com/pay/fcr-p-1' } }) } as Response;
    }) as unknown as typeof fetch;

    const c = makeClient(fetchImpl, { redirectUrl: 'https://game.example/lobby' });
    const result = await c.collect({
      currency: 'KES',
      amountMinor: 60000,
      phone: '254700000000',
      reference: 'game-dep-1',
      description: 'Game deposit',
      payerName: 'Jane Doe',
      payerEmail: 'jane@example.com',
    });

    expect(url).toBe('https://api.fincra.com/checkout/payments');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['api-key']).toBe('sk_test_abc');
    expect(headers['x-business-id']).toBe('biz_1');
    expect(JSON.parse(init?.body as string)).toEqual({
      amount: 600, // major units
      currency: 'KES',
      reference: 'game-dep-1',
      customer: { name: 'Jane Doe', email: 'jane@example.com', phoneNumber: '+254700000000' },
      feeBearer: 'business',
      settlementDestination: 'wallet',
      successMessage: 'Game deposit',
      redirectUrl: 'https://game.example/lobby',
    });
    expect(result).toEqual({ redirectUrl: 'https://checkout.fincra.com/pay/fcr-p-1' });
  });

  it('omits phoneNumber entirely when the player has none (email rails)', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_u: string | URL, i?: RequestInit) => {
      init = i;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { link: 'https://checkout.fincra.com/pay/x' } }) } as Response;
    }) as unknown as typeof fetch;

    await makeClient(fetchImpl).collect({ currency: 'NGN', amountMinor: 50_000, reference: 'r', description: 'd', payerEmail: 'ngn@example.com' });
    expect(JSON.parse(init?.body as string).customer).toEqual({ name: 'Game Player', email: 'ngn@example.com' });
  });

  it('treats a link-less checkout response as a rejection', async () => {
    await expect(makeClient(okJson({ id: 1 })).collect(input())).rejects.toMatchObject({ rejected: true });
  });

  it('marks an API-level rejection as failover-safe, but not a network error', async () => {
    const rejecting = (async () => ({ ok: false, status: 403, json: async () => ({ success: false, message: 'not authorized' }) }) as Response) as unknown as typeof fetch;
    await expect(makeClient(rejecting).collect(input())).rejects.toMatchObject({ rejected: true });

    const dropping = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(makeClient(dropping).collect(input())).rejects.not.toMatchObject({ rejected: true });
  });

  it('verifyTransaction reads OUR reference from merchantReference, not Fincra\'s own', async () => {
    // Live shape: `reference` is Fincra's id (fcr-p-…), `merchantReference` is
    // ours. Reading the wrong one fails the webhook's identity gate on every
    // real payment, so this is load-bearing.
    let url: string | undefined;
    const fetchImpl = (async (u: string | URL) => {
      url = String(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { amount: 101.51, amountReceived: 101.51, currency: 'KES', reference: 'fcr-p-36c2cf92dc', merchantReference: 'game-dep-1', status: 'success' },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const v = await makeClient(fetchImpl).verifyTransaction('game-dep-1');
    expect(url).toBe('https://api.fincra.com/checkout/payments/merchant-reference/game-dep-1');
    expect(v).toEqual({ status: 'success', reference: 'game-dep-1', amountMinor: 10151, currency: 'KES' });
  });

  it('an unpaid checkout reports zero received, so it cannot be credited', async () => {
    // Real response for a link nobody has paid: amount 100, amountReceived 0.
    const c = makeClient(okJson({ amount: 100, amountReceived: 0, currency: 'KES', merchantReference: 'r', status: 'initiated' }));
    expect(await c.verifyTransaction('r')).toEqual({ status: 'initiated', reference: 'r', amountMinor: 0, currency: 'KES' });
  });

  it('reports what was RECEIVED, not what was requested (short-paid checkout)', async () => {
    // The deposit is only credited if amountMinor matches, so a part-payment
    // must read back short rather than as the full requested amount.
    const c = makeClient(okJson({ amount: 600, amountReceived: 100, currency: 'KES', reference: 'r', status: 'success' }));
    expect((await c.verifyTransaction('r')).amountMinor).toBe(10_000);
  });

  it('parses charge events into an outcome + our reference', () => {
    const c = makeClient();
    expect(c.parseEvent({ event: 'charge.successful', data: { reference: 'r1' } })).toEqual({ reference: 'r1', outcome: 'success', txnKey: 'r1' });
    // merchantReference wins when both are present — `reference` is Fincra's.
    expect(c.parseEvent({ event: 'charge.successful', data: { reference: 'fcr-p-1', merchantReference: 'game-dep-1' } })).toEqual({
      reference: 'game-dep-1',
      outcome: 'success',
      txnKey: 'game-dep-1',
    });
    expect(c.parseEvent({ event: 'charge.failed', data: { reference: 'r1' } }).outcome).toBe('failed');
    expect(c.parseEvent({ event: 'charge.pending', data: { reference: 'r1' } }).outcome).toBe('ignore');
    expect(c.parseEvent(null).reference).toBe('');
  });

  it('verifies the hex SHA512 signature header and rejects a tampered body', () => {
    const c = makeClient();
    const body = '{"event":"charge.successful","data":{"reference":"r1"}}';
    const sig = createHmac('sha512', SECRET).update(body).digest('hex');
    const header = (v: string) => (name: string) => (name === 'signature' ? v : undefined);

    expect(c.verifyWebhookSignature(header(sig), body)).toBe(true);
    expect(c.verifyWebhookSignature(header(sig), body.replace('r1', 'r2'))).toBe(false);
    expect(c.verifyWebhookSignature(header(''), body)).toBe(false);

    // Fincra's own example hashes JSON.stringify(payload) — a body that only
    // differs by transport whitespace must still verify.
    const spaced = '{"event":"charge.successful", "data":  {"reference":"r1"}}';
    expect(c.verifyWebhookSignature(header(sig), spaced)).toBe(true);
  });
});

function input() {
  return { currency: 'KES', amountMinor: 100, phone: '254700000000', reference: 'r', description: 'd' };
}
