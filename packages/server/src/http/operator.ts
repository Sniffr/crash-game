/**
 * Operator-facing HTTP router — Task 3.3 Phase 3 stub, extended in Task 6.2.
 *
 * Mounts routes:
 *   - POST /sessions/:sessionId/terminate   (Task 3.3 — UNCHANGED)
 *   - GET  /games                           (Task 6.2 — signed, reads from req.operator)
 *
 * This router is mounted at /op/v1 in index.ts, AFTER the
 * verifyOperatorSignature middleware, which guarantees req.operator is set.
 *
 * The deps parameter (Task 6.2) carries betLog + registry + walletClientCache
 * so that Phase 6.3/6.4 routes can land without changing the function signature.
 * The terminate handler (Task 3.3) does NOT use deps — it imports the seamed
 * singletons (getSession, sessionSockets, etc.) directly, which is already
 * correct and is left byte-unchanged.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { getSession } from '../store.js';
import { sessionSockets, sendToSession } from '../ws/hub.js';
import { currentRound } from '../game/round.js';
import { voidOperatorBet } from '../game/bets.js';
import type { OperatorAuthedRequest } from './middleware/verify-operator-signature.js';
import type { BetLog, OperatorRegistry } from '@crash/wallet';
import type { WalletClientCache } from '../wallet/client-cache.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the operator router.
 *
 * Phase 6.3 read routes (bets, rounds, transactions, players, financial/summary)
 * will use deps.betLog and deps.registry.
 * Phase 6.4 mutating routes (durable terminate, player lock/unlock) will use
 * deps.walletClientCache.
 *
 * The Phase-3.3 terminate handler does not use deps — it imports singletons
 * directly. This is intentional: adding deps would require threaded refactors
 * across tests and provides no functional benefit for that one route. Phase 6.4
 * will extend terminate in-place without touching the Phase-3.3 core logic.
 */
export interface OperatorRouterDeps {
  betLog: BetLog;
  registry: OperatorRegistry;
  walletClientCache: WalletClientCache;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOperatorRouter(deps: OperatorRouterDeps): Router {
  const router = Router();

  // ─── POST /op/v1/sessions/:sessionId/terminate (Task 3.3 — UNCHANGED) ─────

  router.post('/sessions/:sessionId/terminate', async (req: Request, res) => {
    try {
      // req.operator is guaranteed by the verifyOperatorSignature middleware mounted
      // above this router in index.ts.
      const operator = (req as OperatorAuthedRequest).operator;
      const { sessionId } = req.params;

      // Parse optional body fields — coerce to strings to guard against
      // non-string operator payloads flowing into the session_terminated WS frame.
      const body = (req.body ?? {}) as { reason?: unknown; message?: unknown };
      const terminateReason = typeof body.reason === 'string' ? body.reason : 'operator_terminated';
      const terminateMessage = typeof body.message === 'string' ? body.message : 'Session closed by operator.';

      // 1. Look up the session
      const session = await getSession(sessionId);

      // 2. 404 for missing, demo, and cross-tenant sessions — never leak existence
      if (
        !session ||
        !session.operatorId ||
        session.operatorId !== operator.operatorId
      ) {
        res.status(404).json({
          error: { code: 'SESSION_NOT_FOUND', message: 'No such session' },
        });
        return;
      }

      // 3. Void in-flight operator bets for this session.
      //    currentRound.bets contains in-memory bets; operator bets have operatorId + betId.
      //    We mark each bet.cashedOut = true BEFORE awaiting rollback to prevent a
      //    double-handle race with the auto-cashout loop or crash handler.
      const liveBets = (currentRound?.bets ?? []).filter(
        (b) => b.playerId === sessionId && b.operatorId && !b.cashedOut,
      );

      for (const bet of liveBets) {
        // Mark cashedOut immediately so the round loop won't touch it again
        bet.cashedOut = true;
        if (bet.betId) {
          try {
            await voidOperatorBet(bet.betId, 'manual_void');
          } catch (err) {
            // RG enforcement: a bet-void failure must NOT block terminating the
            // session. The betLog row stays non-terminal and the Phase 1.7 recovery
            // worker re-drives it. Log and continue closing the socket.
            console.error('[operator] terminate: voidOperatorBet threw; continuing socket close', { betId: bet.betId, err });
          }
        }
      }

      // 4. Send the session_terminated frame to all the session's WS connections,
      //    then close the sockets with code 4001 and clean up the map.
      sendToSession(sessionId, {
        type: 'session_terminated',
        data: { reason: terminateReason, message: terminateMessage },
      });

      const sockets = sessionSockets.get(sessionId);
      if (sockets) {
        for (const ws of sockets) {
          ws.close(4001, 'session_terminated');
        }
        sessionSockets.delete(sessionId);
      }

      // 5. Respond 204 No Content
      res.status(204).end();
    } catch (err) {
      console.error('[operator] terminate unexpected error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'terminate failed' } });
      }
    }
  });

  // ─── GET /op/v1/games (Task 6.2 — spec §3.2) ────────────────────────────────
  //
  // Signed route (verifyOperatorSignature runs before this router).
  // Returns the games available to the calling operator, sourced entirely from
  // req.operator (already verified and attached by the auth middleware).
  //
  // Data notes:
  //   - rtpVariant: per-operator setting stored in the operators table.
  //   - enabled: always true — per-operator-game disable is a Phase-future
  //     feature (requires a per-operator-game config table). Noted in spec §4.9.
  //   - minBetMinor / maxBetMinor: operator-wide values fanned out per currency.
  //     The operator model stores a single min/max (not per-currency). This is an
  //     honest representation of the current data model; per-currency limits are
  //     a Phase-future addition.

  router.get('/games', (req: Request, res) => {
    const op = (req as OperatorAuthedRequest).operator;

    // Fan out min/maxBetMinor per currency. The operator model has a single
    // operator-wide min/max — fan it out across all enabled currencies.
    const minBetMinor: Record<string, number> = {};
    const maxBetMinor: Record<string, number> = {};
    for (const currency of op.currencies) {
      minBetMinor[currency] = op.minBetMinor;
      maxBetMinor[currency] = op.maxBetMinor;
    }

    res.json({
      games: [
        {
          gameId: 'galaxy-crash',
          name: 'Galaxy Crash',
          rtpVariant: op.rtpVariant,
          enabled: true, // per-operator-game disable is Phase-future (no per-game table in v1)
          minBetMinor,
          maxBetMinor,
        },
      ],
    });
  });

  return router;
}
