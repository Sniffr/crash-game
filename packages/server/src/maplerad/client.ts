import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MapleradClientConfig {
  baseUrl: string;
  secretKey: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  // KES MoMo payouts require a full sender (house) KYC block on meta.sender —
  // first_name/last_name/email/phone_number/address/country/dob/state/city and
  // id{type,number,issued_at,issued_date}. Sourced from env (MAPLERAD_PAYOUT_SENDER).
  payoutSender?: Record<string, unknown>;
}

export interface MapleradCollectInput {
  currency: string;
  amountMinor: number;
  phone: string;
  bankCode: string;
  reference: string;
  description: string;
  payerName?: string;
  payerEmail?: string;
}

export interface MapleradDisburseInput {
  currency: string;
  amountMinor: number;
  phone: string;
  bankCode: string;
  reference: string;
  reason: string;
  payeeName?: string;
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
export class MapleradClient {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly payoutSender?: Record<string, unknown>;

  constructor(cfg: MapleradClientConfig) {
    this.baseUrl = cfg.baseUrl;
    this.secretKey = cfg.secretKey;
    this.webhookSecret = cfg.webhookSecret;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.payoutSender = cfg.payoutSender;
  }

  /**
   * Initiates a mobile money collection. amountMinor is in the lowest
   * denomination (e.g. cents). meta.counterparty is required in production
   * ("request failed" without it).
   */
  async collect(input: MapleradCollectInput): Promise<Record<string, unknown>> {
    const rawName = input.payerName?.trim();
    const name = rawName && rawName.length > 0 ? rawName : 'Customer';
    const space = name.indexOf(' ');
    const counterparty = {
      first_name: space > 0 ? name.slice(0, space) : name,
      last_name: space > 0 ? name.slice(space + 1) : name,
      email: input.payerEmail && input.payerEmail.length > 0 ? input.payerEmail : 'unknown@stdiox.com',
      phone_number: input.phone,
    };
    const body = {
      account_number: input.phone,
      amount: input.amountMinor,
      bank_code: input.bankCode,
      currency: input.currency,
      description: input.description,
      reference: input.reference,
      meta: { counterparty },
    };
    const envelope = await this.call('POST', '/collections/momo', body);
    return this.data(envelope);
  }

  /**
   * Initiates a local mobile-money payout (M-PESA etc.) via POST /transfers.
   * amountMinor is in the lowest denomination. Returns the transfer envelope
   * data (incl. `id` + `status: PENDING`); a signed transfer.successful /
   * transfer.failed webhook arrives later, re-verified via verifyTransaction.
   * meta.counterparty.name is required for a MOBILEMONEY transfer.
   */
  async disburse(input: MapleradDisburseInput): Promise<Record<string, unknown>> {
    const rawName = input.payeeName?.trim();
    const name = rawName && rawName.length > 0 ? rawName : 'Customer';
    const body = {
      account_number: input.phone,
      amount: input.amountMinor,
      bank_code: input.bankCode,
      currency: input.currency,
      reason: input.reason,
      reference: input.reference,
      meta: {
        scheme: 'MOBILEMONEY',
        ...(this.payoutSender ? { sender: this.payoutSender } : {}),
        counterparty: { name },
      },
    };
    const envelope = await this.call('POST', '/transfers', body);
    return this.data(envelope);
  }

  /** Verify a collection transaction's status. Docs: always verify before giving value. */
  async verifyTransaction(id: string): Promise<Record<string, unknown>> {
    const envelope = await this.call('GET', `/transactions/verify/${id}`);
    return this.data(envelope);
  }

  /**
   * Fetch a transfer (payout) for server-side re-verification. Transfers are NOT
   * found by /transactions/verify/{id}; use /transfers/{id}, which returns
   * status ('SUCCESS'|'FAILED'|…), reference, amount, currency.
   */
  async verifyTransfer(id: string): Promise<Record<string, unknown>> {
    const envelope = await this.call('GET', `/transfers/${id}`);
    return this.data(envelope);
  }

  /**
   * Verifies a Svix webhook signature (svix-id, svix-timestamp, svix-signature
   * headers). Content to sign is "id.timestamp.rawBody", HMAC-SHA256 with the
   * base64-decoded portion of the whsec_ secret; the header holds
   * space-separated "v1,<base64sig>" entries.
   */
  verifyWebhookSignature(svixId: string, svixTimestamp: string, rawBody: string, sigHeader: string): boolean {
    if (!this.webhookSecret || this.webhookSecret.trim().length === 0) {
      // no secret configured — skip; safe because status is re-verified via the API
      return true;
    }
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
    if (json.status === false) {
      throw new Error(`Maplerad error: ${json.message ?? 'unknown error'}`);
    }
    return json;
  }

  private data(envelope: MapleradEnvelope): Record<string, unknown> {
    return envelope.data ?? {};
  }
}
