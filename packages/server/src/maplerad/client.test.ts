import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { MapleradClient } from './client';

function sign(secret: string, id: string, ts: string, body: string) {
  const key = Buffer.from(secret.slice(secret.indexOf('_') + 1), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

describe('MapleradClient', () => {
  it('verifies a valid Svix signature and rejects a tampered one', () => {
    const secret = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
    const c = new MapleradClient({ baseUrl: 'x', secretKey: 'y', webhookSecret: secret });
    const body = '{"event":"collection.successful"}';
    const ok = sign(secret, 'id1', '1700000000', body);
    expect(c.verifyWebhookSignature('id1', '1700000000', body, ok)).toBe(true);
    expect(c.verifyWebhookSignature('id1', '1700000000', body + 'x', ok)).toBe(false);
  });

  it('collect POSTs /collections/momo with the Bearer header and expected body, returning data', async () => {
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
      bankCode: 'MPESA',
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
      amount: 10000,
      bank_code: 'MPESA',
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
    expect(result).toEqual({ id: 'txn_123', status: 'pending' });
  });
});
