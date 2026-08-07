/**
 * Simulate game HTTP router — mounted at /api/simulate.
 *
 * Simulate is a casino-style sports game: a player builds a bet slip from real
 * harvested odds (today / tomorrow / this week), then *simulates* it. The
 * outcome is drawn by a provably-fair RNG at a configured RTP (see
 * @crash/shared/simulate) — NOT the real match result — so it plays like a
 * casino game while the fixtures stay real.
 *
 * Economy is play-money ("credits"), tracked in the same RocksDB session store
 * the crash demo uses. The store is injected as a small `SimEconomy` interface
 * so this router's logic is unit-testable without RocksDB/Postgres.
 *
 * Endpoints:
 *   POST /session              → { sessionId, balance, currency:'CREDITS' }
 *   GET  /fixtures?window=      → { window, fixtures:[...] }
 *   POST /play                  → simulate a slip, settle the wallet, reveal seed
 *   GET  /config                → { rtp, maxStake, startingBalance }
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  simulateSlip,
  generateServerSeed,
  InvalidSlipError,
  DEFAULT_SIMULATE_CONFIG,
  type Selection,
  type SimulateConfig,
} from '@crash/shared/simulate';
import {
  getFeed as defaultGetFeed,
  getFixtures as defaultGetFixtures,
  type Fixture,
  type FixtureWindow,
} from '../simulate/fixtures.js';

// ---------------------------------------------------------------------------
// Injected economy (play-money). Implemented over store.ts in production,
// faked in tests.
// ---------------------------------------------------------------------------

export class SimInsufficientFunds extends Error {
  constructor() {
    super('insufficient balance');
    this.name = 'SimInsufficientFunds';
  }
}

export interface SimEconomy {
  /** Create a fresh play-money session, returning its id + starting balance. */
  createSession(startingBalance: number): Promise<{ sessionId: string; balance: number }>;
  /** Current balance, or null if the session is unknown/expired. */
  balanceOf(sessionId: string): Promise<number | null>;
  /** Apply a signed delta and return the new balance. */
  adjust(sessionId: string, delta: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SimulateServerConfig extends SimulateConfig {
  /** Play-money balance a new session starts with. */
  startingBalance: number;
  /** Max stake per slip (credits). */
  maxStake: number;
}

export function loadConfig(): SimulateServerConfig {
  const rtp = Number(process.env['SIMULATE_RTP'] ?? DEFAULT_SIMULATE_CONFIG.rtp);
  return {
    ...DEFAULT_SIMULATE_CONFIG,
    rtp: Number.isFinite(rtp) && rtp > 0 && rtp <= 1 ? rtp : DEFAULT_SIMULATE_CONFIG.rtp,
    startingBalance: Number(process.env['SIMULATE_DEMO_BALANCE'] ?? 1000),
    maxStake: Number(process.env['SIMULATE_MAX_STAKE'] ?? 1000),
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SimulateRouterDeps {
  economy: SimEconomy;
  /** Injectable for tests; defaults to the S3/sample-backed loaders. */
  getFeed?: typeof defaultGetFeed;
  getFixtures?: typeof defaultGetFixtures;
  config?: SimulateServerConfig;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Pick1x2 = 'home' | 'draw' | 'away';

const PICK_LABEL: Record<Pick1x2, string> = { home: '1', draw: 'X', away: '2' };

/** Resolve the SERVER-side odds for a (fixture, market, pick). Null if absent. */
function oddsFor(fx: Fixture, market: string, pick: string): number | null {
  if (market === '1x2') {
    const m = fx.markets['1x2'];
    if (!m) return null;
    if (pick === 'home') return m.home;
    if (pick === 'draw') return m.draw;
    if (pick === 'away') return m.away;
  }
  return null;
}

/** Round credits to 2dp to avoid float dust. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createSimulateRouter(deps: SimulateRouterDeps): Router {
  const router = Router();
  const getFeed = deps.getFeed ?? defaultGetFeed;
  const getFixtures = deps.getFixtures ?? defaultGetFixtures;
  const config = deps.config ?? loadConfig();
  const now = deps.now ?? Date.now;

  // ── POST /session ─────────────────────────────────────────────────────────
  router.post('/session', async (_req, res) => {
    try {
      const s = await deps.economy.createSession(config.startingBalance);
      res.status(201).json({ sessionId: s.sessionId, balance: s.balance, currency: 'CREDITS' });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL', message: (err as Error).message } });
    }
  });

  // ── GET /config ───────────────────────────────────────────────────────────
  router.get('/config', (_req, res) => {
    res.json({ rtp: config.rtp, maxStake: config.maxStake, startingBalance: config.startingBalance, maxLegs: config.maxLegs });
  });

  // ── GET /fixtures?window= ─────────────────────────────────────────────────
  router.get('/fixtures', async (req, res) => {
    const raw = String(req.query.window ?? 'all').toLowerCase();
    const window: FixtureWindow | 'all' =
      raw === 'today' || raw === 'tomorrow' || raw === 'week' ? (raw as FixtureWindow) : 'all';
    try {
      const list = await getFixtures(window, now());
      const fixtures = list.map((fx) => {
        const m = fx.markets['1x2'];
        return {
          eventId: fx.eventId,
          sport: fx.sport,
          league: fx.league,
          home: fx.home,
          away: fx.away,
          kickoff: fx.kickoff,
          window: fx.window,
          markets: m
            ? [
                {
                  market: '1x2',
                  name: 'Match Result',
                  options: (['home', 'draw', 'away'] as Pick1x2[]).map((pick) => ({
                    pick,
                    label: PICK_LABEL[pick],
                    odds: m[pick],
                  })),
                },
              ]
            : [],
        };
      });
      res.json({ window, count: fixtures.length, fixtures });
    } catch (err) {
      res.status(503).json({ error: { code: 'FEED_UNAVAILABLE', message: (err as Error).message } });
    }
  });

  // ── POST /play ────────────────────────────────────────────────────────────
  // Body: { sessionId, stake, selections: [{ eventId, market?, pick }] }
  router.post('/play', async (req, res) => {
   try {
    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      stake?: unknown;
      selections?: unknown;
    };

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'sessionId required' } });
      return;
    }

    const stake = Number(body.stake);
    if (!Number.isFinite(stake) || stake <= 0) {
      res.status(400).json({ error: { code: 'INVALID_STAKE', message: 'stake must be a positive number' } });
      return;
    }
    if (stake > config.maxStake) {
      res.status(400).json({ error: { code: 'STAKE_TOO_LARGE', message: `max stake is ${config.maxStake}` } });
      return;
    }

    if (!Array.isArray(body.selections) || body.selections.length === 0) {
      res.status(400).json({ error: { code: 'EMPTY_SLIP', message: 'at least one selection required' } });
      return;
    }

    // Resolve odds server-side from the current feed (never trust client odds).
    let feed;
    try {
      feed = await getFeed(now());
    } catch (err) {
      res.status(503).json({ error: { code: 'FEED_UNAVAILABLE', message: (err as Error).message } });
      return;
    }
    const byId = new Map(feed.fixtures.map((f) => [f.eventId, f]));

    const selections: Selection[] = [];
    for (const raw of body.selections as Array<Record<string, unknown>>) {
      const eventId = typeof raw.eventId === 'string' ? raw.eventId : '';
      const market = typeof raw.market === 'string' ? raw.market : '1x2';
      const pick = typeof raw.pick === 'string' ? raw.pick : '';
      const fx = byId.get(eventId);
      if (!fx) {
        res.status(400).json({ error: { code: 'UNKNOWN_EVENT', message: `event not in feed: ${eventId}` } });
        return;
      }
      if (new Date(fx.kickoff).getTime() <= now()) {
        res.status(400).json({ error: { code: 'EVENT_STARTED', message: `event already started: ${eventId}` } });
        return;
      }
      const odds = oddsFor(fx, market, pick);
      if (odds == null) {
        res.status(400).json({ error: { code: 'INVALID_PICK', message: `no odds for ${eventId} ${market}/${pick}` } });
        return;
      }
      selections.push({
        eventId,
        market,
        pick,
        odds,
        label: `${fx.home} v ${fx.away} — ${pick}`,
      });
    }

    // Check funds, then debit the stake.
    const balance = await deps.economy.balanceOf(sessionId);
    if (balance == null) {
      res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'unknown or expired session' } });
      return;
    }
    if (balance < stake) {
      res.status(402).json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'balance too low for this stake' } });
      return;
    }

    // Provably-fair draw.
    const serverSeed = generateServerSeed();
    const nonce = randomUUID();
    let result;
    try {
      result = simulateSlip(serverSeed, nonce, selections, config);
    } catch (err) {
      if (err instanceof InvalidSlipError) {
        res.status(400).json({ error: { code: 'INVALID_SLIP', message: err.message } });
        return;
      }
      throw err;
    }

    // Settle: debit stake, credit payout on a win.
    let newBalance: number;
    try {
      newBalance = await deps.economy.adjust(sessionId, -stake);
    } catch (err) {
      if (err instanceof SimInsufficientFunds) {
        res.status(402).json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'balance too low for this stake' } });
        return;
      }
      throw err;
    }
    // Overdraw guard: the pre-check + debit are two steps, so a concurrent play
    // could in principle drive the balance negative. If the debit landed below
    // zero, refund it and reject — no persisted negative balance can result.
    if (newBalance < -1e-9) {
      newBalance = await deps.economy.adjust(sessionId, stake);
      res.status(402).json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'balance too low for this stake' } });
      return;
    }
    const payout = result.won ? round2(stake * result.payoutMultiplier) : 0;
    if (payout > 0) {
      newBalance = await deps.economy.adjust(sessionId, payout);
    }

    res.json({
      won: result.won,
      stake: round2(stake),
      combinedOdds: round2(result.combinedOdds),
      payoutMultiplier: result.payoutMultiplier,
      payout,
      profit: round2(payout - stake),
      balance: round2(newBalance),
      legs: result.legs.map((l) => ({
        eventId: l.eventId,
        market: l.market,
        pick: l.pick,
        odds: l.odds,
        won: l.won,
      })),
      // Provably-fair reveal — client can recompute with verifySlip().
      fair: {
        serverSeed,
        commit: result.commit,
        nonce: result.nonce,
        selections: selections.map((s) => ({ eventId: s.eventId, market: s.market, pick: s.pick, odds: s.odds })),
        rtp: config.rtp,
      },
    });
   } catch (err) {
      // Async handlers reject silently under Express 4, so guard here.
      console.error('[simulate] /play error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
      }
   }
  });

  return router;
}
