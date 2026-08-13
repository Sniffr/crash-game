import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { PlayersRepo } from '@crash/wallet/players-repo';
import type { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import { railFor } from '@crash/wallet';
import { isProviderRejection, type PayInProvider } from '../payments/types.js';
import { requirePlayerJwt } from './lobby.js';

// ---------------------------------------------------------------------------
// `POST /api/lobby/deposit` — start a mobile-money collection and record a
// pending deposit. Mounted at /api/lobby (alongside the auth router). The
// signed webhook settles the deposit and credits the wallet once the customer
// approves the prompt on their phone.
//
// `providers` is tried in order: the first processor that both supports the
// player's currency and accepts the charge wins. Fail-over only happens on an
// explicit rejection (see isProviderRejection) — on a timeout the charge may
// already exist, so retrying elsewhere could double-charge the player.
// ---------------------------------------------------------------------------

export interface LobbyDepositRouterDeps {
  players: PlayersRepo;
  deposits: PgDepositsRepo;
  providers: PayInProvider[];
}

export function createLobbyDepositRouter(deps: LobbyDepositRouterDeps): Router {
  const router = Router();

  router.post('/deposit', requirePlayerJwt, async (req, res): Promise<void> => {
    const playerId = req.player!.playerId;

    const amountMinor = Number((req.body ?? {}).amountMinor);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      res.status(400).json({ error: { code: 'INVALID_AMOUNT', message: 'amountMinor must be a positive integer (minor units)' } });
      return;
    }

    const player = await deps.players.getById(playerId);
    if (!player) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Player not found' } });
      return;
    }

    const rail = railFor(player.currency);
    const candidates = rail ? deps.providers.filter((p) => p.supports(player.currency)) : [];
    if (candidates.length === 0) {
      res.status(400).json({ error: { code: 'DEPOSIT_UNAVAILABLE', message: `${player.currency} deposits not available yet` } });
      return;
    }

    if (rail!.contact === 'phone' && !player.phone) {
      res.status(400).json({ error: { code: 'CONTACT_MISSING', message: 'A phone number is required on file for this deposit method' } });
      return;
    }

    const reference = `game-dep-${playerId}-${randomUUID()}`;
    await deps.deposits.createPending({ reference, playerId, currency: player.currency, amountMinor });

    const input = {
      currency: player.currency,
      amountMinor,
      ...(player.phone ? { phone: player.phone } : {}),
      reference,
      description: 'Game deposit',
      payerName: player.username,
      ...(player.email ? { payerEmail: player.email } : {}),
    };

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      try {
        const { redirectUrl } = await provider.collect(input);
        res.json({
          reference,
          status: 'pending',
          provider: provider.name,
          ...(redirectUrl ? { redirectUrl } : {}),
          message: redirectUrl
            ? 'Complete your payment on the page we just opened.'
            : 'Check your phone to approve the payment prompt.',
        });
        return;
      } catch (err) {
        const last = i === candidates.length - 1;
        // Anything other than an outright rejection may have created a charge —
        // stop rather than risk charging the player on a second processor.
        if (!isProviderRejection(err) || last) {
          console.error(`[deposit] ${provider.name} collect failed for ${reference}:`, err);
          await deps.deposits.markFailed(reference);
          res.status(502).json({ error: { code: 'DEPOSIT_FAILED', message: 'Could not reach a payment processor. Please try again.' } });
          return;
        }
        console.warn(`[deposit] ${provider.name} rejected ${reference}, failing over:`, err);
      }
    }
  });

  return router;
}
