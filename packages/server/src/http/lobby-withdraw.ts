import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { PlayersRepo } from '@crash/wallet/players-repo';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import { InsufficientFundsError } from '@crash/wallet/wallet-ledger';
import type { PgWithdrawalsRepo } from '@crash/wallet/withdrawals-repo';
import { railFor, isPayoutable } from '@crash/wallet';
import { requirePlayerJwt } from './lobby.js';

// ---------------------------------------------------------------------------
// `POST /api/lobby/withdraw` — cash out to the player's on-file mobile-money
// number via a Maplerad transfer (payout). Mounted at /api/lobby.
//
// Flow (funds safety first): record a pending withdrawal, RESERVE (debit) the
// wallet atomically & overdraw-guarded, then initiate the disbursement. If the
// disbursement call fails, the reserved amount is refunded immediately. The
// signed transfer.successful / transfer.failed webhook finalises the row later
// (settle, or fail + refund).
// ---------------------------------------------------------------------------

/** Minimal shape this router needs from MapleradClient — structural so tests can stub it. */
export interface MapleradDisburser {
  disburse(input: {
    currency: string;
    amountMinor: number;
    phone: string;
    bankCode: string;
    reference: string;
    reason: string;
    payeeName?: string;
  }): Promise<Record<string, unknown>>;
}

export interface LobbyWithdrawRouterDeps {
  players: PlayersRepo;
  withdrawals: PgWithdrawalsRepo;
  maplerad: MapleradDisburser;
  wallet: WalletLedger;
}

export function createLobbyWithdrawRouter(deps: LobbyWithdrawRouterDeps): Router {
  const router = Router();

  router.post('/withdraw', requirePlayerJwt, async (req, res): Promise<void> => {
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
    if (!rail || !isPayoutable(player.currency)) {
      res.status(400).json({ error: { code: 'WITHDRAW_UNAVAILABLE', message: `${player.currency} withdrawals not available yet` } });
      return;
    }

    if (rail.contact === 'phone' && !player.phone) {
      res.status(400).json({ error: { code: 'CONTACT_MISSING', message: 'A phone number is required on file for this payout method' } });
      return;
    }

    // Short ref (Maplerad rejects long references); uniqueness from the uuid.
    const reference = `gw-${randomUUID()}`;
    await deps.withdrawals.createPending({ reference, playerId, currency: player.currency, amountMinor });

    // Reserve (debit) first — overdraw-guarded. Never disburse un-reserved funds.
    try {
      await deps.wallet.reserve(playerId, amountMinor, reference, player.currency);
    } catch (err) {
      await deps.withdrawals.markFailed(reference);
      if (err instanceof InsufficientFundsError) {
        res.status(400).json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'Not enough balance for this withdrawal' } });
        return;
      }
      throw err;
    }

    // Initiate the payout. On failure, refund the reserved amount right away.
    try {
      const result = await deps.maplerad.disburse({
        currency: player.currency,
        amountMinor,
        phone: player.phone!,
        bankCode: rail.payOut.institutionCode!,
        reference,
        reason: 'Game withdrawal',
        payeeName: player.username,
      });
      const mapleradId = String(result.id ?? '');
      if (mapleradId) await deps.withdrawals.setMapleradId(reference, mapleradId);
    } catch {
      await deps.wallet.refund(playerId, amountMinor, reference, player.currency);
      await deps.withdrawals.markFailed(reference);
      res.status(502).json({ error: { code: 'DISBURSE_FAILED', message: 'Could not start the payout. Your balance is unchanged.' } });
      return;
    }

    res.json({ reference, status: 'pending', message: 'Your withdrawal is on its way to your M-PESA number.' });
  });

  return router;
}
