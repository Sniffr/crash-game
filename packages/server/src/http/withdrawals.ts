/**
 * Player withdrawals + limits. Mounted at /api/account.
 *
 *   GET  /limits      PUBLIC      stake and withdrawal limits (minor units)
 *   POST /withdraw    player JWT  {amountMinor} → M-PESA payout to the phone on file
 *
 * Funds are held (debited) before the payout is sent; see WithdrawalService
 * for how they're released or refunded.
 */

import { Router, type Request, type Response } from 'express';
import { normalizeKePhone } from '@crash/shared/phone';
import type { PgWithdrawalsRepo } from '@crash/wallet/withdrawals-repo-pg';
import { InsufficientFundsError } from '@crash/wallet/wallet-ledger';
import type { AccountsRepo } from '../account/accounts-repo.js';
import type { PayOutProvider } from '../payments/types.js';
import type { WithdrawalService } from '../payments/withdrawals.js';
import { requirePlayerJwt } from './lobby.js';
import type { RealBetLimits } from './player-bets.js';

export interface WithdrawalLimits {
  minWithdrawalMinor: number;
  maxWithdrawalMinor: number;
}

export function loadWithdrawalLimits(env: NodeJS.ProcessEnv = process.env): WithdrawalLimits {
  const n = (key: string, dflt: number) => {
    const v = Number(env[key]);
    return Number.isInteger(v) && v > 0 ? v : dflt;
  };
  return {
    minWithdrawalMinor: n('SIMBET_MIN_WITHDRAWAL_MINOR', 5_000),
    maxWithdrawalMinor: n('SIMBET_MAX_WITHDRAWAL_MINOR', 15_000_000),
  };
}

export interface WithdrawalsRouterDeps {
  accounts: AccountsRepo;
  withdrawals: PgWithdrawalsRepo;
  service: WithdrawalService;
  provider: PayOutProvider;
  limits: WithdrawalLimits;
  betLimits: RealBetLimits;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createWithdrawalsRouter(deps: WithdrawalsRouterDeps): Router {
  const router = Router();

  router.get('/limits', (_req, res) => {
    res.json({ ...deps.betLimits, ...deps.limits });
  });

  router.post('/withdraw', requirePlayerJwt, async (req: Request, res: Response): Promise<void> => {
    try {
      const acct = await deps.accounts.getById(req.player!.playerId);
      if (!acct) return fail(res, 401, 'UNAUTHORIZED', 'account not found');
      const phone = acct.phone ? normalizeKePhone(acct.phone) : null;
      if (!phone) return fail(res, 400, 'NO_PHONE', 'Your account needs an M-PESA number to withdraw — contact support.');
      if (!deps.provider.supportsPayout(acct.currency)) {
        return fail(res, 400, 'UNSUPPORTED_CURRENCY', `Withdrawals aren't available in ${acct.currency} yet.`);
      }

      const amount = Number((req.body ?? {}).amountMinor);
      if (!Number.isInteger(amount) || amount < deps.limits.minWithdrawalMinor) {
        return fail(res, 400, 'AMOUNT_TOO_SMALL', `The minimum withdrawal is ${deps.limits.minWithdrawalMinor / 100} ${acct.currency}.`);
      }
      if (amount > deps.limits.maxWithdrawalMinor) {
        return fail(res, 400, 'AMOUNT_TOO_LARGE', `The maximum withdrawal is ${deps.limits.maxWithdrawalMinor / 100} ${acct.currency}.`);
      }

      let held;
      try {
        held = await deps.withdrawals.request({
          playerId: acct.playerId, currency: acct.currency, amountMinor: amount, phone, provider: deps.provider.name,
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) return fail(res, 402, 'INSUFFICIENT_FUNDS', 'Your balance is too low for this withdrawal.');
        throw err;
      }

      const w = await deps.service.initiate(held.withdrawal, acct.username === phone ? 'SimBet customer' : acct.username);
      const balanceMinor = w.status === 'failed' ? held.balanceMinor + w.amountMinor : held.balanceMinor;
      if (w.status === 'failed') {
        res.status(400).json({ error: { code: 'WITHDRAWAL_FAILED', message: "We couldn't send this withdrawal — your balance hasn't changed." }, balanceMinor });
        return;
      }
      res.status(202).json({
        reference: w.reference,
        status: w.status,
        amountMinor: w.amountMinor,
        currency: w.currency,
        phone,
        balanceMinor,
      });
    } catch (err) {
      console.error('[withdrawals] request failed:', err);
      if (!res.headersSent) fail(res, 500, 'INTERNAL', 'internal error');
    }
  });

  return router;
}
