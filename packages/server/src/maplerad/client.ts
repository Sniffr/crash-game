import { createHmac, timingSafeEqual } from 'node:crypto';
import { railFor } from '@crash/wallet';
import {
  providerRejected,
  type CollectInput,
  type CollectResult,
  type PayInProvider,
  type ParsedEvent,
  type PayOutProvider,
  type PayoutEvent,
  type PayoutInput,
  type PayoutResult,
  type PayoutStatus,
  type VerifiedTxn,
} from '../payments/types.js';

export interface MapleradClientConfig {
  baseUrl: string;
  secretKey: string;
  webhookSecret: string;
  /**
   * Per-currency institution code overrides. Sandbox and live keys return
   * DIFFERENT codes from GET /institutions — prod rejected the rails default
   * for KES with "invalid bank code" — so this is a knob, not a redeploy.
   */
  institutionCodes?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface MapleradEnvelope {
  status: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Client for the Maplerad collections API (mobile money / M-PESA).
 *
 * Flow: collect fires the payment request (STK push for M-PESA KES); a signed
 * webhook (collection.successful|collection.failed) arrives when the customer
 * responds; verifyTransaction re-checks the status server-side before any
 * value is given, as the docs require.
 *
 * Auth is a static Bearer secret key. Sandbox and production share the base
 * URL — test keys (sk_test_...) route to the sandbox.
 */
const PAYOUT_SUCCESS = new Set(['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE']);
const PAYOUT_FAILED = new Set(['FAILED', 'FAILURE', 'REVERSED', 'CANCELLED', 'CANCELED', 'REJECTED', 'DECLINED']);

function payoutStatus(raw: unknown): PayoutStatus {
  const s = String(raw ?? '').toUpperCase();
  if (PAYOUT_SUCCESS.has(s)) return 'success';
  if (PAYOUT_FAILED.has(s)) return 'failed';
  return 'pending';
}

/** Maplerad takes the MSISDN without the leading '+'. Stored local formats pass through unchanged. */
const msisdn = (phone: string): string => phone.replace(/^\+/, '');

export class MapleradClient implements PayInProvider, PayOutProvider {
  readonly name = 'maplerad';
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly institutionCodes: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: MapleradClientConfig) {
    this.baseUrl = cfg.baseUrl;
    this.secretKey = cfg.secretKey;
    this.webhookSecret = cfg.webhookSecret;
    this.institutionCodes = cfg.institutionCodes ?? {};
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Momo institution code for a currency: env override first, then the rail. */
  private bankCodeFor(currency: string): string | undefined {
    const rail = railFor(currency);
    if (rail?.payIn.method !== 'momo') return undefined;
    return this.institutionCodes[currency] ?? rail.payIn.institutionCode;
  }

  /** Momo rails only, and only once the institution code has been pulled. */
  supports(currency: string): boolean {
    return this.secretKey.length > 0 && !!this.bankCodeFor(currency);
  }

  /**
   * Initiates a mobile money collection. Amounts are already in the lowest
   * denomination, which is what Maplerad bills in. meta.counterparty is
   * required in production ("request failed" without it).
   */
  async collect(input: CollectInput): Promise<CollectResult> {
    const bankCode = this.bankCodeFor(input.currency);
    if (!bankCode) throw providerRejected(`Maplerad has no institution code for ${input.currency}`);
    // Momo collections are keyed on the payer's phone — never call out without one.
    if (!input.phone) throw providerRejected(`Maplerad needs a phone number to collect ${input.currency}`);
    const rawName = input.payerName?.trim();
    const name = rawName && rawName.length > 0 ? rawName : 'Customer';
    const space = name.indexOf(' ');
    const counterparty = {
      first_name: space > 0 ? name.slice(0, space) : name,
      last_name: space > 0 ? name.slice(space + 1) : name,
      email: input.payerEmail && input.payerEmail.length > 0 ? input.payerEmail : 'unknown@stdiox.com',
      phone_number: msisdn(input.phone),
    };
    const body = {
      account_number: msisdn(input.phone),
      amount: input.amountMinor,
      bank_code: bankCode,
      currency: input.currency,
      description: input.description,
      reference: input.reference,
      meta: { counterparty },
    };
    await this.call('POST', '/collections/momo', body);
    // Nothing to redirect to — Maplerad prompts the customer's phone directly.
    return {};
  }

  parseEvent(payload: unknown): ParsedEvent {
    const p = payload as { event?: string; data?: { reference?: string; id?: string } } | null;
    const outcome = p?.event === 'collection.successful' ? 'success' : p?.event === 'collection.failed' ? 'failed' : 'ignore';
    return { reference: p?.data?.reference ?? '', outcome, txnKey: p?.data?.id ?? '' };
  }

  /** Verify a collection transaction's status. Docs: always verify before giving value. */
  async verifyTransaction(id: string): Promise<VerifiedTxn> {
    const d = this.data(await this.call('GET', `/transactions/verify/${id}`));
    return {
      status: String(d.status ?? ''),
      reference: String(d.reference ?? ''),
      amountMinor: d.amount == null ? undefined : Number(d.amount),
      currency: d.currency == null ? undefined : String(d.currency),
    };
  }

  // ---------- Payouts (mobile money transfers) ----------

  get webhookSigned(): boolean {
    return this.webhookSecret.trim().length > 0;
  }

  supportsPayout(currency: string): boolean {
    return this.secretKey.length > 0 && !!this.bankCodeFor(currency);
  }

  /**
   * POST /transfers with meta.scheme=MOBILEMONEY — KES only moves on the
   * mobile-money scheme. Same shape as the omindos Maplerad service.
   */
  async payout(input: PayoutInput): Promise<PayoutResult> {
    const bankCode = this.bankCodeFor(input.currency);
    if (!bankCode) throw providerRejected(`Maplerad has no institution code for ${input.currency}`);
    const envelope = await this.call('POST', '/transfers', {
      bank_code: bankCode,
      account_number: msisdn(input.phone),
      amount: input.amountMinor,
      currency: input.currency,
      reason: input.reason,
      reference: input.reference,
      meta: { scheme: 'MOBILEMONEY', counterparty: { name: input.recipientName } },
    });
    const d = this.data(envelope);
    return { providerTxnId: d.id == null ? null : String(d.id), status: payoutStatus(d.status) };
  }

  /** Best effort: null when the lookup isn't available, so callers never act on a guess. */
  async lookupPayout(providerTxnId: string): Promise<PayoutStatus | null> {
    try {
      const d = this.data(await this.call('GET', `/transfers/${encodeURIComponent(providerTxnId)}`));
      return d.status == null ? null : payoutStatus(d.status);
    } catch {
      return null;
    }
  }

  parsePayoutEvent(payload: unknown): PayoutEvent | null {
    const p = payload as { event?: string; data?: { reference?: string; id?: string; status?: string } } | null;
    const event = p?.event ?? '';
    if (!event.startsWith('transfer.')) return null;
    const fromEvent = /success|completed/.test(event) ? 'success' : /fail|revers|cancel|reject|declin/.test(event) ? 'failed' : null;
    return {
      reference: p?.data?.reference ?? '',
      providerTxnId: p?.data?.id == null ? null : String(p.data.id),
      status: fromEvent ?? (p?.data?.status == null ? null : payoutStatus(p.data.status)),
    };
  }

  /**
   * Verifies a Svix webhook signature (svix-id, svix-timestamp, svix-signature
   * headers). Content to sign is "id.timestamp.rawBody", HMAC-SHA256 with the
   * base64-decoded portion of the whsec_ secret; the header holds
   * space-separated "v1,<base64sig>" entries.
   */
  verifyWebhookSignature(header: (name: string) => string | undefined, rawBody: string): boolean {
    if (!this.webhookSecret || this.webhookSecret.trim().length === 0) {
      // no secret configured — skip; safe because status is re-verified via the API
      return true;
    }
    const svixId = header('svix-id') ?? '';
    const svixTimestamp = header('svix-timestamp') ?? '';
    const sigHeader = header('svix-signature') ?? '';
    if (!svixId || !svixTimestamp || !sigHeader) {
      return false;
    }
    try {
      const key = Buffer.from(this.webhookSecret.slice(this.webhookSecret.indexOf('_') + 1), 'base64');
      const expected = createHmac('sha256', key).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest();
      for (const part of sigHeader.split(' ')) {
        const comma = part.indexOf(',');
        if (comma < 0) continue;
        const given = Buffer.from(part.slice(comma + 1), 'base64');
        if (given.length === expected.length && timingSafeEqual(expected, given)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ---------- Internal ----------

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<MapleradEnvelope> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as MapleradEnvelope;
    // An explicit API-level "no" — nothing was charged, so the caller may
    // safely fail over to the other processor.
    if (json.status === false) {
      throw providerRejected(`Maplerad error: ${json.message ?? 'unknown error'}`);
    }
    return json;
  }

  private data(envelope: MapleradEnvelope): Record<string, unknown> {
    return envelope.data ?? {};
  }
}
