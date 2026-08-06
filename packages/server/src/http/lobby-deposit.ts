import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { PlayersRepo } from '@crash/wallet/players-repo';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import type { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import { railFor, isDepositable } from '@crash/wallet';
import { requirePlayerJwt } from './lobby.js';

// ---------------------------------------------------------------------------
// `POST /api/lobby/deposit` — start a Maplerad mobile-money collection and
// record a pending deposit. Mounted at /api/lobby (alongside the auth
// router). The signed webhook (a later task) settles the deposit and credits
// the wallet once Maplerad confirms the customer approved the STK prompt.
// ---------------------------------------------------------------------------

/** Minimal shape this router needs from MapleradClient — kept structural so tests can stub it. */
export interface MapleradCollector {
  collect(input: {
    currency: string;
    amountMinor: number;
    phone: string;
    bankCode: string;
    reference: string;
    description: string;
    payerName?: string;
    payerEmail?: string;
  }): Promise<Record<string, unknown>>;
}

export interface LobbyDepositRouterDeps {
  players: PlayersRepo;
  deposits: PgDepositsRepo;
  maplerad: MapleradCollector;
  wallet: WalletLedger;
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
    if (!rail || !isDepositable(player.currency)) {
      res.status(400).json({ error: { code: 'DEPOSIT_UNAVAILABLE', message: `${player.currency} deposits not available yet` } });
      return;
    }

    const reference = `game-dep-${playerId}-${randomUUID()}`;
    await deps.deposits.createPending({ reference, playerId, currency: player.currency, amountMinor });
    await deps.maplerad.collect({
      currency: player.currency,
      amountMinor,
      phone: player.phone!,
      bankCode: rail.payIn.institutionCode!,
      reference,
      description: 'Game deposit',
      payerName: player.username,
    });

    res.json({ reference, status: 'pending', message: 'Check your phone to approve the M-PESA prompt.' });
  });

  return router;
}
