/**
 * Real-money Simulated Matches + the player's history. Mounted at /api.
 *
 *   POST /simulate/bets            player JWT  {mode:'single'|'multi', stakeMinor, selections:[{eventId, market, pick, odds?}], acceptOddsChanges?}
 *                                              409 ODDS_CHANGED {changes} when a sent `odds` no longer matches, unless acceptOddsChanges
 *   GET  /account/bets             player JWT  ?status=all|active|settled&from&to&page&pageSize
 *   GET  /account/bets/:betId      player JWT  one simulated bet with legs + provably-fair reveal
 *   GET  /account/transactions     player JWT  ?type=all|deposit|withdrawal&from&to&page&pageSize
 *
 * Bets resolve at placement with the same provably-fair engine as play-money
 * Simulate (@crash/shared/simulate); the stake debit, bet record and any win
 * credit are one transaction (PgSimBetsRepo.place).
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { generateServerSeed, simulateSlip, type SlipResult } from '@crash/shared/simulate';
import type { PgSimBetsRepo, SimBetInput } from '@crash/wallet/sim-bets-repo-pg';
import type { PgPlayerHistory } from '@crash/wallet/player-history-pg';
import type { PlayersRepo } from '@crash/wallet/players-repo';
import { InsufficientFundsError, type WalletLedger } from '@crash/wallet/wallet-ledger';
import { requirePlayerJwt } from './lobby.js';
import { loadConfig, resolveSelections } from './simulate.js';
import { getFeed as defaultGetFeed } from '../simulate/fixtures.js';

export interface RealBetLimits {
  minStakeMinor: number;
  maxStakeMinor: number;
  maxPayoutMinor: number;
}

export function loadRealBetLimits(env: NodeJS.ProcessEnv = process.env): RealBetLimits {
  const n = (key: string, dflt: number) => {
    const v = Number(env[key]);
    return Number.isInteger(v) && v > 0 ? v : dflt;
  };
  return {
    minStakeMinor: n('SIMBET_MIN_STAKE_MINOR', 1_000),
    maxStakeMinor: n('SIMBET_MAX_STAKE_MINOR', 1_000_000),
    maxPayoutMinor: n('SIMBET_MAX_PAYOUT_MINOR', 100_000_000),
  };
}

export interface PlayerBetsDeps {
  bets: PgSimBetsRepo;
  history: PgPlayerHistory;
  players: PlayersRepo;
  wallet: WalletLedger;
  getFeed?: typeof defaultGetFeed;
  now?: () => number;
  limits?: RealBetLimits;
  simConfig?: ReturnType<typeof loadConfig>;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function createPlayerBetsRouter(deps: PlayerBetsDeps): Router {
  const router = Router();
  const getFeed = deps.getFeed ?? defaultGetFeed;
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? loadRealBetLimits();
  const config = deps.simConfig ?? loadConfig();

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        console.error('[player-bets] request failed:', err);
        if (!res.headersSent) fail(res, 500, 'INTERNAL', 'internal error');
      }
    };

  router.post('/simulate/bets', requirePlayerJwt, handle(async (req, res) => {
    const playerId = req.player!.playerId;
    const body = (req.body ?? {}) as { mode?: unknown; stakeMinor?: unknown; selections?: unknown; acceptOddsChanges?: unknown };
    const mode = body.mode === 'multi' ? 'multi' : body.mode === 'single' ? 'single' : null;
    if (!mode) return fail(res, 400, 'INVALID_MODE', "mode must be 'single' or 'multi'");
    const stake = Number(body.stakeMinor);
    if (!Number.isInteger(stake) || stake < limits.minStakeMinor) {
      return fail(res, 400, 'STAKE_TOO_SMALL', `minimum stake is ${limits.minStakeMinor} (minor units)`);
    }
    if (stake > limits.maxStakeMinor) return fail(res, 400, 'STAKE_TOO_LARGE', `maximum stake is ${limits.maxStakeMinor} (minor units)`);
    if (!Array.isArray(body.selections) || body.selections.length === 0) return fail(res, 400, 'EMPTY_SLIP', 'add at least one selection');
    // Checked before any odds fitting: an oversized slip must not buy event-loop time.
    if (body.selections.length > config.maxLegs) return fail(res, 400, 'INVALID_SLIP', `at most ${config.maxLegs} selections`);

    const player = await deps.players.getById(playerId);
    if (!player) return fail(res, 401, 'UNAUTHORIZED', 'player not found');
    const totalStake = mode === 'multi' ? stake : stake * body.selections.length;
    // Cheap early check; the authoritative one is inside the settling transaction.
    if ((await deps.wallet.balance(playerId, player.currency)) < totalStake) {
      return fail(res, 402, 'INSUFFICIENT_FUNDS', 'Your balance is too low for this bet.');
    }

    let feed;
    try {
      feed = await getFeed(now());
    } catch (err) {
      return fail(res, 503, 'FEED_UNAVAILABLE', (err as Error).message);
    }
    const rawSelections = body.selections as Array<Record<string, unknown>>;
    const resolved = resolveSelections(feed, rawSelections, now());
    if (!resolved.ok) return fail(res, 400, resolved.code, resolved.message);
    const { selections, fixtures } = resolved;

    // The slip was priced when the player built it and the feed may have moved
    // since. Unless they accepted odds changes, never place at a price they
    // didn't see: report the current prices and let them decide.
    if (body.acceptOddsChanges !== true) {
      const changes = selections.flatMap((s, i) => {
        const seen = Number(rawSelections[i]?.odds);
        return Number.isFinite(seen) && seen > 0 && Math.abs(seen - s.odds) > 1e-9
          ? [{ eventId: s.eventId, market: s.market, pick: s.pick, odds: s.odds }]
          : [];
      });
      if (changes.length > 0) {
        res.status(409).json({ error: { code: 'ODDS_CHANGED', message: 'Odds have changed on your slip — check the new prices and place again.', changes } });
        return;
      }
    }

    const serverSeed = generateServerSeed();
    let slips: SlipResult[];
    try {
      slips = mode === 'multi'
        ? [simulateSlip(serverSeed, randomUUID(), selections, config)]
        : selections.map((sel) => simulateSlip(serverSeed, randomUUID(), [sel], config));
    } catch (err) {
      return fail(res, 400, 'INVALID_SLIP', (err as Error).message);
    }

    const inputs: SimBetInput[] = slips.map((slip, i) => {
      const legsSel = mode === 'multi' ? selections : [selections[i]!];
      return {
        mode,
        stakeMinor: stake,
        totalOdds: slip.combinedOdds,
        won: slip.won,
        payoutMinor: slip.won ? Math.min(Math.floor(stake * slip.payoutMultiplier), limits.maxPayoutMinor) : 0,
        serverSeed,
        commit: slip.commit,
        nonce: slip.nonce,
        rtp: config.rtp,
        legs: slip.legs.map((leg, j) => {
          const fx = fixtures.get(leg.eventId);
          return {
            eventId: leg.eventId,
            league: fx?.league ?? null,
            home: fx?.home ?? null,
            away: fx?.away ?? null,
            kickoff: fx?.kickoff ?? null,
            market: leg.market,
            pick: leg.pick,
            label: legsSel[j]?.label ?? null,
            odds: leg.odds,
            won: leg.won,
            score: leg.score ?? null,
            goalRates: legsSel[j]?.goalRates ?? null,
            timeline: leg.timeline ?? null,
          };
        }),
      };
    });

    try {
      const placed = await deps.bets.place(playerId, player.currency, inputs);
      res.status(201).json({
        balanceMinor: placed.balanceMinor,
        currency: player.currency,
        bets: placed.bets.map((b) => ({
          betId: b.betId,
          mode: b.mode,
          stakeMinor: b.stakeMinor,
          totalOdds: b.totalOdds,
          won: b.won,
          payoutMinor: b.payoutMinor,
          createdAt: b.createdAt,
          legs: b.legs.map(({ goalRates: _g, ...leg }) => leg),
          fair: { serverSeed: b.serverSeed, commit: b.commit, nonce: b.nonce, rtp: b.rtp },
        })),
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) return fail(res, 402, 'INSUFFICIENT_FUNDS', 'Your balance is too low for this bet.');
      throw err;
    }
  }));

  router.get('/account/bets', requirePlayerJwt, handle(async (req, res) => {
    const q = req.query;
    const status = q.status === 'active' || q.status === 'settled' ? q.status : 'all';
    res.json(await deps.history.bets(req.player!.playerId, {
      status,
      from: parseDate(q.from),
      to: parseDate(q.to),
      page: Number(q.page) || 1,
      pageSize: Number(q.pageSize) || 20,
    }));
  }));

  router.get('/account/bets/:betId', requirePlayerJwt, handle(async (req, res) => {
    const bet = await deps.bets.get(req.player!.playerId, String(req.params.betId));
    if (!bet) return fail(res, 404, 'BET_NOT_FOUND', 'bet not found');
    const { serverSeed, commit, nonce, rtp, ...rest } = bet;
    res.json({ ...rest, fair: { serverSeed, commit, nonce, rtp } });
  }));

  router.get('/account/transactions', requirePlayerJwt, handle(async (req, res) => {
    const q = req.query;
    const type = q.type === 'deposit' || q.type === 'withdrawal' ? q.type : 'all';
    res.json(await deps.history.transactions(req.player!.playerId, {
      type,
      from: parseDate(q.from),
      to: parseDate(q.to),
      page: Number(q.page) || 1,
      pageSize: Number(q.pageSize) || 20,
    }));
  }));

  return router;
}
