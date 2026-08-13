import { Router } from 'express';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import type { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import type { PayInProvider } from '../payments/types.js';

// ---------------------------------------------------------------------------
// Signed collection webhooks, one mount per processor (`/maplerad`,
// `/fincra`). Everything processor-specific — signature scheme, event names,
// how a transaction is re-verified — lives behind PayInProvider; the money
// path below exists exactly once.
//
// Both processor accounts are shared with unrelated products, so these
// endpoints receive events that have nothing to do with game deposits
// (foreign `reference`s) — those are ignored (still 200, so the sender stops
// retrying). For a real game deposit, the transaction is re-verified
// server-side (never trust the payload alone) before the wallet is credited,
// and crediting is idempotent on the deposit `reference` (`markSettled` only
// flips a *pending* row, so a replayed event is a harmless no-op).
// ---------------------------------------------------------------------------

export type NotifyBalance = (playerId: string, balanceMinor: number, currency: string) => void;

export interface DepositWebhookRouterDeps {
  /** Mount path for this processor, e.g. '/fincra'. */
  path: string;
  provider: PayInProvider;
  deposits: PgDepositsRepo;
  wallet: WalletLedger;
  notifyBalance?: NotifyBalance;
}

export function createDepositWebhookRouter(deps: DepositWebhookRouterDeps): Router {
  const router = Router();
  const tag = `[${deps.provider.name}-webhook]`;

  router.post(deps.path, async (req, res): Promise<void> => {
    const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : (rawBody ?? '');

    if (!deps.provider.verifyWebhookSignature((name) => req.header(name), raw)) {
      res.status(400).end();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).end();
      return;
    }

    // Everything past this point talks to the processor and the database, and
    // any of it can throw (a processor 4xx, a dropped connection, a bad row).
    // Express 4 does NOT catch rejections from an async handler, so an
    // unhandled one takes the whole process down — which it did in production:
    // a webhook naming a reference Fincra could not find crash-looped the
    // server. Answer 500 instead and let the sender retry.
    try {
      await handleEvent();
    } catch (err) {
      console.error(`${tag} failed to process webhook (will be retried by the sender):`, err);
      res.status(500).end();
      return;
    }

    async function handleEvent(): Promise<void> {
    const evt = deps.provider.parseEvent(payload);
    if (!/^game-dep-/.test(evt.reference)) {
      // Foreign event on the shared processor account — not ours, ignore.
      res.status(200).end();
      return;
    }

    const dep = await deps.deposits.get(evt.reference);
    if (!dep) {
      res.status(200).end();
      return;
    }

    if (evt.outcome === 'success') {
      // Always re-verify server-side — never trust the webhook payload alone.
      const v = await deps.provider.verifyTransaction(evt.txnKey);

      // PRIMARY hard gate: the verified transaction's reference must be THIS
      // deposit's reference. Our reference is unique per collection, so this
      // proves the confirmed txn is the one we initiated for this deposit —
      // without it, a forged webhook could point at an unrelated (but real,
      // successfully-verified) transaction to credit a different deposit's
      // amount. Best-effort amount/currency checks add defense in depth.
      const statusOk = v.status === 'success';
      const referenceOk = v.reference === evt.reference;
      const amountOk = v.amountMinor === undefined || v.amountMinor === dep.amountMinor;
      const currencyOk = v.currency === undefined || v.currency === dep.currency;
      const ok = statusOk && referenceOk && amountOk && currencyOk;

      if (!ok) {
        console.warn(
          `${tag} verification did not match deposit ${evt.reference}: ` +
            `status=${v.status} reference=${v.reference} amount=${String(v.amountMinor)} currency=${String(v.currency)}`,
        );
      }

      if (ok) {
        // Credit FIRST — idempotent on the reference (partial unique index),
        // so a replay is a harmless no-op and a crash before markSettled loses
        // nothing (the retry re-credits into the same no-op, then settles).
        await deps.wallet.deposit(dep.playerId, dep.amountMinor, dep.currency, evt.reference);
        // markSettled only flips pending→settled once, so notify exactly once.
        if (await deps.deposits.markSettled(evt.reference)) {
          const balanceMinor = await deps.wallet.balance(dep.playerId, dep.currency);
          deps.notifyBalance?.(dep.playerId, balanceMinor, dep.currency);
        }
      }
    } else if (evt.outcome === 'failed') {
      await deps.deposits.markFailed(evt.reference);
    }

    res.status(200).end();
    }
  });

  return router;
}
