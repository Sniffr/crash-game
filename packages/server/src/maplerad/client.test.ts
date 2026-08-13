import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { MapleradClient } from './client';

function sign(secret: string, id: string, ts: string, body: string) {
  const key = Buffer.from(secret.slice(secret.indexOf('_') + 1), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

const svixHeaders = (id: string, ts: string, sig: string) => (name: string) =>
  ({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig })[name];

describe('MapleradClient', () => {
  it('verifies a valid Svix signature and rejects a tampered one', () => {
    const secret = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
    const c = new MapleradClient({ baseUrl: 'x', secretKey: 'y', webhookSecret: secret });
    const body = '{"event":"collection.successful"}';
    const ok = sign(secret, 'id1', '1700000000', body);
    expect(c.verifyWebhookSignature(svixHeaders('id1', '1700000000', ok), body)).toBe(true);
    expect(c.verifyWebhookSignature(svixHeaders('id1', '1700000000', ok), body + 'x')).toBe(false);
    expect(c.verifyWebhookSignature(() => undefined, body)).toBe(false);
  });

  it('supports only currencies with a live institution code', () => {
    const c = new MapleradClient({ baseUrl: 'x', secretKey: 'sk', webhookSecret: '' });
    expect(c.supports('KES')).toBe(true);
    expect(c.supports('UGX')).toBe(true); // MTN Uganda momo
    expect(c.supports('ZMW')).toBe(false); // Maplerad lists no ZM institutions
    expect(c.supports('ZAR')).toBe(false); // bank rail, not momo
    expect(new MapleradClient({ baseUrl: 'x', secretKey: '', webhookSecret: '' }).supports('KES')).toBe(false);
  });

  it('collect POSTs /collections/momo with the Bearer header and expected body, with no redirect', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({ status: true, message: 'ok', data: { id: 'txn_123', status: 'pending' } }),
      } as Response;
    }) as unknown as typeof fetch;

    const c = new MapleradClient({
      baseUrl: 'https://api.maplerad.com',
      secretKey: 'sk_test_abc',
      webhookSecret: '',
      fetchImpl,
    });

    const result = await c.collect({
      currency: 'KES',
      amountMinor: 10000,
      phone: '254712345678',
      reference: 'ref-1',
      description: 'Top up',
      payerName: 'Jane Doe',
      payerEmail: 'jane@example.com',
    });

    expect(capturedUrl).toBe('https://api.maplerad.com/collections/momo');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_test_abc');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      account_number: '254712345678',
      amount: 10000, // Maplerad bills in minor units — no conversion
      bank_code: '1271', // from the KES rail
      currency: 'KES',
      description: 'Top up',
      reference: 'ref-1',
      meta: {
        counterparty: {
          first_name: 'Jane',
          last_name: 'Doe',
          email: 'jane@example.com',
          phone_number: '254712345678',
        },
      },
    });
    // Maplerad prompts the phone directly — nothing for the client to open.
    expect(result).toEqual({});
  });

  it('marks an API-level rejection as failover-safe', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ status: false, message: 'nope' }) }) as Response) as unknown as typeof fetch;
    const c = new MapleradClient({ baseUrl: 'x', secretKey: 'sk', webhookSecret: '', fetchImpl });
    await expect(c.collect({ currency: 'KES', amountMinor: 1, phone: '2547', reference: 'r', description: 'd' })).rejects.toMatchObject({
      rejected: true,
    });
  });

  it('normalizes a verified transaction and parses collection events', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ status: true, data: { status: 'success', reference: 'r1', amount: 5000, currency: 'KES' } }),
      }) as Response) as unknown as typeof fetch;
    const c = new MapleradClient({ baseUrl: 'x', secretKey: 'sk', webhookSecret: '', fetchImpl });

    expect(await c.verifyTransaction('tx1')).toEqual({ status: 'success', reference: 'r1', amountMinor: 5000, currency: 'KES' });
    expect(c.parseEvent({ event: 'collection.successful', data: { reference: 'r1', id: 'tx1' } })).toEqual({
      reference: 'r1',
      outcome: 'success',
      txnKey: 'tx1',
    });
    expect(c.parseEvent({ event: 'collection.failed', data: { reference: 'r1' } }).outcome).toBe('failed');
  });
});
