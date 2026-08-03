/**
 * Operator-facing HTTP router — Task 3.3 Phase 3 stub, extended in Task 6.2.
 *
 * Mounts routes:
 *   - POST /sessions/:sessionId/terminate   (Task 3.3 — UNCHANGED)
 *   - GET  /games                           (Task 6.2 — signed, reads from req.operator)
 *   - GET  /rounds                          (Task 6.3 — operator-scoped read)
 *   - GET  /rounds/:roundId                 (Task 6.3 — operator-scoped read)
 *   - GET  /bets                            (Task 6.3 — operator-scoped read)
 *   - GET  /bets/:betId                     (Task 6.3 — operator-scoped read)
 *   - GET  /players/:playerId/sessions      (Task 6.3 — operator-scoped read)
 *   - GET  /players/:playerId/bets          (Task 6.3 — operator-scoped read)
 *   - GET  /sessions/:sessionId             (Task 6.3 — operator-scoped read)
 *   - GET  /financial/summary               (Task 6.3 — operator-scoped read)
 *   - GET  /operator-tx                     (Task 6.3 — operator-scoped read)
 *   - GET  /limits                          (Task 6.3 — reads from req.operator)
 *   - GET  /games/:gameId/config            (Task 6.3 — reads from req.operator)
 *
 * Task 6.3 read routes are ALL operator-scoped by construction: every bet-log /
 * financial query forces operatorId = req.operator.operatorId at the SQL layer
 * (a query-param operatorId, if present, is ignored). They are READ-ONLY — no
 * audit writes. Cross-tenant and not-found return BYTE-IDENTICAL 404 bodies via
 * enforceTenantScope. Keyset cursor pagination only (no OFFSET).
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
import { getSession, deleteSession } from '../store.js';
import { sessionSockets, sendToSession } from '../ws/hub.js';
import { currentRound } from '../game/round.js';
import { voidOperatorBet } from '../game/bets.js';
import type { OperatorAuthedRequest } from './middleware/verify-operator-signature.js';
import { enforceTenantScope } from './middleware/tenant-scope.js';
import { decodeCursor, parseLimit, ALL_BET_STATES } from '@crash/wallet';
import type { PgBetLog, PgOperatorRegistry, BetState, Cursor } from '@crash/wallet';
import type { WalletClientCache } from '../wallet/client-cache.js';
import type { PgOperatorAudit } from './operator-audit-pg.js';

// Valid BetState values for ?state= filter validation — derived from the single
// source of truth in state-machine.ts (mirrors admin.ts; prevents drift).
const BET_STATES = new Set<string>(ALL_BET_STATES);

// ---------------------------------------------------------------------------
// Helper: map a wallet BetRow to the spec §5.1 item shape (all fields present).
// Mirrors admin.ts toBetItem. operatorId is always the calling operator (scoped).
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
  betLog: PgBetLog;
  registry: PgOperatorRegistry;
  walletClientCache: WalletClientCache;
  /** Owns the operator_audit table. Every mutation on this surface is recorded
   *  best-effort (record() never throws). Reads are NOT audited. (spec §2.6) */
  operatorAudit: PgOperatorAudit;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOperatorRouter(deps: OperatorRouterDeps): Router {
  const router = Router();

  // ─── Shared durable-terminate core (Task 6.4) ────────────────────────────
  //
  // The per-session terminate effects (spec §7.1): void in-flight bets → send
  // session_terminated frame → close sockets (code 4001) → DELETE the session
  // from the store (durable invalidation — a reconnect with the same token now
  // finds no row → session_invalid). Extracted so the §6.3 player-lock route
  // reuses the IDENTICAL durable logic.
  //
  // Tolerates an already-gone session: if getSession returns null (e.g. a stale
  // bet_log session_id whose live session has expired or was already terminated),
  // there are no in-flight bets / sockets / row to act on — it no-ops gracefully.
  // NOTE: callers MUST do their own ownership / 404-no-leak check BEFORE calling
  // this; it does not re-verify tenancy.
  async function terminateOneSession(
    sessionId: string,
    operatorId: string,
    reason: string,
    message: string,
  ): Promise<void> {
    // Void in-flight operator bets for this session. currentRound.bets holds the
    // in-memory bets; operator bets have operatorId + betId. Mark cashedOut = true
    // BEFORE awaiting rollback to prevent a double-handle race with the auto-cashout
    // loop or crash handler. The b.operatorId === operatorId guard makes tenant
    // safety LOCAL (defense-in-depth) rather than relying solely on the caller
    // having proven session ownership.
    const liveBets = (currentRound?.bets ?? []).filter(
      (b) => b.playerId === sessionId && b.operatorId === operatorId && !b.cashedOut,
    );

    for (const bet of liveBets) {
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

    // Send the session_terminated frame to all the session's WS connections, then
    // close the sockets with code 4001 and clean up the map.
    sendToSession(sessionId, {
      type: 'session_terminated',
      data: { reason, message },
    });

    const sockets = sessionSockets.get(sessionId);
    if (sockets) {
      for (const ws of sockets) {
        ws.close(4001, 'session_terminated');
      }
      sessionSockets.delete(sessionId);
    }

    // Durable invalidation: delete the session row so a reconnect with the same
    // token finds no session → session_invalid (Phase 3.3 carryover fix — closing
    // the socket alone was refresh-defeatable). deleteSession is a no-op for an
    // already-absent session.
    await deleteSession(sessionId);
  }

  // ─── POST /op/v1/sessions/:sessionId/terminate (spec §7.1 — durable, audited) ─

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

      // Look up the session.
      const session = await getSession(sessionId);

      // 404 for missing, demo, and cross-tenant sessions — never leak existence.
      // No audit on the denied path (no body change, no noise).
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

      // Ownership confirmed — run the durable terminate core.
      await terminateOneSession(sessionId, operator.operatorId, terminateReason, terminateMessage);

      // Audit on the SUCCESS path only (best-effort; never blocks the 204).
      deps.operatorAudit.record({
        operatorId: operator.operatorId,
        action: 'session.terminate',
        target: sessionId,
        payload: { reason: terminateReason },
      });

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

  // =========================================================================
  // Task 6.3 — operator-scoped READ endpoints (signed, read-only, no audit).
  //
  // Tenant isolation by construction: every bet-log / financial call forces
  // operatorId = req.operator.operatorId. Any query-param operatorId is ignored.
  // =========================================================================

  // Shared keyset pagination helper — parse cursor + limit, 400 on bad cursor.
  // Usage: const page = readPage(req, res); if (!page) return;
  function readPage(
    req: Request,
    res: import('express').Response,
  ): { limit: number; cursor: Cursor | undefined } | null {
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

  // ─── GET /op/v1/rounds (spec §4.2) ──────────────────────────────────────────
  // List rounds with at least one of the calling operator's bets. operatorId is
  // forced; a query-param operatorId is ignored. RoundSummary shape WITHOUT yourBets.

  router.get('/rounds', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;

    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;
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

    // operatorId forced — scopes the GROUP BY round_id to this operator's bets.
    const { rows, nextCursor } = await deps.betLog.listRoundsFiltered(
      { operatorId, from, to, minMultiplier, maxMultiplier },
      page,
    );

    const items = rows.map((r) => ({
      roundId: r.roundId,
      // operatorIds is always [operatorId] on this scoped surface (other operators'
      // bets in the same round are excluded by the forced operator_id filter).
      operatorIds: [operatorId],
      roundNumber: null,      // not persisted (Phase-future): requires a dedicated rounds table
      crashPoint: null,       // not persisted (Phase-future): crash point comes from the live RNG loop
      serverSeedHash: null,   // not persisted (Phase-future): RNG seeds live in game-loop memory only
      serverSeed: null,       // not persisted (Phase-future): RNG seeds not stored in bet_log
      betCount: r.betCount,
      totalStakeMinor: r.totalAmountMinorByCurrency,
      totalPayoutMinor: null, // not persisted (Phase-future): payout not pre-aggregated
      distinctPlayers: r.distinctPlayers,
      maxMultiplier: r.maxMultiplier,
      startedAt: r.firstAt,
      crashedAt: r.lastAt,
    }));

    res.status(200).json({ items, nextCursor, count: items.length });
  });

  // ─── GET /op/v1/rounds/:roundId (spec §4.1) ─────────────────────────────────
  // listByRound returns ALL bets across operators; we filter to this operator.
  // An empty FILTERED list → 404 ROUND_NOT_FOUND, which byte-identically covers
  // both "round doesn't exist" and "round is another operator's" (no leak).

  router.get('/rounds/:roundId', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
    const { roundId } = req.params as { roundId: string };

    const allBets = await deps.betLog.listByRound(roundId);
    const bets = allBets.filter((b) => b.operatorId === operatorId);

    if (bets.length === 0) {
      res.status(404).json({ error: { code: 'ROUND_NOT_FOUND', message: `No round with id '${roundId}'` } });
      return;
    }

    const playerIds = new Set(bets.map((b) => b.playerId));
    const createdAts = bets.map((b) => b.createdAt);
    const startedAt = Math.min(...createdAts);
    const crashedAt = Math.max(...createdAts);
    const multipliers = bets.map((b) => b.multiplier).filter((m): m is number => m !== null);
    const maxMultiplier = multipliers.length > 0 ? Math.max(...multipliers) : null;

    const totalStakeMinor: Record<string, number> = {};
    for (const bet of bets) {
      totalStakeMinor[bet.currency] = (totalStakeMinor[bet.currency] ?? 0) + bet.amountMinor;
    }

    res.status(200).json({
      roundId,
      roundNumber: null,      // not persisted (Phase-future): requires a dedicated rounds table
      crashPoint: null,       // not persisted (Phase-future): crash point comes from the live RNG loop
      serverSeedHash: null,   // not persisted (Phase-future): RNG seeds live in game-loop memory only
      serverSeed: null,       // not persisted (Phase-future): RNG seeds not stored in bet_log
      betCount: bets.length,
      totalStakeMinor,
      totalPayoutMinor: null, // not persisted (Phase-future): payout not pre-aggregated
      distinctPlayers: playerIds.size,
      maxMultiplier,
      startedAt,
      crashedAt,
      operatorIds: [operatorId],
      yourBets: bets.map(toBetItem),
    });
  });

  // ─── GET /op/v1/bets (spec §5.1) ────────────────────────────────────────────
  // operatorId forced. Optional playerId/state/betId/txnId/from/to filters.

  router.get('/bets', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;

    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

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

    const { rows, nextCursor } = await deps.betLog.listBetsFiltered(
      {
        operatorId, // forced — never trust a query-param operatorId on this surface
        playerId: q['playerId'],
        state: stateRaw as BetState | undefined,
        betId: q['betId'],
        betTxnId: q['txnId'],
        from,
        to,
      },
      page,
    );

    res.status(200).json({ items: rows.map(toBetItem), nextCursor, count: rows.length });
  });

  // ─── GET /op/v1/bets/:betId (spec §5.2) ─────────────────────────────────────
  // Single bet + derived timeline + walletCalls. Cross-tenant/not-found → 404.

  router.get('/bets/:betId', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
    const { betId } = req.params as { betId: string };

    const bet = await deps.betLog.getById(betId);
    if (!enforceTenantScope(bet?.operatorId ?? null, req, res, 'BET_NOT_FOUND', `No bet with id '${betId}'`)) {
      return;
    }
    // enforceTenantScope returned true ⇒ bet is non-null and owned by this operator.
    const ownedBet = bet!;

    // §5.2 timeline: per-transition history is NOT persisted (Phase-future gap).
    // We derive a minimal 2-entry timeline: creation (PENDING) + current state.
    // Full per-transition timestamps need a dedicated bet_state_transitions table.
    const timeline: Array<{ state: string; at: number; actor: string; operatorTxnId?: string | null }> = [
      { state: 'PENDING', at: ownedBet.createdAt, actor: 'system' },
    ];
    if (ownedBet.state !== 'PENDING' || ownedBet.updatedAt !== ownedBet.createdAt) {
      const entry: { state: string; at: number; actor: string; operatorTxnId?: string | null } = {
        state: ownedBet.state,
        at: ownedBet.updatedAt,
        actor: 'system',
      };
      if (ownedBet.state === 'ARMED' || ownedBet.state === 'SETTLED') {
        entry.operatorTxnId = ownedBet.state === 'ARMED' ? ownedBet.betOpTxnId : ownedBet.winOpTxnId;
      }
      if (entry.state !== 'PENDING') {
        timeline.push(entry);
      }
    }

    // walletCalls: derive from txn_idempotency for the txn ids on this bet.
    // operatorId is forced into getIdempotency (scoped lookup).
    const walletCalls: Array<{
      kind: string;
      txnId: string;
      request: unknown;
      response: unknown;
      attempts: null;
      totalMs: null;
    }> = [];

    const txnIds: Array<{ kind: string; txnId: string }> = [];
    if (ownedBet.betTxnId) txnIds.push({ kind: 'bet', txnId: ownedBet.betTxnId });
    if (ownedBet.winTxnId) txnIds.push({ kind: 'win', txnId: ownedBet.winTxnId });
    if (ownedBet.rollbackTxnId) txnIds.push({ kind: 'rollback', txnId: ownedBet.rollbackTxnId });

    for (const { kind, txnId } of txnIds) {
      const entry = await deps.betLog.getIdempotency(operatorId, txnId);
      if (entry) {
        let resp: unknown = null;
        try { resp = JSON.parse(entry.responseJson); } catch { resp = entry.responseJson; }
        walletCalls.push({
          kind,
          txnId,
          request: null,   // not persisted (Phase-future): request body stored as hash only
          response: resp,
          attempts: null,  // not persisted (Phase-future): retry count not stored in txn_idempotency
          totalMs: null,   // not persisted (Phase-future): latency not stored in txn_idempotency
        });
      }
    }

    res.status(200).json({ bet: toBetItem(ownedBet), timeline, walletCalls });
  });

  // ─── GET /op/v1/players/:playerId/sessions (spec §6.1) ──────────────────────
  // Sessions derived from bet_log (GROUP BY session_id). Zero rows → 404
  // PLAYER_NOT_FOUND (byte-identical for unknown player and cross-tenant player).

  router.get('/players/:playerId/sessions', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
    const { playerId } = req.params as { playerId: string };

    const page = readPage(req, res);
    if (!page) return;

    const { rows, nextCursor } = await deps.betLog.listSessionsByPlayer(operatorId, playerId, page);

    // A first-page empty result means this player has no sessions under this operator
    // (or doesn't exist / is another operator's) → 404, no existence leak.
    if (rows.length === 0 && page.cursor === undefined) {
      res.status(404).json({ error: { code: 'PLAYER_NOT_FOUND', message: `No player with id '${playerId}'` } });
      return;
    }

    res.status(200).json({ items: rows, nextCursor, count: rows.length });
  });

  // ─── GET /op/v1/players/:playerId/bets (spec §6.2) ──────────────────────────
  // Same as /bets but playerId is forced from the path (not query). operatorId forced.

  router.get('/players/:playerId/bets', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
    const { playerId } = req.params as { playerId: string };

    const page = readPage(req, res);
    if (!page) return;

    const q = req.query as Record<string, string | undefined>;

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

    const { rows, nextCursor } = await deps.betLog.listBetsFiltered(
      {
        operatorId,       // forced
        playerId,         // forced from path param
        state: stateRaw as BetState | undefined,
        from,
        to,
      },
      page,
    );

    res.status(200).json({ items: rows.map(toBetItem), nextCursor, count: rows.length });
  });

  // ─── GET /op/v1/sessions/:sessionId (spec §7.2) ─────────────────────────────
  // Looks up the live session in the store. Cross-tenant / not-found → 404.

  router.get('/sessions/:sessionId', async (req: Request, res): Promise<void> => {
    const { sessionId } = req.params as { sessionId: string };

    const session = await getSession(sessionId);
    if (!enforceTenantScope(session?.operatorId ?? null, req, res, 'SESSION_NOT_FOUND', 'No such session')) {
      return;
    }
    const owned = session!;

    res.status(200).json({
      sessionId,
      playerId: owned.playerId,
      currency: owned.currency,
      startedAt: Math.floor(owned.createdAt / 1000),
      lastSeenAt: null, // not persisted (Phase-future): no real last-seen timestamp in the session store
    });
  });

  // ─── GET /op/v1/financial/summary (spec §8.1) ───────────────────────────────
  // GGR/NGR for the window, scoped to this operator. groupBy ∈ {currency, day}
  // ONLY — 'operator' is forbidden here (operator id is the implicit scope and is
  // never returned as a field). ourShareMinor / shareBps are NEVER returned.

  router.get('/financial/summary', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
    const q = req.query as Record<string, string | undefined>;

    // from (required, integer unix seconds)
    if (q['from'] === undefined || q['from'] === '') {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from (unix seconds integer) required' } });
      return;
    }
    const from = Number(q['from']);
    if (!Number.isInteger(from) || !Number.isFinite(from)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from must be an integer unix seconds timestamp' } });
      return;
    }

    // to (required, integer unix seconds, must be > from)
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

    // 365-day window cap
    const MAX_WINDOW_SECONDS = 365 * 86400;
    if (to - from > MAX_WINDOW_SECONDS) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Query window exceeds the 1-year maximum (365 days). Narrow the from/to range.' } });
      return;
    }

    // groupBy: only 'currency' and 'day' allowed; default ['currency']. 'operator' → 400.
    let groupBy: Array<'currency' | 'day'>;
    if (q['groupBy'] === undefined || q['groupBy'] === '') {
      groupBy = ['currency'];
    } else {
      const raw = q['groupBy'].split(',').map((s) => s.trim()).filter(Boolean);
      if (raw.includes('operator')) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: "'operator' is not a valid groupBy on this surface" } });
        return;
      }
      const valid = new Set(['currency', 'day']);
      const bad = raw.filter((v) => !valid.has(v));
      if (bad.length > 0 || raw.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `Invalid groupBy values: ${bad.join(', ')}. Valid values: currency, day` } });
        return;
      }
      groupBy = raw as Array<'currency' | 'day'>;
    }

    const currency = q['currency'] || undefined;

    // operatorId forced — scopes the aggregate even though 'operator' is not a groupBy axis.
    const reportRows = await deps.betLog.financialReport({ operatorId, currency, from, to, groupBy });

    // Drop operatorId entirely (operator never sees its own id as a field) and
    // NEVER include ourShareMinor / shareBps (studio-internal — spec §8 forbids them here).
    const rows = reportRows.map((r) => ({
      currency: r.currency,
      day: r.day,
      betCount: r.betCount,
      stakeMinor: r.stakeMinor,
      winMinor: r.winMinor,
      ggrMinor: r.ggrMinor,
      ngrMinor: r.ngrMinor,
    }));

    res.status(200).json({ from, to, groupBy: [...groupBy], rows });
  });

  // ─── GET /op/v1/operator-tx (spec §8.2) ─────────────────────────────────────
  // Reconciliation feed: txn_idempotency joined with bet_log, scoped to this
  // operator. operatorId field is NOT returned (it's implicit).

  router.get('/operator-tx', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;

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

    // operatorId forced — scopes the feed to this operator's transactions.
    const { rows, nextCursor } = await deps.betLog.listIdempotencyFiltered({ operatorId, from, to }, page);

    const items = rows.map((r) => {
      // Derive status/errorCode from the stored response shape (mirrors admin §W).
      let status: 'OK' | 'FAILED' = 'OK';
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
        operatorTxnId: r.operatorTxnId,
        kind: r.kind,
        playerId: r.playerId,
        betId: r.betId,
        amountMinor: r.kind === 'win' ? r.winAmountMinor : r.amountMinor,
        currency: r.currency,
        status,
        errorCode,
        attempts: null,  // not persisted (Phase-future): retry count not stored
        totalMs: null,   // not persisted (Phase-future): latency not stored
        createdAt: r.createdAt,
      };
    });

    res.status(200).json({ items, nextCursor, count: items.length });
  });

  // ─── GET /op/v1/limits (spec §9.1) ──────────────────────────────────────────
  // Per-currency bet bounds. The operator model stores a single operator-wide
  // min/max; fan it out per enabled currency (honest representation — per-currency
  // limits are a Phase-future addition; mirrors /games).

  router.get('/limits', async (req: Request, res): Promise<void> => {
    const op = (req as OperatorAuthedRequest).operator;
    res.status(200).json({
      limits: op.currencies.map((c) => ({
        currency: c,
        minBetMinor: op.minBetMinor,
        maxBetMinor: op.maxBetMinor,
      })),
    });
  });

  // ─── GET /op/v1/games/:gameId/config (spec §9.3) ────────────────────────────
  // Only 'galaxy-crash' is valid; anything else → 404 NOT_FOUND.

  router.get('/games/:gameId/config', async (req: Request, res): Promise<void> => {
    const op = (req as OperatorAuthedRequest).operator;
    const { gameId } = req.params as { gameId: string };

    if (gameId !== 'galaxy-crash') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `No game with id '${gameId}'` } });
      return;
    }

    res.status(200).json({
      gameId: 'galaxy-crash',
      rtpVariant: op.rtpVariant,
      enabled: true, // per-operator-game disable is Phase-future (no per-game table in v1)
    });
  });

  // =========================================================================
  // Task 6.4 — operator-scoped MUTATING endpoints (signed; operatorId forced;
  // each audited on success to operator_audit — spec §2.6).
  //
  // Tenant isolation by construction: operatorId comes from req.operator; a
  // body/query operatorId is never honoured. Cross-tenant == not-found
  // (byte-identical), and denied attempts are NOT audited.
  // =========================================================================

  // ─── POST /op/v1/players/:playerId/lock (spec §6.3) ─────────────────────────
  // RG / AML mass-terminate: operationally equivalent to calling terminate for
  // every session this player has under this operator. Sessions are discovered
  // from bet_log (scoped by operator_id + player_id), so a cross-tenant player
  // yields an empty set → byte-identical 404 PLAYER_NOT_FOUND (no existence leak).
  //
  // v1 limitation: there is no persistent player_locks table — lock terminates
  // current sessions but does not reject a future /launch (Phase-future).

  router.post('/players/:playerId/lock', async (req: Request, res): Promise<void> => {
    try {
      const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
      const { playerId } = req.params as { playerId: string };

      const body = (req.body ?? {}) as { reason?: unknown; message?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason : 'operator_terminated';
      const message = typeof body.message === 'string' ? body.message : 'Session closed by operator.';

      // Discover the player's session universe, scoped to this operator.
      const sessionIds = await deps.betLog.listDistinctSessionIdsByPlayer(operatorId, playerId);

      if (sessionIds.length === 0) {
        // Unknown player OR cross-tenant player — byte-identical 404, no audit.
        res.status(404).json({ error: { code: 'PLAYER_NOT_FOUND', message: `No player with id '${playerId}'` } });
        return;
      }

      // Terminate each discovered session with the IDENTICAL durable logic.
      // terminateOneSession tolerates already-gone sessions (getSession null → no-op).
      for (const sessionId of sessionIds) {
        await terminateOneSession(sessionId, operatorId, reason, message);
      }

      // Audit on success (best-effort; never blocks the 204).
      deps.operatorAudit.record({
        operatorId,
        action: 'player.lock',
        target: playerId,
        payload: { reason },
      });

      res.status(204).end();
    } catch (err) {
      console.error('[operator] player lock unexpected error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'lock failed' } });
      }
    }
  });

  // ─── POST /op/v1/players/:playerId/unlock (spec §6.4) ───────────────────────
  // No persistent lock state in v1, so this is a server-side NO-OP: it records a
  // player.unlock audit row and returns 204. No 404 — the route is a forward-compat
  // affordance for when a persistent player_locks table lands (Phase-future). The
  // operator's own system is responsible for re-enabling launches for this player.

  router.post('/players/:playerId/unlock', async (req: Request, res): Promise<void> => {
    const operatorId = (req as OperatorAuthedRequest).operator.operatorId;
    const { playerId } = req.params as { playerId: string };

    // No store mutation in v1 (no persistent lock state) — audit only.
    deps.operatorAudit.record({
      operatorId,
      action: 'player.unlock',
      target: playerId,
    });

    res.status(204).end();
  });

  // ─── POST /op/v1/limits (spec §9.2) ─────────────────────────────────────────
  // Update bet bounds. Honest-subset enforcement: we validate currency-enabled +
  // basic invariants only. There is NO per-operator "studio ceiling" field in the
  // operator model, so LIMIT_OUT_OF_RANGE fires only on the basic invariants below
  // (a real studio ceiling is Phase-future).
  //
  // Honest-gap (persistence): the operator model stores a SINGLE operator-wide
  // min/max (not per-currency). Updating e.g. EUR limits therefore updates the
  // operator-wide bound affecting ALL currencies. Per-currency persistence is
  // Phase-future — the same fan-out gap as GET /limits and GET /games.

  router.post('/limits', async (req: Request, res): Promise<void> => {
    const op = (req as OperatorAuthedRequest).operator;
    const operatorId = op.operatorId;

    const body = (req.body ?? {}) as { currency?: unknown; minBetMinor?: unknown; maxBetMinor?: unknown };

    // currency must be a string in the operator's enabled list.
    if (typeof body.currency !== 'string' || !op.currencies.includes(body.currency)) {
      res.status(422).json({ error: { code: 'CURRENCY_NOT_ENABLED', message: 'Currency is not enabled for this operator' } });
      return;
    }
    const currency = body.currency;

    // Basic invariants — honest subset (no studio ceiling exists in the model):
    //   minBetMinor / maxBetMinor are non-negative integers, minBetMinor >= 1,
    //   and maxBetMinor >= minBetMinor.
    const minBetMinor = body.minBetMinor;
    const maxBetMinor = body.maxBetMinor;
    if (
      !Number.isInteger(minBetMinor) ||
      !Number.isInteger(maxBetMinor) ||
      (minBetMinor as number) < 1 ||
      (maxBetMinor as number) < 0 ||
      (maxBetMinor as number) < (minBetMinor as number)
    ) {
      res.status(422).json({ error: { code: 'LIMIT_OUT_OF_RANGE', message: 'minBetMinor must be >= 1 and maxBetMinor >= minBetMinor (both non-negative integers)' } });
      return;
    }

    // Persist operator-wide (per-currency persistence is Phase-future — see above).
    await deps.registry.update(operatorId, {
      minBetMinor: minBetMinor as number,
      maxBetMinor: maxBetMinor as number,
    });

    // Audit on success (best-effort; never blocks the 200).
    deps.operatorAudit.record({
      operatorId,
      action: 'limits.update',
      target: currency,
      payload: { minBetMinor, maxBetMinor },
    });

    // Echo the GET /limits shape reflecting the new (operator-wide) values.
    res.status(200).json({
      limits: op.currencies.map((c) => ({
        currency: c,
        minBetMinor: minBetMinor as number,
        maxBetMinor: maxBetMinor as number,
      })),
    });
  });

  return router;
}
