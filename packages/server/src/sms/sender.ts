/**
 * Outbound SMS through STDIOX SmsGtw (soa-stack/SmsGtw), which fronts the
 * Comms provider and holds its credentials — this service never sees them.
 * SmsGtw normalises Kenyan MSISDNs itself and retries internally.
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

const DEFAULT_GATEWAY_URL = 'http://smssvc.production.svc.cluster.local:1123/api/v1/sms/gtw/comms';
// SmsGtw retries 3× with 2 s back-off before answering, so allow for that.
const TIMEOUT_MS = 20_000;

const DEFAULT_SENDER_ID = 'STDIOXTIX';

export class SmsGtwSender implements SmsSender {
  constructor(
    private readonly url: string,
    private readonly senderId: string = DEFAULT_SENDER_ID,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(phoneE164: string, message: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phoneE164.replace(/^\+/, ''), message, senderId: this.senderId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SmsDeliveryError(`SMS gateway unreachable: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as { status?: unknown; message?: unknown } | null;
    if (!res.ok || body?.status !== true) {
      throw new SmsDeliveryError(`SMS gateway rejected the message: ${String(body?.message ?? res.status)}`);
    }
  }
}

/** Local development: print instead of sending. */
export class ConsoleSmsSender implements SmsSender {
  async send(phoneE164: string, message: string): Promise<void> {
    console.log(`[sms:dev] → ${phoneE164}: ${message}`);
  }
}

export function smsSenderFromEnv(env: NodeJS.ProcessEnv = process.env): SmsSender {
  const url = env['SMS_GATEWAY_URL'] ?? (env['NODE_ENV'] === 'production' ? DEFAULT_GATEWAY_URL : undefined);
  return url ? new SmsGtwSender(url, env['SMS_SENDER_ID'] || DEFAULT_SENDER_ID) : new ConsoleSmsSender();
}
