import { WITHDRAWAL_REF_PREFIX, type PgWithdrawalsRepo, type Withdrawal } from '@crash/wallet/withdrawals-repo-pg';
import { isProviderRejection, type PayOutProvider, type PayoutStatus } from './types.js';

/**
 * Moves withdrawals from "funds held" to paid or refunded.
 *
 * The one rule that keeps this safe: a refund only ever follows an outcome we
 * are sure of — the provider rejecting the payout outright, or an independent
 * status lookup confirming it failed. A webhook alone can mark a payout paid
 * (when signatures are enforced), never refund it. Anything uncertain (network
 * error while sending, failure event we can't confirm) stays open for
 * reconciliation or a finance decision, because refunding a payout that
 * actually landed would pay the player twice.
 */
export class WithdrawalService {
  constructor(
    private readonly repo: PgWithdrawalsRepo,
    private readonly provider: PayOutProvider,
    private readonly log: Pick<Console, 'warn' | 'error' | 'log'> = console,
  ) {}

  /** Send a freshly-held withdrawal to the provider. Never throws. */
  async initiate(w: Withdrawal, recipientName: string): Promise<Withdrawal> {
    try {
      const r = await this.provider.payout({
        reference: w.reference,
        currency: w.currency,
        amountMinor: w.amountMinor,
        phone: w.phone,
        recipientName,
        reason: 'Withdrawal',
      });
      await this.apply(w.reference, r.status, r.providerTxnId, 'provider response');
    } catch (err) {
      if (isProviderRejection(err)) {
        await this.repo.failAndRefund(w.reference, (err as Error).message);
      } else {
        // Unknown whether the provider received it — do NOT retry or refund.
        this.log.error(`[withdrawals] payout ${w.reference} outcome unknown (left pending for review):`, err);
      }
    }
    return (await this.repo.get(w.reference)) ?? w;
  }

  /** A payout webhook (signature already verified by the router). */
  async onWebhook(payload: unknown): Promise<'ignored' | 'applied' | 'deferred'> {
    const evt = this.provider.parsePayoutEvent(payload);
    if (!evt || !evt.reference.startsWith(WITHDRAWAL_REF_PREFIX)) return 'ignored';
    const w = await this.repo.get(evt.reference);
    if (!w || w.status === 'success' || w.status === 'failed') return 'ignored';

    const txnId = evt.providerTxnId ?? w.providerTxnId;
    const confirmed = txnId ? await this.provider.lookupPayout(txnId) : null;
    if (confirmed) {
      await this.apply(w.reference, confirmed, txnId, 'confirmed lookup');
      return 'applied';
    }
    if (evt.status === 'success' && this.provider.webhookSigned) {
      await this.repo.markSucceeded(w.reference, txnId);
      return 'applied';
    }
    if (evt.status === 'pending') {
      await this.repo.markProcessing(w.reference, txnId);
      return 'applied';
    }
    this.log.warn(`[withdrawals] ${w.reference}: '${evt.status}' event could not be confirmed — left for reconciliation`);
    return 'deferred';
  }

  /** Re-check payouts that have sat unsettled; returns references still needing a human. */
  async reconcile(nowMs = Date.now(), staleMs = 10 * 60_000): Promise<string[]> {
    const needsReview: string[] = [];
    for (const w of await this.repo.listUnsettled(staleMs, nowMs)) {
      const status = w.providerTxnId ? await this.provider.lookupPayout(w.providerTxnId) : null;
      if (status && status !== 'pending') await this.apply(w.reference, status, w.providerTxnId, 'reconciliation');
      else needsReview.push(w.reference);
    }
    if (needsReview.length > 0) this.log.warn(`[withdrawals] ${needsReview.length} withdrawal(s) need review: ${needsReview.join(', ')}`);
    return needsReview;
  }

  private async apply(reference: string, status: PayoutStatus, providerTxnId: string | null, source: string): Promise<void> {
    if (status === 'success') await this.repo.markSucceeded(reference, providerTxnId);
    else if (status === 'failed') await this.repo.failAndRefund(reference, `payout failed (${source})`);
    else await this.repo.markProcessing(reference, providerTxnId);
  }
}
