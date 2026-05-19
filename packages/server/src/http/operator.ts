/**
 * Operator-facing HTTP router — Task 3.3 Phase 3 stub.
 *
 * Mounts ONE route: POST /sessions/:sessionId/terminate
 *
 * This router is mounted at /op/v1 in index.ts, AFTER the
 * verifyOperatorSignature middleware, which guarantees req.operator is set.
 *
 * Phase 6 will add the rest of the backoffice routes.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { getSession } from '../store';
import { sessionSockets, sendToSession } from '../ws/hub';
import { currentRound } from '../game/round';
import { voidOperatorBet } from '../game/bets';
import type { OperatorAuthedRequest } from './middleware/verify-operator-signature';

export function createOperatorRouter(): Router {
  const router = Router();

  // POST /op/v1/sessions/:sessionId/terminate
  router.post('/sessions/:sessionId/terminate', async (req: Request, res) => {
    try {
      // req.operator is guaranteed by the verifyOperatorSignature middleware mounted
      // above this router in index.ts.
      const operator = (req as OperatorAuthedRequest).operator;
      const { sessionId } = req.params;

      // Parse optional body fields
      const body = (req.body ?? {}) as { reason?: string; message?: string };
      const terminateReason = body.reason ?? 'operator_terminated';
      const terminateMessage = body.message ?? 'Session closed by operator.';

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
          // Best-effort; voidOperatorBet never throws (logs + returns 'skipped' on failure)
          await voidOperatorBet(bet.betId, 'manual_void');
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

  return router;
}
