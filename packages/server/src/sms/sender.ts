/**
 * Outbound SMS, sent straight to the StdioX Comms API under our own sender ID
 * (STDIOXTIX) — no gateway in between.
 *
 *   POST {COMMS_API_URL}   Authorization: Bearer {COMMS_API_KEY}
 *   {recipient: "2547XXXXXXXX", sender_id, type: "plain", message}
 *   → {status: "success", ...} when accepted
 *
 * Env: COMMS_API_KEY (required in production), COMMS_API_URL, SMS_SENDER_ID.
 */

export interface SmsSender {
  send(phoneE164: string, message: string): Promise<void>;
}

export class SmsDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

export const DEFAULT_COMMS_URL = 'https://comms.stdiox.com/api/v3/sms/send';
export const DEFAULT_SENDER_ID = 'STDIOXTIX';

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export interface CommsSmsOptions {
  apiKey: string;
  url?: string;
  senderId?: string;
  fetchFn?: typeof fetch;
  /** Pause between attempts; tests pass 0. */
  retryDelayMs?: number;
}

export class CommsSmsSender implements SmsSender {
  private readonly url: string;
  private readonly senderId: string;
  private readonly fetchFn: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: CommsSmsOptions) {
    this.url = opts.url ?? DEFAULT_COMMS_URL;
    this.senderId = opts.senderId ?? DEFAULT_SENDER_ID;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 1_000;
  }

  async send(phoneE164: string, message: string): Promise<void> {
    const body = JSON.stringify({
      // Comms takes the bare MSISDN (2547XXXXXXXX); our phones are stored E.164.
      recipient: phoneE164.replace(/^\+/, ''),
      sender_id: this.senderId,
      type: 'plain',
      message,
    });

    let lastProblem = 'no attempt made';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (attempt > 1 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt - 1)));
      let res: Response;
      try {
        res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Unreachable or timed out: worth another go. A repeat of the same text
        // is harmless — every attempt carries the same code.
        lastProblem = `unreachable: ${(err as Error).message}`;
        continue;
      }

      const reply = (await res.json().catch(() => null)) as { status?: unknown; message?: unknown } | null;
      if (res.ok && String(reply?.status ?? '').toLowerCase() === 'success') return;

      lastProblem = `HTTP ${res.status}: ${String(reply?.message ?? reply?.status ?? 'no body')}`;
      // Only a server-side failure is worth retrying; a 4xx (bad key, bad
      // number, unregistered sender ID) will fail the same way again.
      if (res.status < 500) break;
    }
    throw new SmsDeliveryError(`Comms did not accept the SMS (${lastProblem})`);
  }
}

/** Local development: print instead of sending. */
export class ConsoleSmsSender implements SmsSender {
  async send(phoneE164: string, message: string): Promise<void> {
    console.log(`[sms:dev] → ${phoneE164}: ${message}`);
  }
}

/** Production without a Comms key: fail each send loudly rather than print codes to the log. */
export class UnconfiguredSmsSender implements SmsSender {
  async send(): Promise<void> {
    throw new SmsDeliveryError('SMS is not configured: set COMMS_API_KEY');
  }
}

export function smsSenderFromEnv(env: NodeJS.ProcessEnv = process.env): SmsSender {
  const apiKey = env['COMMS_API_KEY']?.trim();
  if (apiKey) {
    return new CommsSmsSender({
      apiKey,
      url: env['COMMS_API_URL']?.trim() || DEFAULT_COMMS_URL,
      senderId: env['SMS_SENDER_ID']?.trim() || DEFAULT_SENDER_ID,
    });
  }
  if (env['NODE_ENV'] === 'production') {
    console.error('[sms] COMMS_API_KEY is not set — account SMS codes cannot be sent');
    return new UnconfiguredSmsSender();
  }
  return new ConsoleSmsSender();
}
