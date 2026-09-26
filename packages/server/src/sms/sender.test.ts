import { describe, expect, it } from 'vitest';
import {
  CommsSmsSender, ConsoleSmsSender, DEFAULT_COMMS_URL, SmsDeliveryError, UnconfiguredSmsSender, smsSenderFromEnv,
} from './sender.js';

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a script, one entry per call. */
function scripted(replies: Array<{ status: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra call');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const sender = (fetchFn: typeof fetch) => new CommsSmsSender({ apiKey: 'test-key', fetchFn, retryDelayMs: 0 });

describe('CommsSmsSender', () => {
  it('posts the message to Comms under STDIOXTIX with a bearer key and a bare MSISDN', async () => {
    const { calls, fetchFn } = scripted([{ status: 200, body: { status: 'success', message: 'queued' } }]);
    await sender(fetchFn).send('+254712345678', 'Your SimBet code is 123456');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEFAULT_COMMS_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      recipient: '254712345678',
      sender_id: 'STDIOXTIX',
      type: 'plain',
      message: 'Your SimBet code is 123456',
    });
  });

  it('does not retry a rejection (4xx or an error status) and reports it', async () => {
    const { calls, fetchFn } = scripted([{ status: 401, body: { status: 'error', message: 'Unauthenticated.' } }]);
    await expect(sender(fetchFn).send('+254712345678', 'hi')).rejects.toThrow(/401: Unauthenticated/);
    expect(calls).toHaveLength(1);

    const soft = scripted([{ status: 200, body: { status: 'error', message: 'Invalid sender id' } }]);
    await expect(sender(soft.fetchFn).send('+254712345678', 'hi')).rejects.toBeInstanceOf(SmsDeliveryError);
    expect(soft.calls).toHaveLength(1);
  });

  it('retries network failures and server errors, then succeeds', async () => {
    const { calls, fetchFn } = scripted([
      new Error('ECONNRESET'),
      { status: 502, body: { message: 'bad gateway' } },
      { status: 200, body: { status: 'SUCCESS' } },
    ]);
    await sender(fetchFn).send('+254712345678', 'hi');
    expect(calls).toHaveLength(3);
  });

  it('gives up after three failed attempts', async () => {
    const { calls, fetchFn } = scripted([new Error('down'), new Error('down'), new Error('down')]);
    await expect(sender(fetchFn).send('+254712345678', 'hi')).rejects.toThrow(/unreachable: down/);
    expect(calls).toHaveLength(3);
  });
});

describe('smsSenderFromEnv', () => {
  it('uses Comms whenever a key is set, with STDIOXTIX unless overridden', () => {
    const s = smsSenderFromEnv({ COMMS_API_KEY: 'k', NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(CommsSmsSender);
    expect((s as unknown as { senderId: string }).senderId).toBe('STDIOXTIX');
    const custom = smsSenderFromEnv({ COMMS_API_KEY: 'k', SMS_SENDER_ID: 'OTHER' } as NodeJS.ProcessEnv);
    expect((custom as unknown as { senderId: string }).senderId).toBe('OTHER');
  });

  it('never prints codes in production: without a key every send fails', async () => {
    const s = smsSenderFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(UnconfiguredSmsSender);
    await expect(s.send('+254712345678', 'code')).rejects.toBeInstanceOf(SmsDeliveryError);
  });

  it('prints to the console in development', () => {
    expect(smsSenderFromEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBeInstanceOf(ConsoleSmsSender);
  });
});
