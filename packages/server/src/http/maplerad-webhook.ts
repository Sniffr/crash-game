import { Router } from 'express';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import type { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import type { PgWithdrawalsRepo } from '@crash/wallet/withdrawals-repo';

// ---------------------------------------------------------------------------
// `POST /maplerad` — Maplerad's signed webhook (shared account).
//
// The Maplerad account is shared across unrelated products, so this endpoint
// receives events that aren't ours (foreign `reference`s) — those are ignored
// (still 200, so Svix stops retrying). We handle two families:
//
//   collection.successful|failed  → pay-in  (deposits, ref `game-dep-…`)
//   transfer.successful|failed    → pay-out (withdrawals, ref `game-wd-…`)
//
// Every value-giving branch RE-VERIFIES the transaction server-side via
// verifyTransaction and binds it to OUR record's reference+amount+currency
// (the C1 gate) — never trusting the payload alone. This applies to the
// withdrawal *refund* path too: a forged transfer.failed must not refund a
// payout that actually went through. All state flips are idempotent CAS, so
// replayed events are harmless no-ops.
// ---------------------------------------------------------------------------

/** Minimal shape this router needs from MapleradClient — kept structural so tests can stub it. */
export interface MapleradWebhookVerifier {
  verifyWebhookSignature(svixId: string, svixTimestamp: string, rawBody: string, sigHeader: string): boolean;
  verifyTransaction(id: string): Promise<Record<string, unknown>>; // collections (pay-in)
  verifyTransfer(id: string): Promise<Record<string, unknown>>;    // transfers (pay-out)
}

export type NotifyBalance = (playerId: string, balanceMinor: number, currency: string) => void;

export interface MapleradWebhookRouterDeps {
  maplerad: MapleradWebhookVerifier;
  deposits: PgDepositsRepo;
  withdrawals: PgWithdrawalsRepo;
  wallet: WalletLedger;
  notifyBalance?: NotifyBalance;
}

interface VerifiedTxn { status?: unknown; reference?: unknown; amount?: unknown; currency?: unknown }

export function createMapleradWebhookRouter(deps: MapleradWebhookRouterDeps): Router {
  const router = Router();

  router.post('/maplerad', async (req, res): Promise<void> => {
    const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : (rawBody ?? '');
    const svixId = req.header('svix-id') ?? '';
    const svixTs = req.header('svix-timestamp') ?? '';
    const sigHeader = req.header('svix-signature') ?? '';

    if (!deps.maplerad.verifyWebhookSignature(svixId, svixTs, raw, sigHeader)) {
      res.status(400).end();
      return;
    }

    let evt: { event?: string; data?: { reference?: string; id?: string } };
    try {
      evt = JSON.parse(raw);
    } catch {
      res.status(400).end();
      return;
    }

    const event = evt.event ?? '';
    const dataRef = evt?.data?.reference ?? '';
    const dataId = evt?.data?.id ?? '';

    if (event === 'collection.successful' || event === 'collection.failed') {
      await handleCollection(deps, event, dataRef, dataId);
    } else if (event === 'transfer.successful' || event === 'transfer.failed') {
      await handleTransfer(deps, event, dataRef, dataId);
    }
    // Anything else (or a foreign/unknown reference) falls through to 200.

    res.status(200).end();
  });

  return router;
}

// ── Pay-in (deposits) ────────────────────────────────────────────────────────
async function handleCollection(
  deps: MapleradWebhookRouterDeps, event: string, reference: string, id: string,
): Promise<void> {
  if (!/^gd-/.test(reference)) return; // foreign event — not ours
  const dep = await deps.deposits.get(reference);
  if (!dep) return;

  if (event === 'collection.failed') {
    await deps.deposits.markFailed(reference);
    return;
  }

  // collection.successful — always re-verify, then bind to THIS deposit.
  const v = (await deps.maplerad.verifyTransaction(id)) as VerifiedTxn;
  if (!matches(v, reference, dep.amountMinor, dep.currency)) {
    warnMismatch('deposit', reference, v);
    return;
  }
  // Credit FIRST — idempotent on the reference (partial unique index), so a
  // replay is a no-op and a crash before markSettled loses nothing.
  await deps.wallet.deposit(dep.playerId, dep.amountMinor, dep.currency, reference);
  if (await deps.deposits.markSettled(reference)) {
    const balanceMinor = await deps.wallet.balance(dep.playerId, dep.currency);
    deps.notifyBalance?.(dep.playerId, balanceMinor, dep.currency);
  }
}

// ── Pay-out (withdrawals) ─────────────────────────────────────────────────────
async function handleTransfer(
  deps: MapleradWebhookRouterDeps, event: string, reference: string, id: string,
): Promise<void> {
  // The transfer webhook may not echo our reference — correlate by it when
  // present, else by the stored Maplerad transfer id.
  let wd = /^gw-/.test(reference) ? await deps.withdrawals.get(reference) : null;
  if (!wd && id) wd = await deps.withdrawals.getByMapleradId(id);
  if (!wd) return; // foreign transfer — not ours

  // Re-verify (via /transfers/{id}) and bind to THIS withdrawal (same C1 gate as
  // deposits). Guards BOTH the settle and the refund: a forged transfer.failed
  // must not refund a payout that genuinely succeeded, and vice-versa.
  const v = (await deps.maplerad.verifyTransfer(id)) as VerifiedTxn;
  const succeeded = String(v?.status ?? '').toLowerCase() === 'success'; // API returns 'SUCCESS'
  const boundToUs = String(v?.reference ?? '') === wd.reference
    && (v?.amount === undefined || v?.amount === null || Number(v.amount) === wd.amountMinor)
    && (v?.currency === undefined || v?.currency === null || String(v.currency) === wd.currency);
  if (!boundToUs) {
    warnMismatch('withdrawal', wd.reference, v);
    return;
  }

  if (event === 'transfer.successful') {
    if (!succeeded) { warnMismatch('withdrawal(success)', wd.reference, v); return; }
    // Funds were already debited at reserve time — just finalise.
    if (await deps.withdrawals.markSettled(wd.reference)) {
      const balanceMinor = await deps.wallet.balance(wd.playerId, wd.currency);
      deps.notifyBalance?.(wd.playerId, balanceMinor, wd.currency);
    }
  } else {
    // transfer.failed — the verified txn must genuinely NOT be a success before
    // we hand the money back, or a spoofed failure could double-pay.
    if (succeeded) { warnMismatch('withdrawal(failed?)', wd.reference, v); return; }
    if (await deps.withdrawals.markFailed(wd.reference)) {
      await deps.wallet.refund(wd.playerId, wd.amountMinor, wd.reference, wd.currency);
      const balanceMinor = await deps.wallet.balance(wd.playerId, wd.currency);
      deps.notifyBalance?.(wd.playerId, balanceMinor, wd.currency);
    }
  }
}

function matches(v: VerifiedTxn, reference: string, amountMinor: number, currency: string): boolean {
  return String(v?.status ?? '').toLowerCase() === 'success'
    && String(v?.reference ?? '') === reference
    && (v?.amount === undefined || v?.amount === null || Number(v.amount) === amountMinor)
    && (v?.currency === undefined || v?.currency === null || String(v.currency) === currency);
}

function warnMismatch(kind: string, reference: string, v: VerifiedTxn): void {
  console.warn(
    `[maplerad-webhook] verification did not match ${kind} ${reference}: ` +
      `status=${String(v?.status)} reference=${String(v?.reference)} amount=${String(v?.amount)} currency=${String(v?.currency)}`,
  );
}
