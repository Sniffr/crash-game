/**
 * Admin HTTP router — Task 5.2.
 *
 * Mounted at /admin/v1 in index.ts. Auth is internal:
 *   - POST /auth/login   — PUBLIC (registered BEFORE router.use(requireAdminJwt))
 *   - router.use(requireAdminJwt) — JWT guard for everything below
 *   - POST /auth/logout, GET /me, admin CRUD, operator CRUD, force-credit
 *
 * See spec §1, §3, §4, §6.3.
 */

import { Router } from 'express';
import type { WalletClient, BetLog, WinRequest, OperatorStatus } from '@crash/wallet';
import { WalletError, OperatorRegistry, DuplicateOperatorIdError, OperatorNotFoundError } from '@crash/wallet';
import * as bcrypt from 'bcryptjs';
import type { WalletClientCache } from '../wallet/client-cache.js';
import type { AdminAudit, AdminRole } from '../admin/admin-store.js';
import { AdminUsers, DuplicateAdminError, AdminNotFoundError, isAdminRole } from '../admin/admin-store.js';
import {
  requireAdminJwt,
  requireRole,
  signAdminJwt,
} from './middleware/admin-auth.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  walletClientCache: WalletClientCache;
  betLog: BetLog;
  adminAudit: AdminAudit;
  adminUsers: AdminUsers;
  registry: OperatorRegistry;
  revoked: Set<string>;
  nowSeconds?: () => number;
}

// ---------------------------------------------------------------------------
// Helper: map Operator to the §4.1 public shape (no apiKey/signingKey)
// ---------------------------------------------------------------------------

function operatorPublicShape(op: {
  operatorId: string;
  name: string;
  walletBaseUrl: string;
  adapter: string;
  currencies: string[];
  minBetMinor: number;
  maxBetMinor: number;
  rtpVariant: number;
  jurisdictions: string[];
  status: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    operatorId: op.operatorId,
    name: op.name,
    walletBaseUrl: op.walletBaseUrl,
    adapter: op.adapter,
    currencies: op.currencies,
    minBetMinor: op.minBetMinor,
    maxBetMinor: op.maxBetMinor,
    rtpVariant: op.rtpVariant,
    jurisdictions: op.jurisdictions,
    status: op.status,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  // One-shot credentials cache: operatorId → { apiKey, signingKey }
  // Populated by create + regen-signing-key; consumed (and deleted) by GET /credentials.
  //
  // IMPORTANT LIMITATIONS (tracked for Phase 6/8):
  //   (a) In-process only — creating an operator on one instance and calling
  //       GET /credentials on a different instance returns 404 (single-instance
  //       only; multi-instance horizontal scaling, Phase 8 Dockerfile, breaks retrieval).
  //   (b) No TTL — entries persist until consumed; Phase 6/8 should add TTL-based
  //       eviction to prevent unbounded growth on un-retrieved credentials.
  const oneShot = new Map<string, { apiKey: string; signingKey: string }>();

  // =========================================================================
  // A. POST /auth/login — PUBLIC (before requireAdminJwt)
  // =========================================================================

  router.post('/auth/login', async (req, res): Promise<void> => {
    // Fail-closed: JWT_SECRET must be set.
    const jwtSecret = process.env['JWT_SECRET'];
    if (!jwtSecret || jwtSecret === '') {
      res.status(503).json({ error: { code: 'ADMIN_DISABLED', message: 'Admin API not configured' } });
      return;
    }

    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = body.username;
    const password = body.password;

    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'username and password (non-empty strings) required' } });
      return;
    }

    const found = deps.adminUsers.getByUsername(username);

    // Identical response for unknown-user vs bad-password — no enumeration.
    if (!found || !(await bcrypt.compare(password, found.passwordHash))) {
      deps.adminAudit.record({
        actor: username,
        action: 'auth.login',
        target: username,
        payload: { result: 'failed' },
      });
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
      return;
    }

    // Success
    deps.adminUsers.recordLogin(username);
    const { token, jti, expiresAt } = await signAdminJwt(
      { sub: username, roles: found.user.roles },
      { ttlSeconds: 28800, nowSeconds: deps.nowSeconds },
    );

    deps.adminAudit.record({
      actor: username,
      action: 'auth.login',
      target: username,
      payload: { result: 'success' },
    });

    res.status(200).json({ token, expiresAt, roles: found.user.roles });
    // jti used in the token; not logged
    void jti;
  });

  // =========================================================================
  // B. JWT guard — everything below requires a valid JWT
  // =========================================================================

  router.use(requireAdminJwt({ revoked: deps.revoked, nowSeconds: deps.nowSeconds }));

  // =========================================================================
  // C. POST /auth/logout
  // =========================================================================

  router.post('/auth/logout', async (req, res): Promise<void> => {
    // Stash the jti from the request — augmented onto Request in admin-auth.ts
    const jti = req.adminJti;
    if (jti) {
      deps.revoked.add(jti);
    }
    deps.adminAudit.record({
      actor: req.admin!.username,
      action: 'auth.logout',
      target: req.admin!.username,
    });
    res.status(204).end();
  });

  // =========================================================================
  // D. GET /me
  // =========================================================================

  router.get('/me', (req, res): void => {
    const found = deps.adminUsers.getByUsername(req.admin!.username);
    res.status(200).json({
      username: req.admin!.username,
      roles: req.admin!.roles,
      lastLoginAt: found?.user.lastLoginAt ?? null,
    });
  });

  // =========================================================================
  // E. GET /admins — list
  // =========================================================================

  router.get('/admins', requireRole('admin'), (req, res): void => {
    const items = deps.adminUsers.list({ limit: 100 });
    res.status(200).json({ items, nextCursor: null, count: items.length });
  });

  // =========================================================================
  // F. POST /admins — create
  // =========================================================================

  router.post('/admins', requireRole('admin'), async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; roles?: unknown };

    if (
      typeof body.username !== 'string' || !body.username ||
      typeof body.password !== 'string' || !body.password ||
      !Array.isArray(body.roles)
    ) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'username, password, and roles (array) required' } });
      return;
    }

    const username = body.username;
    const password = body.password;
    const rawRoles = body.roles;

    // Validate roles: non-empty array of known AdminRole values.
    if (rawRoles.length === 0 || !rawRoles.every((r: unknown) => typeof r === 'string' && isAdminRole(r))) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'roles must be a non-empty array of: admin, finance, support, viewer',
        },
      });
      return;
    }
    const roles = rawRoles as AdminRole[];

    try {
      const hash = await bcrypt.hash(password, 10);
      const user = deps.adminUsers.create(username, hash, roles);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'admin.create',
        target: username,
        payload: { roles },
      });

      res.status(201).json(user);
    } catch (err) {
      if (err instanceof DuplicateAdminError) {
        res.status(409).json({ error: { code: 'DUPLICATE_ADMIN', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // G. PATCH /admins/:username — update roles / password
  // =========================================================================

  router.patch('/admins/:username', requireRole('admin'), async (req, res): Promise<void> => {
    const { username } = req.params as { username: string };
    const body = (req.body ?? {}) as { roles?: unknown; password?: unknown };

    if (body.roles === undefined && body.password === undefined) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'roles or password required' } });
      return;
    }

    const patch: { roles?: AdminRole[]; passwordHash?: string } = {};

    if (body.roles !== undefined) {
      if (!Array.isArray(body.roles)) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'roles must be an array' } });
        return;
      }
      patch.roles = body.roles as AdminRole[];
    }

    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || !body.password) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'password must be a non-empty string' } });
        return;
      }
      patch.passwordHash = await bcrypt.hash(body.password, 10);
    }

    try {
      const user = deps.adminUsers.update(username, patch);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'admin.update',
        target: username,
        payload: { updatedFields: Object.keys(patch) },
      });

      res.status(200).json(user);
    } catch (err) {
      if (err instanceof AdminNotFoundError) {
        res.status(404).json({ error: { code: 'ADMIN_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // H. DELETE /admins/:username
  // =========================================================================

  router.delete('/admins/:username', requireRole('admin'), (req, res): void => {
    const { username } = req.params as { username: string };

    if (username === req.admin!.username) {
      res.status(409).json({ error: { code: 'CANNOT_DELETE_SELF', message: 'Cannot delete your own account' } });
      return;
    }

    try {
      deps.adminUsers.delete(username);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'admin.delete',
        target: username,
      });

      res.status(204).end();
    } catch (err) {
      if (err instanceof AdminNotFoundError) {
        res.status(404).json({ error: { code: 'ADMIN_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // I. GET /operators — list
  // =========================================================================

  router.get('/operators', (req, res): void => {
    const statusFilter = req.query['status'] as OperatorStatus | undefined;
    const q = req.query['q'] as string | undefined;

    let items = deps.registry.list(statusFilter ? { status: statusFilter } : undefined);

    if (q) {
      const ql = q.toLowerCase();
      items = items.filter((op) => op.name.toLowerCase().includes(ql));
    }

    const publicItems = items.map(operatorPublicShape);
    res.status(200).json({ items: publicItems, nextCursor: null, count: publicItems.length });
  });

  // =========================================================================
  // J. POST /operators — create
  // =========================================================================

  router.post('/operators', requireRole('admin'), async (req, res): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined ?? {};

    try {
      const { operator, credentials } = deps.registry.create({
        operatorId: body['operatorId'] as string,
        name: body['name'] as string,
        walletBaseUrl: body['walletBaseUrl'] as string,
        adapter: body['adapter'] as 'native' | 'softswiss' | undefined,
        currencies: body['currencies'] as string[],
        minBetMinor: body['minBetMinor'] as number | undefined,
        maxBetMinor: body['maxBetMinor'] as number | undefined,
        rtpVariant: body['rtpVariant'] as number | undefined,
        jurisdictions: body['jurisdictions'] as string[] | undefined,
        status: body['status'] as OperatorStatus | undefined,
      });

      // Stash credentials for one-shot retrieval via GET /credentials
      oneShot.set(operator.operatorId, {
        apiKey: credentials.apiKey,
        signingKey: credentials.signingKeyBase64,
      });

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'operator.create',
        target: `operator:${operator.operatorId}`,
        payload: { operatorId: operator.operatorId, name: operator.name },
      });

      res.status(201).json({
        operator: operatorPublicShape(operator),
        credentials: {
          apiKey: credentials.apiKey,
          signingKey: credentials.signingKeyBase64,
        },
      });
    } catch (err) {
      if (err instanceof DuplicateOperatorIdError) {
        res.status(409).json({ error: { code: 'DUPLICATE_OPERATOR', message: err.message } });
        return;
      }
      // Validation errors (missing required fields, constraint violations)
      if (err instanceof Error) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // K. GET /operators/:id — detail
  // =========================================================================

  router.get('/operators/:id', (req, res): void => {
    const { id } = req.params as { id: string };
    const op = deps.registry.getById(id);

    if (!op) {
      res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: `No operator with id '${id}'` } });
      return;
    }

    const limits: Record<string, { minBetMinor: number; maxBetMinor: number }> = {};
    for (const cur of op.currencies) {
      limits[cur] = { minBetMinor: op.minBetMinor, maxBetMinor: op.maxBetMinor };
    }

    res.status(200).json({
      ...operatorPublicShape(op),
      games: [{ gameId: 'galaxy-crash', enabled: true, rtpVariant: op.rtpVariant }],
      limits,
    });
  });

  // =========================================================================
  // L. PATCH /operators/:id — update fields
  // =========================================================================

  router.patch('/operators/:id', requireRole('admin'), (req, res): void => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Reject attempts to mutate immutable / status fields
    if ('operatorId' in body || 'status' in body) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'use /pause or /resume for status changes; operatorId is immutable',
        },
      });
      return;
    }

    try {
      const op = deps.registry.update(id, {
        name: body['name'] as string | undefined,
        walletBaseUrl: body['walletBaseUrl'] as string | undefined,
        adapter: body['adapter'] as 'native' | 'softswiss' | undefined,
        currencies: body['currencies'] as string[] | undefined,
        minBetMinor: body['minBetMinor'] as number | undefined,
        maxBetMinor: body['maxBetMinor'] as number | undefined,
        rtpVariant: body['rtpVariant'] as number | undefined,
        jurisdictions: body['jurisdictions'] as string[] | undefined,
      });

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'operator.update',
        target: `operator:${id}`,
        payload: { updatedFields: Object.keys(body) },
      });

      res.status(200).json(operatorPublicShape(op));
    } catch (err) {
      if (err instanceof OperatorNotFoundError) {
        res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // M. POST /operators/:id/regen-signing-key
  // =========================================================================

  router.post('/operators/:id/regen-signing-key', requireRole('admin'), (req, res): void => {
    const { id } = req.params as { id: string };

    try {
      const creds = deps.registry.regenSigningKey(id);

      // Stash for one-shot retrieval
      oneShot.set(id, { apiKey: creds.apiKey, signingKey: creds.signingKeyBase64 });

      // Invalidate the cached WalletClient so it picks up the new key
      deps.walletClientCache.invalidate(id);

      const rotatedAt = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'operator.regen_signing_key',
        target: `operator:${id}`,
        payload: { rotatedAt },
      });

      res.status(200).json({ signingKey: creds.signingKeyBase64, rotatedAt });
    } catch (err) {
      if (err instanceof OperatorNotFoundError) {
        res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // N. POST /operators/:id/pause
  // =========================================================================

  router.post('/operators/:id/pause', requireRole('admin'), (req, res): void => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: unknown };

    try {
      deps.registry.update(id, { status: 'paused' });
      deps.walletClientCache.invalidate(id);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'operator.pause',
        target: `operator:${id}`,
        payload: body.reason ? { reason: body.reason } : undefined,
      });

      res.status(200).json({ ok: true, operatorId: id, status: 'paused' });
    } catch (err) {
      if (err instanceof OperatorNotFoundError) {
        res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // O. POST /operators/:id/resume
  // =========================================================================

  router.post('/operators/:id/resume', requireRole('admin'), (req, res): void => {
    const { id } = req.params as { id: string };

    try {
      deps.registry.update(id, { status: 'active' });
      deps.walletClientCache.invalidate(id);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'operator.resume',
        target: `operator:${id}`,
      });

      res.status(200).json({ ok: true, operatorId: id, status: 'active' });
    } catch (err) {
      if (err instanceof OperatorNotFoundError) {
        res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // P. GET /operators/:id/credentials — one-shot
  // =========================================================================

  router.get('/operators/:id/credentials', requireRole('admin'), (req, res): void => {
    const { id } = req.params as { id: string };

    // Check operator exists
    const op = deps.registry.getById(id);
    if (!op) {
      res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: `No operator with id '${id}'` } });
      return;
    }

    deps.adminAudit.record({
      actor: req.admin!.username,
      action: 'operator.credentials_read',
      target: `operator:${id}`,
    });

    const creds = oneShot.get(id);
    if (!creds) {
      // Spec §4.8: credentials already consumed
      res.status(404).json({
        error: {
          code: 'CREDENTIALS_NOT_VISIBLE',
          message: 'Use regen-signing-key to issue new credentials.',
        },
      });
      return;
    }

    // Consume — one-shot
    oneShot.delete(id);
    res.status(200).json({ apiKey: creds.apiKey, signingKey: creds.signingKey });
  });

  // =========================================================================
  // Q. PATCH /operators/:id/games/:gameId
  // =========================================================================

  router.patch('/operators/:id/games/:gameId', requireRole('admin'), (req, res): void => {
    const { id, gameId } = req.params as { id: string; gameId: string };
    const body = (req.body ?? {}) as { enabled?: unknown; rtpVariant?: unknown };

    const op = deps.registry.getById(id);
    if (!op) {
      res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: `No operator with id '${id}'` } });
      return;
    }

    // NOTE: Per-operator game enabled/disabled requires a dedicated DB table which
    // does not exist in Phase 5.2. For `rtpVariant`, we store it on the operator row.
    // For `enabled`, we echo the requested config only (phase-future limitation).
    // This is documented as a Phase-(future) limitation in the report.

    let updatedRtpVariant = op.rtpVariant;

    if (body.rtpVariant !== undefined) {
      try {
        deps.registry.update(id, { rtpVariant: body.rtpVariant as number });
        updatedRtpVariant = body.rtpVariant as number;
      } catch (err) {
        if (err instanceof OperatorNotFoundError) {
          res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: err.message } });
          return;
        }
        throw err;
      }
    }

    deps.adminAudit.record({
      actor: req.admin!.username,
      action: 'operator.game_config',
      target: `operator:${id}`,
      payload: { gameId, ...body },
    });

    res.status(200).json({
      gameId,
      enabled: body.enabled !== undefined ? body.enabled : true,
      rtpVariant: updatedRtpVariant,
    });
  });

  // =========================================================================
  // R. POST /bet-log/:betId/force-credit — moved here, behind JWT + requireRole('admin')
  // =========================================================================

  router.post('/bet-log/:betId/force-credit', requireRole('admin'), async (req, res): Promise<void> => {
    const actor: string = req.admin!.username;
    const betId = req.params['betId']!;

    try {
      // Step 1: Validate reason body field.
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = body.reason;

      if (typeof reason !== 'string' || !reason.trim()) {
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
          error: { code: 'BET_NOT_FOUND', message: 'No bet-log row for the given betId' },
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
          error: { code: 'OPERATOR_UNAVAILABLE', message: 'Operator wallet client unavailable (operator paused or deregistered)' },
        });
        return;
      }

      // Step 6: Build the WinRequest — use the ORIGINAL winTxnId.
      const winReq: WinRequest = {
        playerId: row.playerId,
        sessionId: row.sessionId,
        roundId: row.roundId,
        betId: row.betId,
        betTxnId: row.betTxnId,
        txnId: row.winTxnId,          // ORIGINAL winTxnId
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
        throw err;
      }

      // Step 7 (success): transition WIN_FAILED → SETTLED.
      try {
        deps.betLog.transition(betId, 'win_force_credited', {
          winOpTxnId: winResp.operatorTxnId,
        });
      } catch (transitionErr) {
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
          error: { code: 'TRANSITION_FAILED', message: 'Operator credited the player but the bet-log row could not transition to SETTLED — data-integrity event; see audit row' },
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
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error during force-credit' } });
      }
    }
  });

  return router;
}
