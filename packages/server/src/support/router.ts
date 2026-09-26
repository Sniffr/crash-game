/**
 * Player side of the support chat. Mounted at /api/account/support.
 *
 *   GET  /messages   player JWT  the thread (marks agent replies read)
 *   GET  /unread     player JWT  {count} of unread agent replies
 *   POST /messages   player JWT  {body}
 */

import { Router, type Request, type Response } from 'express';
import { requirePlayerJwt } from '../http/lobby.js';
import type { SupportRepo } from './support-repo.js';

const MAX_PER_MINUTE = 10;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createSupportRouter(deps: { support: SupportRepo; now?: () => number }): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  router.use(requirePlayerJwt);

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        console.error('[support] request failed:', err);
        if (!res.headersSent) fail(res, 500, 'INTERNAL', 'internal error');
      }
    };

  router.get('/messages', handle(async (req, res) => {
    const playerId = req.player!.playerId;
    await deps.support.markRead(playerId, 'player');
    res.json({ messages: await deps.support.messages(playerId) });
  }));

  router.get('/unread', handle(async (req, res) => {
    res.json({ count: await deps.support.unreadForPlayer(req.player!.playerId) });
  }));

  router.post('/messages', handle(async (req, res) => {
    const playerId = req.player!.playerId;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return fail(res, 400, 'EMPTY_MESSAGE', 'Type a message first.');
    if (body.length > 2000) return fail(res, 400, 'MESSAGE_TOO_LONG', 'Messages can be up to 2,000 characters.');
    if ((await deps.support.recentFromPlayer(playerId, 60_000, now())) >= MAX_PER_MINUTE) {
      return fail(res, 429, 'SLOW_DOWN', 'You are sending messages too quickly — wait a moment.');
    }
    res.status(201).json({ message: await deps.support.post(playerId, 'player', body) });
  }));

  return router;
}
