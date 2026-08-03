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
import type { WalletClient, BetLog, WinRequest, OperatorStatus, BetState, FinancialFilter, Reconciler, ReconStatus } from '@crash/wallet';
import { WalletError, PgOperatorRegistry, DuplicateOperatorIdError, OperatorNotFoundError, encodeCursor, decodeCursor, parseLimit, ALL_BET_STATES, PgGamesRepo, DuplicateGameIdError, GameNotFoundError, InvalidGameError } from '@crash/wallet';
import * as bcrypt from 'bcryptjs';
import type { WalletClientCache } from '../wallet/client-cache.js';
import type { AdminAudit, AdminRole } from '../admin/admin-store.js';
import { AdminUsers, DuplicateAdminError, AdminNotFoundError, isAdminRole } from '../admin/admin-store.js';
import {
  requireAdminJwt,
  requireRole,
  signAdminJwt,
} from './middleware/admin-auth.js';
import { observeWalletCall, getMetricsText, walletCallsTotal, walletErrorsTotal, walletLatencyMs } from '../observability/metrics.js';

// Valid BetState values for ?state= filter validation — derived from the
// single source of truth in state-machine.ts (prevents drift when new states are added).
const BET_STATES = new Set<string>(ALL_BET_STATES);

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  walletClientCache: WalletClientCache;
  betLog: BetLog;
  adminAudit: AdminAudit;
  adminUsers: AdminUsers;
  registry: PgOperatorRegistry;
  games: PgGamesRepo;
  revoked: Set<string>;
  reconciler: Reconciler;
  nowSeconds?: () => number;
}

// Valid reconciliation run status values for ?status= filter validation (spec §9.1).
const RECON_STATUSES = new Set<string>(['OK', 'MISMATCHES', 'FAILED']);

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
  shareBps: number;
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
    // shareBps is NOT secret (unlike apiKey/signingKey); it is the contractual
    // revenue-share rate and is safe to return in the public operator shape.
    shareBps: op.shareBps,
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
      const { operator, credentials } = await deps.registry.create({
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

  router.patch('/operators/:id', requireRole('admin'), async (req, res): Promise<void> => {
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

    // Validate shareBps before calling registry.update (gives a clean 400)
    if (body['shareBps'] !== undefined) {
      const s = body['shareBps'];
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 10000) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'shareBps must be an integer between 0 and 10000' } });
        return;
      }
    }

    try {
      const op = await deps.registry.update(id, {
        name: body['name'] as string | undefined,
        walletBaseUrl: body['walletBaseUrl'] as string | undefined,
        adapter: body['adapter'] as 'native' | 'softswiss' | undefined,
        currencies: body['currencies'] as string[] | undefined,
        minBetMinor: body['minBetMinor'] as number | undefined,
        maxBetMinor: body['maxBetMinor'] as number | undefined,
        rtpVariant: body['rtpVariant'] as number | undefined,
        jurisdictions: body['jurisdictions'] as string[] | undefined,
        shareBps: body['shareBps'] as number | undefined,
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
      if (err instanceof Error && err.message.includes('shareBps')) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // M. POST /operators/:id/regen-signing-key
  // =========================================================================

  router.post('/operators/:id/regen-signing-key', requireRole('admin'), async (req, res): Promise<void> => {
    const { id } = req.params as { id: string };

    try {
      const creds = await deps.registry.regenSigningKey(id);

      // Stash for one-shot retrieval
      oneShot.set(id, { apiKey: creds.apiKey, signingKey: creds.signingKeyBase64 });

      // Invalidate the cached WalletClient so it picks up the new key
      deps.walletClientCache.invalidate(id);

      const rotatedAt = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);

      deps.adminAudit.record({
        actor: req.admin!.username,
        action: 'operator.regen-signing-key',
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

  router.post('/operators/:id/pause', requireRole('admin'), async (req, res): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: unknown };

    try {
      await deps.registry.update(id, { status: 'paused' });
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

  router.post('/operators/:id/resume', requireRole('admin'), async (req, res): Promise<void> => {
    const { id } = req.params as { id: string };

    try {
      await deps.registry.update(id, { status: 'active' });
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
  // Games catalogue (multi-game — 2026-07-24 design)
  // RTP crosses this boundary as a PERCENTAGE (97.0), matching rtpVariant
  // convention. It is stored/computed as a fraction (0.97). See design §2.
  // =========================================================================

  const gamePublicShape = (g: import('@crash/wallet').Game) => ({
    gameId: g.gameId,
    name: g.name,
    gameType: g.gameType,
    rtp: g.rtp * 100,
    theme: g.theme,
    status: g.status,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  });

  // GET /games — list (admin sees archived too via ?includeArchived=1)
  router.get('/games', requireRole('admin'), async (req, res): Promise<void> => {
    const includeArchived = req.query['includeArchived'] === '1' || req.query['includeArchived'] === 'true';
    res.json({ items: (await deps.games.list({ includeArchived })).map(gamePublicShape) });
  });

  // GET /games/:gameId
  router.get('/games/:gameId', requireRole('admin'), async (req, res): Promise<void> => {
    const g = await deps.games.getById(req.params['gameId']!);
    if (!g) { res.status(404).json({ error: { code: 'GAME_NOT_FOUND', message: `No game with id '${req.params['gameId']}'` } }); return; }
    res.json(gamePublicShape(g));
  });

  // POST /games — create
  router.post('/games', requireRole('admin'), async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as { gameId?: unknown; name?: unknown; gameType?: unknown; rtp?: unknown; theme?: unknown; status?: unknown };
    if (typeof body.gameId !== 'string' || !body.gameId.trim() || typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'gameId and name (non-empty strings) required' } });
      return;
    }
    if (typeof body.rtp !== 'number' || !Number.isFinite(body.rtp) || body.rtp <= 0 || body.rtp > 100) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'rtp must be a percentage in (0, 100]' } });
      return;
    }
    try {
      const g = await deps.games.create({
        gameId: body.gameId,
        name: body.name,
        gameType: body.gameType as import('@crash/wallet').GameType,
        rtp: body.rtp / 100,
        theme: body.theme ?? {},
        status: body.status as import('@crash/wallet').GameStatus | undefined,
      });
      deps.adminAudit.record({ actor: req.admin!.username, action: 'game.create', target: `game:${g.gameId}`, payload: { name: g.name, gameType: g.gameType } });
      res.status(201).json(gamePublicShape(g));
    } catch (err) {
      if (err instanceof DuplicateGameIdError) { res.status(409).json({ error: { code: 'DUPLICATE_GAME_ID', message: err.message } }); return; }
      if (err instanceof InvalidGameError) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: err.message } }); return; }
      throw err;
    }
  });

  // PATCH /games/:gameId — update
  router.patch('/games/:gameId', requireRole('admin'), async (req, res): Promise<void> => {
    const gameId = req.params['gameId']!;
    const body = (req.body ?? {}) as { name?: unknown; gameType?: unknown; rtp?: unknown; theme?: unknown; status?: unknown };
    const patch: import('@crash/wallet').GameUpdate = {};
    if (body.name !== undefined) patch.name = body.name as string;
    if (body.gameType !== undefined) patch.gameType = body.gameType as import('@crash/wallet').GameType;
    if (body.theme !== undefined) patch.theme = body.theme;
    if (body.status !== undefined) patch.status = body.status as import('@crash/wallet').GameStatus;
    if (body.rtp !== undefined) {
      if (typeof body.rtp !== 'number' || !Number.isFinite(body.rtp) || body.rtp <= 0 || body.rtp > 100) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'rtp must be a percentage in (0, 100]' } });
        return;
      }
      patch.rtp = body.rtp / 100;
    }
    try {
      const g = await deps.games.update(gameId, patch);
      deps.adminAudit.record({ actor: req.admin!.username, action: 'game.update', target: `game:${gameId}`, payload: body });
      res.json(gamePublicShape(g));
    } catch (err) {
      if (err instanceof GameNotFoundError) { res.status(404).json({ error: { code: 'GAME_NOT_FOUND', message: err.message } }); return; }
      if (err instanceof InvalidGameError) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: err.message } }); return; }
      throw err;
    }
  });

  // =========================================================================
  // Q. PATCH /operators/:id/games/:gameId — enable/disable + per-operator RTP
  // Persists to operator_games (design §2). rtpVariant is a PERCENTAGE.
  // =========================================================================

  router.patch('/operators/:id/games/:gameId', requireRole('admin'), async (req, res): Promise<void> => {
    const { id, gameId } = req.params as { id: string; gameId: string };
    const body = (req.body ?? {}) as { enabled?: unknown; rtpVariant?: unknown };

    if (!deps.registry.getById(id)) {
      res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: `No operator with id '${id}'` } });
      return;
    }
    if (!(await deps.games.getById(gameId))) {
      res.status(404).json({ error: { code: 'GAME_NOT_FOUND', message: `No game with id '${gameId}'` } });
      return;
    }

    const patch: { enabled?: boolean; rtpOverride?: number | null } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'enabled must be a boolean' } });
        return;
      }
      patch.enabled = body.enabled;
    }
    if (body.rtpVariant !== undefined) {
      if (body.rtpVariant === null) {
        patch.rtpOverride = null; // clear override → inherit game rtp
      } else if (typeof body.rtpVariant !== 'number' || !Number.isFinite(body.rtpVariant) || body.rtpVariant <= 0 || body.rtpVariant > 100) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'rtpVariant must be a percentage in (0, 100] or null' } });
        return;
      } else {
        patch.rtpOverride = body.rtpVariant / 100;
      }
    }

    try {
      const link = await deps.games.setOperatorGame(id, gameId, patch);
      deps.adminAudit.record({ actor: req.admin!.username, action: 'operator.game_config', target: `operator:${id}`, payload: { gameId, ...body } });
      res.status(200).json({
        gameId,
        enabled: link.enabled,
        rtpVariant: link.rtpOverride == null ? null : link.rtpOverride * 100,
      });
    } catch (err) {
      if (err instanceof InvalidGameError) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: err.message } }); return; }
      throw err;
    }
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

      // Step 7: Call the operator /win endpoint (wrapped for metrics — transparent: rethrows unchanged).
      let winResp: Awaited<ReturnType<WalletClient['win']>>;
      try {
        winResp = await observeWalletCall(
          { operator: row.operatorId, endpoint: 'win' },
          () => client.win(winReq),
        );
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

  // =========================================================================
  // Shared pagination helper — parse cursor + limit from query params,
  // returning 400 on bad cursor. Usage: const page = readPage(req, res); if (!page) return;
  // =========================================================================

  function readPage(
    req: import('express').Request,
    res: import('express').Response,
  ): { limit: number; cursor: import('@crash/wallet').Cursor | undefined } | null {
    const limit = parseLimit(req.query['limit'], 50, 200);
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined && typeof rawCursor === 'string' && rawCursor !== '') {
      const cursor = decodeCursor(rawCursor);
      if (!cursor) {
        res.status(400).json({ error: { code: 'INVALID_CURSOR', message: 'Cursor is malformed or expired — restart pagination' } });
        return null;
      }
      return { limit, cursor };
    }
    return { limit, cursor: undefined };
  }

  // =========================================================================
  // S. GET /rounds — derived from bet_log GROUP BY round_id
  // =========================================================================

  router.get('/rounds', (req, res): void => {
    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

    // Parse numeric filters
    const from = q['from'] !== undefined ? Number(q['from']) : undefined;
    const to = q['to'] !== undefined ? Number(q['to']) : undefined;
    const minMultiplier = q['minMultiplier'] !== undefined ? Number(q['minMultiplier']) : undefined;
    const maxMultiplier = q['maxMultiplier'] !== undefined ? Number(q['maxMultiplier']) : undefined;

    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to)) ||
      (minMultiplier !== undefined && !Number.isFinite(minMultiplier)) ||
      (maxMultiplier !== undefined && !Number.isFinite(maxMultiplier))
    ) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from, to, minMultiplier, maxMultiplier must be numeric' } });
      return;
    }

    const { rows, nextCursor } = deps.betLog.listRoundsFiltered(
      { operatorId: q['operatorId'], from, to, minMultiplier, maxMultiplier },
      page,
    );

    const items = rows.map((r) => ({
      roundId: r.roundId,
      // operatorId: first in the list (multi-operator rounds are unusual but possible)
      operatorId: r.operatorIds[0] ?? null,
      operatorIds: r.operatorIds,
      // roundNumber: not persisted — no rounds table (Phase-future gap)
      // not persisted (Phase-future): roundNumber requires a dedicated rounds table
      roundNumber: null,
      // crashPoint: not persisted — RNG seeds live in the in-memory game loop (Phase-future gap)
      // not persisted (Phase-future): crashPoint/serverSeed come from the live RNG loop, not bet_log
      crashPoint: null,
      betCount: r.betCount,
      totalStakeMinor: r.totalAmountMinorByCurrency,
      // totalPayoutMinor: not persisted — win_amount_minor per bet exists but payout aggregation
      // is not pre-computed; omitted rather than fabricated (Phase-future gap)
      totalPayoutMinor: null,
      startedAt: r.firstAt,
      crashedAt: r.lastAt,
      distinctPlayers: r.distinctPlayers,
      maxMultiplier: r.maxMultiplier,
      // serverSeedHash: not persisted (Phase-future)
      serverSeedHash: null,
    }));

    res.status(200).json({ items, nextCursor, count: items.length });
  });

  // =========================================================================
  // T. GET /rounds/:roundId — full detail
  // =========================================================================

  router.get('/rounds/:roundId', (req, res): void => {
    const { roundId } = req.params as { roundId: string };

    const bets = deps.betLog.listByRound(roundId);
    if (bets.length === 0) {
      res.status(404).json({ error: { code: 'ROUND_NOT_FOUND', message: `No bets found for round '${roundId}'` } });
      return;
    }

    const operatorIds = [...new Set(bets.map((b) => b.operatorId))];
    const playerIds = new Set(bets.map((b) => b.playerId));
    const createdAts = bets.map((b) => b.createdAt);
    const firstAt = Math.min(...createdAts);
    const lastAt = Math.max(...createdAts);
    const multipliers = bets.map((b) => b.multiplier).filter((m): m is number => m !== null);
    const maxMultiplier = multipliers.length > 0 ? Math.max(...multipliers) : null;

    const totalAmountMinorByCurrency: Record<string, number> = {};
    for (const bet of bets) {
      totalAmountMinorByCurrency[bet.currency] = (totalAmountMinorByCurrency[bet.currency] ?? 0) + bet.amountMinor;
    }

    const round = {
      roundId,
      operatorId: operatorIds[0] ?? null,
      operatorIds,
      roundNumber: null,              // not persisted (Phase-future): no rounds table
      crashPoint: null,               // not persisted (Phase-future): RNG crash point not stored in bet_log
      betCount: bets.length,
      totalStakeMinor: totalAmountMinorByCurrency,
      totalPayoutMinor: null,         // not persisted (Phase-future): payout not aggregated
      startedAt: firstAt,
      crashedAt: lastAt,
      distinctPlayers: playerIds.size,
      maxMultiplier,
      serverSeedHash: null,           // not persisted (Phase-future): RNG seeds live in game loop memory only
      serverSeed: null,               // not persisted (Phase-future): RNG seeds not stored in bet_log
      clientSeedRef: null,            // not persisted (Phase-future)
      rngFormulaVersion: null,        // not persisted (Phase-future)
    };

    const betItems = bets.map(toBetItem);

    res.status(200).json({ round, bets: betItems });
  });

  // =========================================================================
  // U. GET /bets — filtered + paginated
  // =========================================================================

  router.get('/bets', (req, res): void => {
    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

    // Validate ?state=
    const stateRaw = q['state'];
    if (stateRaw !== undefined && !BET_STATES.has(stateRaw)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `Unknown state '${stateRaw}'. Valid states: ${[...BET_STATES].join(', ')}` } });
      return;
    }

    const from = q['from'] !== undefined ? Number(q['from']) : undefined;
    const to = q['to'] !== undefined ? Number(q['to']) : undefined;
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to))
    ) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from and to must be numeric unix seconds' } });
      return;
    }

    const { rows, nextCursor } = deps.betLog.listBetsFiltered(
      {
        operatorId: q['operatorId'],
        playerId: q['playerId'],
        state: stateRaw as BetState | undefined,
        betId: q['betId'],
        betTxnId: q['txnId'],  // spec §6.1 filter is txnId → maps to betTxnId
        from,
        to,
      },
      page,
    );

    res.status(200).json({
      items: rows.map(toBetItem),
      nextCursor,
      count: rows.length,
    });
  });

  // =========================================================================
  // V. GET /bets/:betId — single bet + derived timeline + walletCalls
  // =========================================================================

  router.get('/bets/:betId', (req, res): void => {
    const { betId } = req.params as { betId: string };

    const bet = deps.betLog.getById(betId);
    if (!bet) {
      res.status(404).json({ error: { code: 'BET_NOT_FOUND', message: `No bet with id '${betId}'` } });
      return;
    }

    // §6.2 timeline: per-transition history is NOT persisted (Phase-future gap).
    // We derive a minimal 2-entry timeline: creation (PENDING) + current state.
    // Full per-transition timestamps would require a dedicated bet_state_transitions table.
    // See Phase-future: add bet_state_transitions table for complete audit trail.
    const timeline: Array<{
      state: string;
      at: number;
      actor: string;
      operatorTxnId?: string | null;
    }> = [
      { state: 'PENDING', at: bet.createdAt, actor: 'system' },
    ];
    // Add a second entry if the state has changed (i.e., updatedAt > createdAt or state !== PENDING)
    if (bet.state !== 'PENDING' || bet.updatedAt !== bet.createdAt) {
      const entry: { state: string; at: number; actor: string; operatorTxnId?: string | null } = {
        state: bet.state,
        at: bet.updatedAt,
        actor: 'system',
      };
      // Include the operatorTxnId for ARMED (bet_op_txn_id) or SETTLED (win_op_txn_id)
      if (bet.state === 'ARMED' || bet.state === 'SETTLED') {
        entry.operatorTxnId = bet.state === 'ARMED' ? bet.betOpTxnId : bet.winOpTxnId;
      }
      if (entry.state !== 'PENDING') {
        timeline.push(entry);
      }
    }

    // walletCalls: derive from txn_idempotency for the txn ids present on this bet
    const walletCalls: Array<{
      kind: string;
      txnId: string;
      request: unknown;
      response: unknown;
      attempts: null;
      totalMs: null;
    }> = [];

    const txnIds: Array<{ kind: string; txnId: string; operatorId: string }> = [];
    if (bet.betTxnId) txnIds.push({ kind: 'bet', txnId: bet.betTxnId, operatorId: bet.operatorId });
    if (bet.winTxnId) txnIds.push({ kind: 'win', txnId: bet.winTxnId, operatorId: bet.operatorId });
    if (bet.rollbackTxnId) txnIds.push({ kind: 'rollback', txnId: bet.rollbackTxnId, operatorId: bet.operatorId });

    for (const { kind, txnId, operatorId } of txnIds) {
      const entry = deps.betLog.getIdempotency(operatorId, txnId);
      if (entry) {
        let req: unknown = null;
        let resp: unknown = null;
        try { resp = JSON.parse(entry.responseJson); } catch { resp = entry.responseJson; }
        // request body is hashed, not stored — not persisted (Phase-future gap)
        // not persisted (Phase-future): request body is stored as a hash only; full request not available
        req = null;
        walletCalls.push({
          kind,
          txnId,
          request: req,
          response: resp,
          attempts: null,     // not persisted (Phase-future): retry count not stored in txn_idempotency
          totalMs: null,      // not persisted (Phase-future): latency not stored in txn_idempotency
        });
      }
    }

    res.status(200).json({ bet: toBetItem(bet), timeline, walletCalls });
  });

  // =========================================================================
  // W. GET /transactions — finance|admin only
  // =========================================================================

  router.get('/transactions', requireRole('finance', 'admin'), (req, res): void => {
    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

    const kindRaw = q['kind'];
    if (kindRaw !== undefined && !['bet', 'win', 'rollback'].includes(kindRaw)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: "kind must be 'bet', 'win', or 'rollback'" } });
      return;
    }

    const from = q['from'] !== undefined ? Number(q['from']) : undefined;
    const to = q['to'] !== undefined ? Number(q['to']) : undefined;
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to))
    ) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from and to must be numeric unix seconds' } });
      return;
    }

    const { rows, nextCursor } = deps.betLog.listIdempotencyFiltered(
      {
        operatorId: q['operatorId'],
        playerId: q['playerId'],
        kind: kindRaw as 'bet' | 'win' | 'rollback' | undefined,
        from,
        to,
      },
      page,
    );

    const items = rows.map((r) => {
      // Derive status from response_json shape
      // Stored entries are confirmed — either OK or FAILED (NOOP is not distinguishable from stored rows)
      let status: 'OK' | 'FAILED' | 'NOOP' = 'OK';
      let errorCode: string | null = null;
      try {
        const resp = JSON.parse(r.responseJson) as Record<string, unknown>;
        if (resp['ok'] === false) {
          status = 'FAILED';
          const errObj = resp['error'] as Record<string, unknown> | undefined;
          errorCode = (errObj?.['code'] as string) ?? null;
        }
      } catch {
        // leave as OK
      }

      return {
        txnId: r.txnId,
        operatorId: r.operatorId,
        operatorTxnId: r.operatorTxnId,
        kind: r.kind,
        playerId: r.playerId,
        betId: r.betId,
        amountMinor: r.kind === 'win' ? r.winAmountMinor : r.amountMinor,
        currency: r.currency,
        status,
        errorCode,
        attempts: null,     // not persisted (Phase-future): retry count not stored
        totalMs: null,      // not persisted (Phase-future): latency not stored
        createdAt: r.createdAt,
      };
    });

    res.status(200).json({ items, nextCursor, count: items.length });
  });

  // =========================================================================
  // X. GET /audit — admin only
  // =========================================================================

  router.get('/audit', requireRole('admin'), (req, res): void => {
    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

    const from = q['from'] !== undefined ? Number(q['from']) : undefined;
    const to = q['to'] !== undefined ? Number(q['to']) : undefined;
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to))
    ) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from and to must be numeric unix seconds' } });
      return;
    }

    const { rows, nextCursor } = deps.adminAudit.listFiltered(
      { actor: q['actor'], action: q['action'], target: q['target'], from, to },
      page,
    );

    const items = rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      payload: r.payload ?? null,
      at: r.at,
    }));

    res.status(200).json({ items, nextCursor, count: items.length });
  });

  // =========================================================================
  // Y. GET /financial/ggr — finance|admin
  //    Returns a GGR/NGR report for the given window and groupBy granularity.
  //    Spec §8.1. NOT audited (read-only).
  //
  //    Window cap: 1 year (365 * 86400 seconds). Callers must narrow the window
  //    or increase groupBy granularity if they need finer breakdown.
  //
  //    Stake/win definitions (authoritative):
  //      STAKE = SUM(amount_minor) for SETTLED, LOST, WIN_FAILED bets.
  //        WIN_FAILED: debit happened (stake real), credit unconfirmed — stake
  //        counted, win NOT counted. Force-credit transitions WIN_FAILED → SETTLED,
  //        after which subsequent reports will include the win.
  //      WIN   = SUM(win_amount_minor) for SETTLED bets only.
  //      GGR   = STAKE − WIN
  //      NGR   = GGR (bonuses = 0 in v1; field reserved)
  //    VOIDED bets are excluded (stake was refunded in full).
  // =========================================================================

  router.get('/financial/ggr', requireRole('finance', 'admin'), (req, res): void => {
    const q = req.query as Record<string, string | undefined>;

    // --- Parse `from` (required, integer unix seconds)
    if (q['from'] === undefined || q['from'] === '') {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from (unix seconds integer) required' } });
      return;
    }
    const from = Number(q['from']);
    if (!Number.isInteger(from) || !Number.isFinite(from)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from must be an integer unix seconds timestamp' } });
      return;
    }

    // --- Parse `to` (required, integer unix seconds, must be > from)
    if (q['to'] === undefined || q['to'] === '') {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'to (unix seconds integer) required' } });
      return;
    }
    const to = Number(q['to']);
    if (!Number.isInteger(to) || !Number.isFinite(to)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'to must be an integer unix seconds timestamp' } });
      return;
    }
    if (to <= from) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'to must be greater than from' } });
      return;
    }

    // --- 1-year window cap (365 * 86400 = 31 536 000 seconds)
    const MAX_WINDOW_SECONDS = 365 * 86400;
    if (to - from > MAX_WINDOW_SECONDS) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Query window exceeds the 1-year maximum (365 days). Narrow the from/to range.' } });
      return;
    }

    // --- Parse `groupBy` (required, comma-separated subset of operator,currency,day)
    if (q['groupBy'] === undefined || q['groupBy'] === '') {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: "groupBy (required) must be a comma-separated subset of 'operator,currency,day'" } });
      return;
    }
    const groupByRaw = q['groupBy'].split(',').map((s) => s.trim()).filter(Boolean);
    const validGroupBy = new Set(['operator', 'currency', 'day']);
    const badValues = groupByRaw.filter((v) => !validGroupBy.has(v));
    if (badValues.length > 0 || groupByRaw.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `Invalid groupBy values: ${badValues.join(', ')}. Valid values: operator, currency, day` } });
      return;
    }
    const groupBy = groupByRaw as FinancialFilter['groupBy'];

    // --- Optional filters
    const operatorId = q['operatorId'] || undefined;
    const currency = q['currency'] || undefined;

    try {
      const rows = deps.betLog.financialReport({ operatorId, currency, from, to, groupBy });
      res.status(200).json({ from, to, groupBy: [...groupBy], rows });
    } catch (err) {
      if (err instanceof Error && err.message.includes('groupBy')) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: err.message } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // Z. GET /financial/settlement?period=YYYY-MM — finance|admin
  //    Monthly settlement summary per operator per currency.
  //    Spec §8.2. NOT audited (read-only).
  //
  //    Uses financialReport with groupBy=['operator','currency'] (no day granularity
  //    for settlement — it's a monthly rollup). ourShareMinor is computed as
  //    floor(ggrMinor * shareBps / 10000) using the operator's shareBps from the
  //    registry. Currencies are NEVER mixed — totals are per-currency only.
  // =========================================================================

  router.get('/financial/settlement', requireRole('finance', 'admin'), (req, res): void => {
    const q = req.query as Record<string, string | undefined>;

    // --- Parse period (required, format YYYY-MM)
    const period = q['period'];
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: "period (required) must be in YYYY-MM format (e.g. '2026-04')" } });
      return;
    }
    const [yearStr, monthStr] = period.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (month < 1 || month > 12) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'period month must be 01–12' } });
      return;
    }

    // Compute inclusive/exclusive UTC window for the calendar month
    const from = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
    const to = Math.floor(Date.UTC(year, month, 1) / 1000); // first second of NEXT month (exclusive)

    const rawRows = deps.betLog.financialReport({ from, to, groupBy: ['operator', 'currency'] });

    // Group rows by operatorId, then build nested currencies array per spec §8.2
    const byOperator = new Map<string, Array<{
      currency: string;
      stakeMinor: number;
      winMinor: number;
      ggrMinor: number;
      shareBps: number;
      ourShareMinor: number;
    }>>();

    for (const row of rawRows) {
      // groupBy=['operator','currency'] guarantees both dimensions are present (non-null).
      // The non-null assertions below reflect that contract — FinancialRow.operatorId/currency
      // are string | null in general, but never null when their axis is in groupBy.
      const operatorIdNonNull = row.operatorId!;
      const currencyNonNull = row.currency!;

      const op = deps.registry.getById(operatorIdNonNull);
      // shareBps: use registry value; fallback 1500 if operator is somehow not found
      // (shouldn't happen since operatorId in bet_log references an operator, but tolerate it)
      const shareBps = op?.shareBps ?? 1500;
      // ourShareMinor uses floor (integer division): basis points → minor units
      // floor is honest — never over-report the studio's share.
      const ourShareMinor = Math.floor(row.ggrMinor * shareBps / 10000);

      const existing = byOperator.get(operatorIdNonNull);
      const currencyEntry = {
        currency: currencyNonNull,
        stakeMinor: row.stakeMinor,
        winMinor: row.winMinor,
        ggrMinor: row.ggrMinor,
        shareBps,
        ourShareMinor,
      };

      if (existing) {
        existing.push(currencyEntry);
      } else {
        byOperator.set(operatorIdNonNull, [currencyEntry]);
      }
    }

    const operators = Array.from(byOperator.entries()).map(([operatorId, currencies]) => ({
      operatorId,
      currencies,
    }));

    res.status(200).json({ period, operators });
  });

  // =========================================================================
  // AA. POST /financial/settlement/:period/invoice — finance|admin
  //     Generate a machine-readable invoice JSON for one operator+period.
  //     Spec §8.3. IS audited (financial export — chain of custody).
  //
  //     Invoices are NOT persisted (Phase-future — accounting system integration).
  //     The invoice JSON is returned directly to the caller for download/export.
  //
  //     totals: per-currency Record<currency, { ggrMinor, ourShareMinor }>.
  //     We never mix currencies (e.g. EUR + USD into a single number); the totals
  //     map preserves per-currency isolation per spec §2.3.
  // =========================================================================

  router.post('/financial/settlement/:period/invoice', requireRole('finance', 'admin'), (req, res): void => {
    const { period } = req.params as { period: string };

    // --- Validate period format
    if (!/^\d{4}-\d{2}$/.test(period)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: "period must be in YYYY-MM format (e.g. '2026-04')" } });
      return;
    }
    const [yearStr, monthStr] = period.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (month < 1 || month > 12) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'period month must be 01–12' } });
      return;
    }

    // --- Parse body
    const body = (req.body ?? {}) as { operatorId?: unknown };
    if (typeof body.operatorId !== 'string' || !body.operatorId.trim()) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'operatorId (non-empty string) required' } });
      return;
    }
    const operatorId = body.operatorId.trim();

    // --- Compute window
    const from = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
    const to = Math.floor(Date.UTC(year, month, 1) / 1000);

    // --- Run financial report for this operator+period
    const rawRows = deps.betLog.financialReport({ operatorId, from, to, groupBy: ['operator', 'currency'] });

    if (rawRows.length === 0) {
      res.status(404).json({
        error: {
          code: 'NO_SETTLEMENT_DATA',
          message: `No financial activity for operator '${operatorId}' in period '${period}'`,
        },
      });
      return;
    }

    // --- Look up operator details
    const op = deps.registry.getById(operatorId);
    const shareBps = op?.shareBps ?? 1500;
    const operatorName = op?.name ?? operatorId;

    // --- Build per-currency rows for the invoice
    // groupBy=['operator','currency'] guarantees currency is non-null for every row.
    const currencies = rawRows.map((row) => {
      const ourShareMinor = Math.floor(row.ggrMinor * shareBps / 10000);
      return {
        currency: row.currency!,
        stakeMinor: row.stakeMinor,
        winMinor: row.winMinor,
        ggrMinor: row.ggrMinor,
        shareBps,
        ourShareMinor,
      };
    });

    // --- Build totals per currency (never mix currencies — per spec §2.3)
    // totals is a Record<currency, { ggrMinor, ourShareMinor }> for machine export.
    // Each currency is independent; summing across currencies would mix monetary units.
    const totals: Record<string, { ggrMinor: number; ourShareMinor: number }> = {};
    for (const c of currencies) {
      const existing = totals[c.currency];
      if (existing) {
        // Multiple rows for same currency (shouldn't happen with groupBy=['currency'] but be safe)
        existing.ggrMinor += c.ggrMinor;
        existing.ourShareMinor += c.ourShareMinor;
      } else {
        totals[c.currency] = { ggrMinor: c.ggrMinor, ourShareMinor: c.ourShareMinor };
      }
    }

    const generatedAt = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
    const invoiceId = `inv-${period}-${operatorId}-${Date.now()}`;

    const invoice = {
      invoiceId,
      period,
      operatorId,
      operator: { name: operatorName },
      generatedAt,
      currencies,
      totals,
    };

    // --- Audit (financial export — chain of custody)
    const totalGgrMinorForAudit = currencies.reduce((sum, c) => sum + c.ggrMinor, 0);
    deps.adminAudit.record({
      actor: req.admin!.username,
      action: 'financial.invoice.generated',
      target: `operator:${operatorId}:period:${period}`,
      payload: {
        period,
        operatorId,
        invoiceId,
        currencyCount: currencies.length,
        // NOTE: totalGgrMinorForAudit mixes currencies for audit summary only (string blob)
        // — this is acceptable in an audit log field but NOT in the invoice totals map.
        totalGgrMinorForAudit,
      },
    });

    res.status(200).json(invoice);
  });

  // =========================================================================
  // AB. GET /reconciliation/runs — list (roles: any; JWT enforced at mount)
  //     Spec §9.1. Filters: operatorId, from, to, status; keyset pagination.
  //     Half-open window [from, to) on started_at. NOT audited (read-only).
  // =========================================================================

  router.get('/reconciliation/runs', (req, res): void => {
    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

    // Validate ?status= against the enum
    const statusRaw = q['status'];
    if (statusRaw !== undefined && !RECON_STATUSES.has(statusRaw)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `Unknown status '${statusRaw}'. Valid: ${[...RECON_STATUSES].join(', ')}` } });
      return;
    }

    const from = q['from'] !== undefined ? Number(q['from']) : undefined;
    const to = q['to'] !== undefined ? Number(q['to']) : undefined;
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to))
    ) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from and to must be numeric unix seconds' } });
      return;
    }

    const { rows, nextCursor } = deps.reconciler.listRuns(
      {
        operatorId: q['operatorId'],
        from,
        to,
        status: statusRaw as ReconStatus | undefined,
      },
      page,
    );

    const items = rows.map((r) => ({
      id: r.id,
      operatorId: r.operatorId,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      checkedCount: r.checkedCount,
      mismatchCount: r.mismatchCount,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }));

    res.status(200).json({ items, nextCursor, count: items.length });
  });

  // =========================================================================
  // AC. GET /reconciliation/runs/:id — run + mismatches (roles: any)
  //     Spec §9.2. 404 RECONCILIATION_RUN_NOT_FOUND if absent.
  // =========================================================================

  router.get('/reconciliation/runs/:id', (req, res): void => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isInteger(runId)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'id must be an integer' } });
      return;
    }

    const found = deps.reconciler.getRun(runId);
    if (!found) {
      res.status(404).json({ error: { code: 'RECONCILIATION_RUN_NOT_FOUND', message: `No reconciliation run with id '${runId}'` } });
      return;
    }

    const { run, mismatches } = found;
    res.status(200).json({
      run: {
        id: run.id,
        operatorId: run.operatorId,
        windowStart: run.windowStart,
        windowEnd: run.windowEnd,
        checkedCount: run.checkedCount,
        mismatchCount: run.mismatchCount,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      // details are already decoded to objects by the store
      mismatches: mismatches.map((m) => ({ txnId: m.txnId, kind: m.kind, details: m.details })),
    });
  });

  // =========================================================================
  // AD. POST /reconciliation/runs — on-demand run (roles: admin)
  //     Spec §9.3. Body { operatorId, windowStart, windowEnd }. Runs the diff
  //     synchronously (acceptable for v1) but returns 202 Accepted with the run
  //     id. IS audited (mutation). Half-open window [windowStart, windowEnd).
  // =========================================================================

  router.post('/reconciliation/runs', requireRole('admin'), async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as { operatorId?: unknown; windowStart?: unknown; windowEnd?: unknown };

    if (typeof body.operatorId !== 'string' || !body.operatorId.trim()) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'operatorId (non-empty string) required' } });
      return;
    }
    const operatorId = body.operatorId.trim();

    const windowStart = body.windowStart;
    const windowEnd = body.windowEnd;
    if (typeof windowStart !== 'number' || !Number.isInteger(windowStart)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'windowStart (integer unix seconds) required' } });
      return;
    }
    if (typeof windowEnd !== 'number' || !Number.isInteger(windowEnd)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'windowEnd (integer unix seconds) required' } });
      return;
    }
    if (windowEnd <= windowStart) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'windowEnd must be greater than windowStart' } });
      return;
    }

    // Operator must resolve via the registry, else 404.
    if (!deps.registry.getById(operatorId)) {
      res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND', message: `No operator with id '${operatorId}'` } });
      return;
    }

    const run = await deps.reconciler.run(operatorId, windowStart, windowEnd);

    deps.adminAudit.record({
      actor: req.admin!.username,
      action: 'reconciliation.run',
      target: operatorId,
      payload: { windowStart, windowEnd, runId: run.id, mismatchCount: run.mismatchCount },
    });

    res.status(202).json({ id: run.id, status: run.status, mismatchCount: run.mismatchCount });
  });

  // =========================================================================
  // AE. GET /metrics — Prometheus exposition (spec §10.2)
  //
  //     Roles: any (JWT-only — enforced at the mount via requireAdminJwt).
  //     Production Prometheus scrapers must include a service-account JWT.
  //     Returns text/plain (Prometheus v0.0.4 format) — NOT JSON.
  //
  //     Three metrics are exported:
  //       - wallet_calls_total{operator,endpoint,outcome}
  //       - wallet_errors_total{operator,endpoint,code}
  //       - wallet_latency_ms{operator,endpoint} (histogram + _bucket/_sum/_count)
  // =========================================================================

  router.get('/metrics', async (_req, res): Promise<void> => {
    const body = await getMetricsText();
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.status(200).send(body);
  });

  // =========================================================================
  // AF. GET /health/summary?window=1h|24h — per-operator wallet-call stats
  //     (spec §10.1; roles: any — JWT-only)
  //
  //     v1 HONEST GAPS (documented in spec §10.1):
  //       - Counters/histograms are CUMULATIVE since process start; the
  //         ?window= parameter is validated but is currently advisory.
  //         Rolling-window analytics are Phase-future.
  //       - Operators with zero recorded calls are OMITTED from the response.
  //         (Alternative would be returning zeros for every known operator;
  //         we chose omission to keep the payload bounded by traffic, not by
  //         the size of the operator registry.)
  //
  //     Percentile computation is bucket-bound (the upper edge of the bucket
  //     where the cumulative count first crosses the target quantile). It is
  //     therefore exact within bucket resolution: 5,10,25,50,100,200,500,
  //     1000,2500,5000 ms (and +Inf if everything is in the overflow bucket).
  // =========================================================================

  router.get('/health/summary', async (req, res): Promise<void> => {
    const windowRaw = (req.query['window'] as string | undefined) ?? '1h';
    if (windowRaw !== '1h' && windowRaw !== '24h') {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: "window must be '1h' or '24h'",
        },
      });
      return;
    }
    const windowStr: '1h' | '24h' = windowRaw;

    // Read raw values straight off the registered metrics. No re-aggregation
    // across all metrics-as-JSON — we hold direct references to the three.
    const callsObj = await walletCallsTotal.get();
    const errorsObj = await walletErrorsTotal.get();
    void errorsObj; // intentionally unused — errorRate uses calls counter (outcome=error)
    const latObj = await walletLatencyMs.get();

    // ----- Aggregate per operator -----
    interface Acc {
      total: number;
      errors: number;
      // bucket upper-bound (ms) → cumulative count
      buckets: Map<number, number>;
      sum: number;
      count: number;
    }
    const byOp = new Map<string, Acc>();

    function getAcc(op: string): Acc {
      let a = byOp.get(op);
      if (!a) {
        a = { total: 0, errors: 0, buckets: new Map(), sum: 0, count: 0 };
        byOp.set(op, a);
      }
      return a;
    }

    for (const v of callsObj.values) {
      const op = (v.labels as Record<string, string>)['operator'];
      const outcome = (v.labels as Record<string, string>)['outcome'];
      if (!op) continue;
      const acc = getAcc(op);
      acc.total += v.value;
      if (outcome === 'error') acc.errors += v.value;
    }

    for (const v of latObj.values) {
      const labels = v.labels as Record<string, string>;
      const op = labels['operator'];
      if (!op) continue;
      const acc = getAcc(op);
      // Histogram values have metricName indicating bucket / sum / count.
      const name = (v as { metricName?: string }).metricName;
      if (!name) continue;
      if (name === 'wallet_latency_ms_bucket') {
        const le = labels['le'];
        if (le === undefined) continue;
        const bound = le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le);
        // Use the MAX cumulative observed for each bound (defensive — prom-client
        // emits one value per bucket per label combo, but if a bound recurs we keep
        // the larger count which represents the cumulative scrape).
        const prev = acc.buckets.get(bound) ?? 0;
        acc.buckets.set(bound, Math.max(prev, v.value));
      } else if (name === 'wallet_latency_ms_sum') {
        acc.sum += v.value;
      } else if (name === 'wallet_latency_ms_count') {
        acc.count += v.value;
      }
    }

    function percentileMs(acc: Acc, q: number): number {
      if (acc.count === 0) return 0;
      // Sort bucket bounds ascending; bounds are CUMULATIVE counts.
      const sorted = [...acc.buckets.entries()].sort((a, b) => a[0] - b[0]);
      const target = acc.count * q;
      for (const [bound, cum] of sorted) {
        if (cum >= target) {
          // Bound is exclusive upper edge in Prometheus convention; we return the
          // bound itself as the percentile estimate (exact within bucket resolution).
          // For +Inf, fall back to the sum/count mean is misleading — return -1 to
          // signal "exceeded all buckets" but cap at the largest finite bound.
          if (!Number.isFinite(bound)) {
            // Find the largest finite bound for a sane number
            const finite = sorted.filter(([b]) => Number.isFinite(b));
            const last = finite[finite.length - 1];
            return last ? last[0] : 0;
          }
          return bound;
        }
      }
      return 0;
    }

    const operators = [...byOp.entries()]
      .map(([operatorId, acc]) => ({
        operatorId,
        walletCalls: acc.total,
        errorRate: acc.total > 0 ? acc.errors / acc.total : 0,
        latencyP50Ms: percentileMs(acc, 0.5),
        latencyP95Ms: percentileMs(acc, 0.95),
        latencyP99Ms: percentileMs(acc, 0.99),
      }))
      .sort((a, b) => a.operatorId.localeCompare(b.operatorId));

    res.status(200).json({ window: windowStr, operators });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helper: map BetRow to the §6.1 API item shape
// ---------------------------------------------------------------------------

function toBetItem(bet: import('@crash/wallet').BetRow) {
  return {
    betId: bet.betId,
    operatorId: bet.operatorId,
    playerId: bet.playerId,
    sessionId: bet.sessionId,
    roundId: bet.roundId,
    currency: bet.currency,
    amountMinor: bet.amountMinor,
    state: bet.state,
    betTxnId: bet.betTxnId,
    winTxnId: bet.winTxnId,
    rollbackTxnId: bet.rollbackTxnId,
    betOpTxnId: bet.betOpTxnId,
    winOpTxnId: bet.winOpTxnId,
    winAmountMinor: bet.winAmountMinor,
    multiplier: bet.multiplier,
    errorCode: bet.errorCode,
    createdAt: bet.createdAt,
    updatedAt: bet.updatedAt,
  };
}
