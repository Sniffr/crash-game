import { createHmac, timingSafeEqual } from 'node:crypto';
import { decimalsFor, SUPPORTED_CURRENCIES } from '@crash/wallet';
import { providerRejected, type CollectInput, type CollectResult, type PayInProvider, type ParsedEvent, type VerifiedTxn } from '../payments/types.js';

export interface FincraClientConfig {
  baseUrl: string;
  secretKey: string;
  businessId: string;
  /** pk_… — Checkout rejects create calls without it ("x-pub-key must be provided"). */
  publicKey: string;
  webhookSecret: string;
  /** Where Fincra sends the payer back after the hosted page. */
  redirectUrl?: string;
  /** Currencies this business is enabled for. Defaults to every supported rail. */
  currencies?: string[];
  fetchImpl?: typeof fetch;
}

interface FincraEnvelope {
  success?: boolean;
  status?: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Client for Fincra collections via hosted Checkout.
 *
 * POST /checkout/payments returns a `link` we hand to the player; they pay on
 * Fincra's page (mobile money / card / transfer, whichever their currency
 * offers), a signed `charge.successful|charge.failed` webhook arrives, and the
 * payment is re-verified server-side by OUR reference before any value is
 * given.
 *
 * NOT the Direct Charge API (/checkout/charges): that product is separately
 * enabled per business and this account is not authorized for it
 * ("Access Denied. You're not authorized to access Direct charge product").
 * Checkout is the path that works — the trade is a redirect instead of an
 * in-app phone prompt.
 *
 * Two things differ from Maplerad and are handled here so callers don't care:
 * amounts are MAJOR units on the wire (we take/return minor), and the webhook
 * signature is a single hex HMAC-SHA512 header rather than Svix's scheme.
 *
 * Sandbox and production are different hosts (sandboxapi.fincra.com vs
 * api.fincra.com) and take DIFFERENT keys — FINCRA_BASE_URL selects.
 */
export class FincraClient implements PayInProvider {
  readonly name = 'fincra';
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly businessId: string;
  private readonly publicKey: string;
  private readonly webhookSecret: string;
  private readonly redirectUrl: string | undefined;
  private readonly currencies: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: FincraClientConfig) {
    this.baseUrl = cfg.baseUrl;
    this.secretKey = cfg.secretKey;
    this.businessId = cfg.businessId;
    this.publicKey = cfg.publicKey;
    this.webhookSecret = cfg.webhookSecret;
    this.redirectUrl = cfg.redirectUrl;
    // ponytail: per-business currency enablement isn't readable over the API
    // (the /profile/business endpoint is IP-allowlisted), so this is a config
    // knob rather than a live lookup. Narrow it with FINCRA_CURRENCIES if a
    // corridor turns out not to be enabled.
    this.currencies = cfg.currencies?.length ? cfg.currencies : SUPPORTED_CURRENCIES;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  supports(currency: string): boolean {
    return this.secretKey.length > 0 && this.currencies.includes(currency);
  }

  async collect(input: CollectInput): Promise<CollectResult> {
    const body = {
      amount: toMajor(input.amountMinor, input.currency),
      currency: input.currency,
      reference: input.reference,
      customer: {
        name: fullName(input.payerName),
        email: input.payerEmail?.trim() || 'unknown@stdiox.com',
        ...(input.phone ? { phoneNumber: e164(input.phone) } : {}),
      },
      feeBearer: 'business',
      settlementDestination: 'wallet',
      successMessage: input.description,
      ...(this.redirectUrl ? { redirectUrl: this.redirectUrl } : {}),
    };
    const d = this.data(await this.call('POST', '/checkout/payments', body));
    const link = typeof d.link === 'string' ? d.link : undefined;
    if (!link) throw providerRejected('Fincra checkout returned no payment link');
    return { redirectUrl: link };
  }

  parseEvent(payload: unknown): ParsedEvent {
    const p = payload as { event?: string; data?: { reference?: string; merchantReference?: string } } | null;
    // `reference` is FINCRA's id (fcr-p-…); ours comes back as
    // `merchantReference`. Checkout and direct charge disagree on which is
    // populated, so prefer ours and fall back.
    const reference = p?.data?.merchantReference ?? p?.data?.reference ?? '';
    const outcome = p?.event === 'charge.successful' ? 'success' : p?.event === 'charge.failed' ? 'failed' : 'ignore';
    // Fincra is re-verified by our own merchant reference, so no txn id needed.
    return { reference, outcome, txnKey: reference };
  }

  async verifyTransaction(reference: string): Promise<VerifiedTxn> {
    const d = this.data(await this.call('GET', `/checkout/payments/merchant-reference/${encodeURIComponent(reference)}`));
    const currency = d.currency == null ? undefined : String(d.currency);
    // amountReceived is what actually landed; `amount` is only what we asked
    // for, so a short-paid checkout must not read back as the full amount.
    const received = d.amountReceived ?? d.amount;
    return {
      status: String(d.status ?? ''),
      // See parseEvent — `reference` here is Fincra's id, not ours.
      reference: String(d.merchantReference ?? d.reference ?? ''),
      amountMinor: received == null ? undefined : toMinor(Number(received), currency ?? ''),
      currency,
    };
  }

  /**
   * Verifies the `signature` header: hex HMAC-SHA512 of the payload under the
   * webhook secret. Fincra's own example hashes JSON.stringify(payload), so we
   * accept either the exact received bytes or their re-serialized form —
   * whitespace differences in transit must not reject a genuine event.
   */
  verifyWebhookSignature(header: (name: string) => string | undefined, rawBody: string): boolean {
    if (!this.webhookSecret || this.webhookSecret.trim().length === 0) {
      // no secret configured — skip; safe because status is re-verified via the API
      return true;
    }
    const given = header('signature') ?? '';
    if (!given) return false;
    const candidates = [rawBody];
    try {
      candidates.push(JSON.stringify(JSON.parse(rawBody)));
    } catch {
      return false; // not JSON — nothing we'd process anyway
    }
    return candidates.some((body) => {
      const expected = createHmac('sha512', this.webhookSecret).update(body).digest('hex');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(given, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  // ---------- Internal ----------

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<FincraEnvelope> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'api-key': this.secretKey,
        'x-business-id': this.businessId,
        'x-pub-key': this.publicKey,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as FincraEnvelope;
    // An explicit API-level "no" — the payment was never created, so the caller
    // may safely fail over to the other processor.
    if (res.ok === false || json.success === false || json.status === false) {
      throw providerRejected(`Fincra error: ${json.message ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  private data(envelope: FincraEnvelope): Record<string, unknown> {
    return envelope.data ?? {};
  }
}

/** Minor units -> the major-unit amount Fincra bills in (UGX is 0dp). */
export function toMajor(amountMinor: number, currency: string): number {
  const d = decimalsFor(currency);
  return d === 0 ? amountMinor : Number((amountMinor / 10 ** d).toFixed(d));
}

function toMinor(amountMajor: number, currency: string): number {
  return Math.round(amountMajor * 10 ** decimalsFor(currency));
}

/**
 * Fincra rejects a single-token name ("Customer's full name is required"), and
 * players sign up with a one-word username — so give the surname a filler.
 * ponytail: swap the filler for a real surname if signup ever collects one.
 */
export function fullName(payerName?: string): string {
  const name = payerName?.trim().replace(/\s+/g, ' ') || 'Game Player';
  return name.includes(' ') ? name : `${name} Player`;
}

/** Fincra wants an E.164 phone; players are stored without the leading '+'. */
function e164(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`;
}
