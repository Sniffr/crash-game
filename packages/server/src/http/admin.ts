/**
 * Admin HTTP router — Task 4.2 Phase-4 STUB.
 *
 * ONE route: POST /bet-log/:betId/force-credit
 * Mounted at /admin/v1 in index.ts, AFTER requireAdminToken middleware.
 *
 * Re-issues /win with the ORIGINAL winTxnId (Phase 2.2 + operator §9 dedupe
 * make this safe even if the operator already credited), transitions
 * WIN_FAILED → SETTLED on success, and writes an immutable admin_audit row.
 *
 * Phase 5.2 adds JWT/roles/more routes — that is out of scope here.
 */

import { Router } from 'express';
import type { WalletClient, BetLog, WinRequest } from '@crash/wallet';
import { WalletError } from '@crash/wallet';
import type { WalletClientCache } from '../wallet/client-cache.js';
import type { AdminAudit } from '../admin/admin-store.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  walletClientCache: WalletClientCache;
  betLog: BetLog;
  adminAudit: AdminAudit;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  // POST /admin/v1/bet-log/:betId/force-credit
  router.post('/bet-log/:betId/force-credit', async (req, res): Promise<void> => {
    const actor: string =
      (req as unknown as Record<string, unknown>)['adminActor'] as string ?? 'admin-token';
    const betId = req.params['betId'];

    try {
      // Step 1: Validate reason body field.
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = body.reason;

      if (typeof reason !== 'string' || !reason.trim()) {
        // 400 — bad request. Choice: do NOT audit this (pre-validation, betId
        // may not even exist; auditing every malformed request would pollute the
        // audit log with noise before any bet lookup. The audit trail is for
        // actions taken on bets, not bad inputs).
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'reason (non-empty string) required',
          },
        });
        return;
      }

      // Step 2: Fetch the bet row.
      const row = deps.betLog.getById(betId);
      if (!row) {
        deps.adminAudit.record({
          actor,
          action: 'force_credit',
          target: betId,
          payload: { reason, result: 'not_found' },
        });
        res.status(404).json({
          error: { code: 'BET_NOT_FOUND' },
        });
        return;
      }

      // Step 3: Guard state — only WIN_FAILED can be force-credited.
      if (row.state !== 'WIN_FAILED') {
        deps.adminAudit.record({
          actor,
          action: 'force_credit',
          target: betId,
          payload: { reason, result: 'rejected_state', state: row.state },
        });
        res.status(409).json({
          error: {
            code: 'BET_NOT_WIN_FAILED',
            message: `bet is ${row.state}, only WIN_FAILED can be force-credited`,
          },
        });
        return;
      }

      // Step 4: Integrity guard — ensure we have enough data to reconstruct the win.
      if (row.winTxnId == null || row.winAmountMinor == null || row.multiplier == null) {
        deps.adminAudit.record({
          actor,
          action: 'force_credit',
          target: betId,
          payload: {
            reason,
            result: 'not_reconstructible',
            missingFields: [
              row.winTxnId == null ? 'winTxnId' : null,
              row.winAmountMinor == null ? 'winAmountMinor' : null,
              row.multiplier == null ? 'multiplier' : null,
            ].filter((s): s is string => s !== null),
          },
        });
        res.status(409).json({
          error: {
            code: 'BET_NOT_RECONSTRUCTIBLE',
            message: 'missing winTxnId/winAmountMinor/multiplier',
          },
        });
        return;
      }

      // Step 5: Get the operator wallet client.
      const client: WalletClient | null = deps.walletClientCache.get(row.operatorId);
      if (!client) {
        deps.adminAudit.record({
          actor,
          action: 'force_credit',
          target: betId,
          payload: { reason, result: 'operator_unavailable', operatorId: row.operatorId },
        });
        res.status(503).json({
          error: { code: 'OPERATOR_UNAVAILABLE' },
        });
        return;
      }

      // Step 6: Build the WinRequest — use the ORIGINAL winTxnId.
      // txnId: row.winTxnId is the ORIGINAL winTxnId persisted at SETTLING (Phase 1.6).
      // Re-issuing with the same txnId is safe because:
      //   - Phase 2.2 outbound idempotency: if this process already recorded a
      //     successful /win for this txnId, the WalletClient short-circuits and
      //     replays the cached result without an HTTP call.
      //   - Operator §9: the operator deduplicates by txnId server-side, so even
      //     if the operator already credited the player, re-sending the same txnId
      //     returns a success response without a double credit.
      // Minting a NEW winTxnId would risk a real double credit — do NOT do that.
      const winReq: WinRequest = {
        playerId: row.playerId,
        sessionId: row.sessionId,
        roundId: row.roundId,
        betId: row.betId,
        betTxnId: row.betTxnId,
        txnId: row.winTxnId,          // ORIGINAL winTxnId — see comment above
        amountMinor: row.winAmountMinor,
        multiplier: row.multiplier,
        currency: row.currency,
        settledAt: Math.floor(Date.now() / 1000),
      };

      // Step 7: Call the operator /win endpoint.
      let winResp: Awaited<ReturnType<WalletClient['win']>>;
      try {
        winResp = await client.win(winReq);
      } catch (err) {
        if (err instanceof WalletError) {
          // Operator still won't pay — row stays WIN_FAILED (NO transition).
          // On-call must escalate — this is an operator-side problem.
          deps.adminAudit.record({
            actor,
            action: 'force_credit',
            target: betId,
            payload: {
              reason,
              result: 'failed',
              error: err.code,
            },
          });
          res.status(502).json({
            ok: false,
            betId,
            state: 'WIN_FAILED',
            error: err.code,
            message: err.message,
          });
          return;
        }
        // Unexpected non-WalletError — fall through to outer catch.
        throw err;
      }

      // Step 7 (success): transition WIN_FAILED → SETTLED.
      try {
        deps.betLog.transition(betId, 'win_force_credited', {
          winOpTxnId: winResp.operatorTxnId,
        });
      } catch (transitionErr) {
        // The operator credited but our row didn't move — data integrity event.
        // Log loudly (same class as WIN_FAILED), audit, respond 409.
        // Do NOT silently leave a credited-but-not-SETTLED state.
        console.error(
          '[admin] force_credit: transition win_force_credited failed AFTER operator credited player.',
          'This is a data-integrity event — the operator credited but betLog row did not move.',
          { betId, operatorTxnId: winResp.operatorTxnId, transitionErr },
        );
        deps.adminAudit.record({
          actor,
          action: 'force_credit',
          target: betId,
          payload: {
            reason,
            result: 'transition_error',
            operatorTxnId: winResp.operatorTxnId,
          },
        });
        res.status(409).json({
          error: { code: 'TRANSITION_FAILED' },
        });
        return;
      }

      // Step 7 (success — fully settled): write audit row and respond.
      deps.adminAudit.record({
        actor,
        action: 'force_credit',
        target: betId,
        payload: {
          reason,
          result: 'settled',
          operatorTxnId: winResp.operatorTxnId,
          balanceMinor: winResp.balanceMinor,
        },
      });

      res.status(200).json({
        ok: true,
        betId,
        state: 'SETTLED',
        operatorTxnId: winResp.operatorTxnId,
      });
    } catch (err) {
      // Step 8: Unexpected catch-all — audit best-effort and respond 500.
      console.error('[admin] force_credit: unexpected error:', err);
      try {
        deps.adminAudit.record({
          actor,
          action: 'force_credit',
          target: betId,
          payload: { result: 'internal_error' },
        });
      } catch {
        // best-effort only
      }
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL' } });
      }
    }
  });

  return router;
}
