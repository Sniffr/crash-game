/**
 * Staff operations for the SimBet money + support flows. Mounted at /admin/v1,
 * ahead of the main admin router; admin JWT required.
 *
 *   GET  /withdrawals?status=           finance|support  latest withdrawals (default: needing attention)
 *   POST /withdrawals/:reference/resolve finance         {outcome:'success'|'failed', note} — for payouts
 *                                                        the provider couldn't confirm either way
 *   GET  /support/threads               support         the inbox
 *   GET  /support/threads/:playerId     support         a thread (marks player messages read)
 *   POST /support/threads/:playerId/messages  support   {body} — reply as the signed-in admin
 */

import { Router, type Request, type Response } from 'express';
import type { PgWithdrawalsRepo, WithdrawalStatus } from '@crash/wallet/withdrawals-repo-pg';
import { requireAdminJwt, requireRole } from './middleware/admin-auth.js';
import type { SupportRepo } from '../support/support-repo.js';

interface AdminAuditLike {
  record(entry: { actor: string; action: string; target: string; payload?: unknown }): Promise<unknown> | unknown;
}

export interface AdminOpsDeps {
  withdrawals: PgWithdrawalsRepo;
  support: SupportRepo;
  adminAudit: AdminAuditLike;
  revoked: Set<string>;
}

const STATUSES: WithdrawalStatus[] = ['pending', 'processing', 'success', 'failed'];

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createAdminOpsRouter(deps: AdminOpsDeps): Router {
  const router = Router();
  const auth = requireAdminJwt({ revoked: deps.revoked });

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        console.error('[admin-ops] request failed:', err);
        if (!res.headersSent) fail(res, 500, 'INTERNAL', 'internal error');
      }
    };

  const audit = (req: Request, action: string, target: string, payload?: unknown) => {
    void Promise.resolve(deps.adminAudit.record({ actor: req.admin!.username, action, target, payload })).catch(
      (err) => console.error('[admin-ops] audit write failed:', err),
    );
  };

  router.get('/withdrawals', auth, requireRole('finance', 'support'), handle(async (req, res) => {
    const status = STATUSES.includes(req.query.status as WithdrawalStatus) ? (req.query.status as WithdrawalStatus) : null;
    res.json({ items: await deps.withdrawals.list(status ? [status] : ['pending', 'processing']) });
  }));

  router.post('/withdrawals/:reference/resolve', auth, requireRole('finance'), handle(async (req, res) => {
    const reference = String(req.params.reference);
    const outcome = req.body?.outcome;
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : '';
    if (outcome !== 'success' && outcome !== 'failed') return fail(res, 400, 'INVALID_OUTCOME', "outcome must be 'success' or 'failed'");
    const w = await deps.withdrawals.get(reference);
    if (!w) return fail(res, 404, 'NOT_FOUND', 'withdrawal not found');
    const changed = outcome === 'success'
      ? await deps.withdrawals.markSucceeded(reference)
      : await deps.withdrawals.failAndRefund(reference, `resolved by ${req.admin!.username}: ${note}`);
    if (!changed) return fail(res, 409, 'ALREADY_FINAL', `withdrawal is already ${w.status}`);
    audit(req, 'withdrawal.resolve', reference, { outcome, note });
    res.json({ withdrawal: await deps.withdrawals.get(reference) });
  }));

  router.get('/support/threads', auth, requireRole('support'), handle(async (_req, res) => {
    res.json({ items: await deps.support.threads() });
  }));

  router.get('/support/threads/:playerId', auth, requireRole('support'), handle(async (req, res) => {
    const playerId = String(req.params.playerId);
    await deps.support.markRead(playerId, 'agent');
    res.json({ messages: await deps.support.messages(playerId) });
  }));

  router.post('/support/threads/:playerId/messages', auth, requireRole('support'), handle(async (req, res) => {
    const playerId = String(req.params.playerId);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 2000) return fail(res, 400, 'INVALID_MESSAGE', 'message must be 1–2000 characters');
    const message = await deps.support.post(playerId, 'agent', body, req.admin!.username);
    audit(req, 'support.reply', playerId, { messageId: message.id });
    res.status(201).json({ message });
  }));

  return router;
}
