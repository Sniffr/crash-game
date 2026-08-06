import { Router } from 'express';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import type { PgDepositsRepo } from '@crash/wallet/deposits-repo';

// ---------------------------------------------------------------------------
// `POST /maplerad` — Maplerad's signed collections webhook (shared account).
//
// The Maplerad account backing this integration is shared across unrelated
// products, so this endpoint will receive events that have nothing to do with
// game deposits (foreign `reference`s) — those are ignored (still 200, so
// Svix stops retrying). For a real game deposit, the transaction is
// re-verified server-side (never trust the payload alone) before the wallet
// is credited, and crediting is idempotent on the deposit `reference`
// (`deposits.markSettled` only flips a *pending* row, so a replayed event is
// a harmless no-op).
// ---------------------------------------------------------------------------

/** Minimal shape this router needs from MapleradClient — kept structural so tests can stub it. */
export interface MapleradWebhookVerifier {
  verifyWebhookSignature(svixId: string, svixTimestamp: string, rawBody: string, sigHeader: string): boolean;
  verifyTransaction(id: string): Promise<Record<string, unknown>>;
}

export type NotifyBalance = (playerId: string, balanceMinor: number, currency: string) => void;

export interface MapleradWebhookRouterDeps {
  maplerad: MapleradWebhookVerifier;
  deposits: PgDepositsRepo;
  wallet: WalletLedger;
  notifyBalance?: NotifyBalance;
}

export function createMapleradWebhookRouter(deps: MapleradWebhookRouterDeps): Router {
  const router = Router();

  router.post('/maplerad', async (req, res): Promise<void> => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
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

    const reference = evt?.data?.reference ?? '';
    if (!/^game-dep-/.test(reference)) {
      // Foreign event on the shared Maplerad account — not ours, ignore.
      res.status(200).end();
      return;
    }

    const dep = await deps.deposits.get(reference);
    if (!dep) {
      res.status(200).end();
      return;
    }

    if (evt.event === 'collection.successful') {
      // Always re-verify server-side — never trust the webhook payload alone.
      const verified = await deps.maplerad.verifyTransaction(evt.data?.id ?? '');
      const ok = (verified as { status?: unknown })?.status === 'success' || (verified as { status?: unknown })?.status === true;
      if (ok && (await deps.deposits.markSettled(reference))) {
        // markSettled only returns true on the first pending→settled
        // transition, so this branch runs at most once per reference.
        await deps.wallet.deposit(dep.playerId, dep.amountMinor, dep.currency, reference);
        const balanceMinor = await deps.wallet.balance(dep.playerId, dep.currency);
        deps.notifyBalance?.(dep.playerId, balanceMinor, dep.currency);
      }
    } else if (evt.event === 'collection.failed') {
      await deps.deposits.markFailed(reference);
    }

    res.status(200).end();
  });

  return router;
}
