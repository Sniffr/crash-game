// ---------------------------------------------------------------------------
// The contract every pay-in processor (Maplerad, Fincra) implements, so the
// deposit route and the webhook router are processor-agnostic and the money
// path exists exactly once.
// ---------------------------------------------------------------------------

export interface CollectInput {
  currency: string;
  /** Minor units. Processors that bill in major units convert internally. */
  amountMinor: number;
  phone: string;
  /** OUR merchant reference — the idempotency key the webhook is matched on. */
  reference: string;
  description: string;
  payerName?: string;
  payerEmail?: string;
}

export interface CollectResult {
  /**
   * Hosted payment page the player must be sent to, for processors that
   * collect by redirect. Absent when the processor prompts the phone directly.
   */
  redirectUrl?: string;
}

/** Normalized server-side re-verification of a collection. */
export interface VerifiedTxn {
  /** 'success' only when the money actually landed. */
  status: string;
  /** OUR merchant reference, as the processor recorded it. */
  reference: string;
  /** Minor units, when the processor reports an amount. */
  amountMinor?: number;
  currency?: string;
}

export interface ParsedEvent {
  reference: string;
  outcome: 'success' | 'failed' | 'ignore';
  /** What verifyTransaction() must be called with (a txn id or our reference). */
  txnKey: string;
}

export interface PayInProvider {
  readonly name: string;
  /** Can this processor collect `currency` with the credentials it was given? */
  supports(currency: string): boolean;
  collect(input: CollectInput): Promise<CollectResult>;
  verifyWebhookSignature(header: (name: string) => string | undefined, rawBody: string): boolean;
  parseEvent(payload: unknown): ParsedEvent;
  verifyTransaction(txnKey: string): Promise<VerifiedTxn>;
}

/**
 * Thrown when the processor *rejected* the request outright (explicit API
 * error / 4xx) — no charge was created, so failing over to the other processor
 * cannot double-charge. Network errors and timeouts deliberately do NOT get
 * this marker: the charge may well exist, so the caller must not retry
 * elsewhere.
 */
export function providerRejected(message: string): Error {
  return Object.assign(new Error(message), { rejected: true });
}

export function isProviderRejection(err: unknown): boolean {
  return (err as { rejected?: boolean } | null)?.rejected === true;
}
