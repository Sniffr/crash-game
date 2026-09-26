const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { verifySlip, halfTimeFrom, DEFAULT_SIMULATE_CONFIG, type GoalEvent, type Selection } from '@crash/shared/simulate';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { PgSimBetsRepo } from '@crash/wallet/sim-bets-repo-pg';
import { PgPlayerHistory } from '@crash/wallet/player-history-pg';
import type { FixturesFeed } from '../simulate/fixtures.js';
import { signPlayerJwt } from './lobby.js';
import { createPlayerBetsRouter, type RealBetLimits } from './player-bets.js';

const NOW = Date.UTC(2026, 9, 1, 6, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const FEED: FixturesFeed = {
  feedVersion: 1,
  generatedAt: iso(NOW),
  source: 'test',
  sport: 'football',
  fixtures: [
    ...Array.from({ length: 25 }, (_, i) => ({
      eventId: `fx-${i}`, sport: 'football', league: 'EPL', home: `Home${i}`, away: `Away${i}`,
      kickoff: iso(NOW + (i + 2) * 3_600_000),
      markets: { '1x2': { home: 1.5, draw: 4.0, away: 6.0 } },
    })),
    { eventId: 'started', sport: 'football', league: 'EPL', home: 'Old', away: 'Match', kickoff: iso(NOW - 60_000), markets: { '1x2': { home: 2, draw: 3, away: 4 } } },
  ],
};

const LIMITS: RealBetLimits = { minStakeMinor: 1_000, maxStakeMinor: 500_000, maxPayoutMinor: 100_000_000 };

let db: TestDb;
let wallet: WalletLedger;
let players: PlayersRepo;
let history: PgPlayerHistory;

function makeApp(limits = LIMITS) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPlayerBetsRouter({
    bets: new PgSimBetsRepo(db.pool, wallet), history, players, wallet,
    getFeed: async () => FEED, now: () => NOW, limits,
    simConfig: { ...DEFAULT_SIMULATE_CONFIG, rtp: 0.95, startingBalance: 0, maxStake: 0 },
  }));
  return app;
}
let app: express.Application;

beforeAll(async () => {
  db = await makeTestDb();
  wallet = new WalletLedger(db.pool);
  players = new PlayersRepo(db.pool);
  history = new PgPlayerHistory(db.pool);
  app = makeApp();
});

afterAll(async () => {
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

async function player(name: string, fundMinor = 1_000_000) {
  const p = await players.create(name, 'hash', { currency: 'KES' });
  if (fundMinor > 0) await wallet.deposit(p.playerId, fundMinor, 'KES', `fund-${name}`);
  return { id: p.playerId, auth: `Bearer ${await signPlayerJwt(p.playerId)}` };
}

const bet = (auth: string, body: object, a = app) => request(a).post('/api/simulate/bets').set('Authorization', auth).send(body);
const sel = (i: number, pick = 'home') => ({ eventId: `fx-${i}`, market: '1x2', pick });

describe('POST /api/simulate/bets', () => {
  it('places a multi bet: debits the stake, credits any win, and the stored bet verifies', async () => {
    const p = await player('multi');
    const res = await bet(p.auth, { mode: 'multi', stakeMinor: 10_000, selections: [sel(0), sel(1)] });
    expect(res.status).toBe(201);
    const b = res.body.bets[0];
    expect(b).toMatchObject({ mode: 'multi', stakeMinor: 10_000, totalOdds: 2.25 });
    expect(b.betId).toMatch(/^SIM\d{7}$/);
    expect(b.payoutMinor).toBe(b.won ? 22_500 : 0);
    expect(res.body.balanceMinor).toBe(1_000_000 - 10_000 + b.payoutMinor);
    expect(await wallet.balance(p.id)).toBe(res.body.balanceMinor);

    const stored = await request(app).get(`/api/account/bets/${b.betId}`).set('Authorization', p.auth);
    const selections: Selection[] = stored.body.legs.map((l: { eventId: string; market: string; pick: string; odds: number; goalRates: never }) => ({
      eventId: l.eventId, market: l.market, pick: l.pick, odds: l.odds, goalRates: l.goalRates,
    }));
    const reported = {
      won: stored.body.won,
      combinedOdds: stored.body.totalOdds,
      payoutMultiplier: stored.body.won ? stored.body.totalOdds : 0,
      nonce: stored.body.fair.nonce,
      commit: stored.body.fair.commit,
      legs: stored.body.legs.map((l: { won: boolean; score: unknown; timeline: GoalEvent[] | null }) => ({
        won: l.won,
        score: l.score ?? undefined,
        timeline: l.timeline ?? undefined,
        halfTimeScore: l.timeline ? halfTimeFrom(l.timeline) : undefined,
      })),
    };
    const verdict = verifySlip(stored.body.fair.serverSeed, reported as never, selections, { ...DEFAULT_SIMULATE_CONFIG, rtp: 0.95 });
    expect(verdict.ok).toBe(true);
  });

  it('places one bet per selection in single mode', async () => {
    const p = await player('singles');
    const res = await bet(p.auth, { mode: 'single', stakeMinor: 5_000, selections: [sel(2), sel(3), sel(4)] });
    expect(res.status).toBe(201);
    expect(res.body.bets).toHaveLength(3);
    const won = res.body.bets.reduce((a: number, b: { payoutMinor: number }) => a + b.payoutMinor, 0);
    expect(res.body.balanceMinor).toBe(1_000_000 - 15_000 + won);
  });

  it('enforces stake limits', async () => {
    const p = await player('limits');
    expect((await bet(p.auth, { mode: 'multi', stakeMinor: 500, selections: [sel(0)] })).body.error.code).toBe('STAKE_TOO_SMALL');
    expect((await bet(p.auth, { mode: 'multi', stakeMinor: 600_000, selections: [sel(0)] })).body.error.code).toBe('STAKE_TOO_LARGE');
    expect((await bet(p.auth, { mode: 'multi', stakeMinor: 1_500.5, selections: [sel(0)] })).body.error.code).toBe('STAKE_TOO_SMALL');
  });

  it('returns 402 and records nothing when the balance is too low', async () => {
    const p = await player('broke', 5_000);
    const res = await bet(p.auth, { mode: 'single', stakeMinor: 3_000, selections: [sel(0), sel(1)] });
    expect(res.status).toBe(402);
    expect(await wallet.balance(p.id)).toBe(5_000);
    const hist = await request(app).get('/api/account/bets').set('Authorization', p.auth);
    expect(hist.body.total).toBe(0);
  });

  it('rejects a fixture that has kicked off', async () => {
    const p = await player('started');
    expect((await bet(p.auth, { mode: 'multi', stakeMinor: 1_000, selections: [{ eventId: 'started', pick: 'home' }] })).body.error.code).toBe('EVENT_STARTED');
  });

  it('refuses a slip whose odds moved unless the player accepts changes, and always prices from the server', async () => {
    const p = await player('odds-moved', 10_000);
    const stale = await bet(p.auth, { mode: 'multi', stakeMinor: 1_000, selections: [{ ...sel(5), odds: 1.7 }, { ...sel(6), odds: 1.5 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('ODDS_CHANGED');
    expect(stale.body.error.changes).toEqual([{ eventId: 'fx-5', market: '1x2', pick: 'home', odds: 1.5 }]);
    expect(await wallet.balance(p.id)).toBe(10_000);

    const accepted = await bet(p.auth, { mode: 'multi', stakeMinor: 1_000, acceptOddsChanges: true, selections: [{ ...sel(5), odds: 999 }] });
    expect(accepted.status).toBe(201);
    expect(accepted.body.bets[0].totalOdds).toBe(1.5);

    const current = await bet(p.auth, { mode: 'multi', stakeMinor: 1_000, selections: [{ ...sel(7), odds: 1.5 }] });
    expect(current.status).toBe(201);
  });

  it('caps a win at the configured maximum payout', async () => {
    const capped = makeApp({ ...LIMITS, maxPayoutMinor: 1_200 });
    const p = await player('capped');
    // 20 singles at 1.5 → ~12 wins; each would pay 1,500 uncapped.
    const res = await bet(p.auth, { mode: 'single', stakeMinor: 1_000, selections: Array.from({ length: 20 }, (_, i) => sel(i)) }, capped);
    const payouts = res.body.bets.map((b: { payoutMinor: number }) => b.payoutMinor);
    expect(payouts.some((x: number) => x > 0)).toBe(true);
    expect(Math.max(...payouts)).toBe(1_200);
  });

  it('requires a player token', async () => {
    expect((await request(app).post('/api/simulate/bets').send({ mode: 'multi', stakeMinor: 1_000, selections: [sel(0)] })).status).toBe(401);
  });
});

describe('history', () => {
  it('lists bets newest first and filters by status', async () => {
    const p = await player('historian');
    await bet(p.auth, { mode: 'multi', stakeMinor: 2_000, selections: [sel(6)] });
    await bet(p.auth, { mode: 'single', stakeMinor: 1_000, selections: [sel(7), sel(8)] });

    const all = await request(app).get('/api/account/bets?pageSize=10').set('Authorization', p.auth);
    expect(all.body.total).toBe(3);
    expect(all.body.items[0].legs).toHaveLength(1);
    expect(all.body.items.every((b: { status: string }) => b.status === 'won' || b.status === 'lost')).toBe(true);

    const active = await request(app).get('/api/account/bets?status=active').set('Authorization', p.auth);
    expect(active.body.total).toBe(0);

    const paged = await request(app).get('/api/account/bets?pageSize=2&page=2').set('Authorization', p.auth);
    expect(paged.body.items).toHaveLength(1);
  });

  it('lists deposits and withdrawals with player-facing statuses and ids', async () => {
    const p = await player('txns', 0);
    await db.pool.query(
      `INSERT INTO deposits (reference, player_id, currency, amount_minor, status) VALUES
         ('game-dep-a', $1, 'KES', 50000, 'settled'), ('game-dep-b', $1, 'KES', 10000, 'failed')`,
      [p.id],
    );
    await db.pool.query(
      `INSERT INTO withdrawals (reference, player_id, currency, amount_minor, phone, provider, status)
       VALUES ('game-wd-a', $1, 'KES', 20000, '+254700000000', 'maplerad', 'processing')`,
      [p.id],
    );
    const all = await request(app).get('/api/account/transactions').set('Authorization', p.auth);
    expect(all.body.total).toBe(3);
    const byRef = Object.fromEntries(all.body.items.map((t: { reference: string; status: string }) => [t.reference, t.status]));
    expect(byRef).toEqual({ 'game-dep-a': 'success', 'game-dep-b': 'failed', 'game-wd-a': 'pending' });
    expect(all.body.items[0].displayId).toMatch(/^SIM\d{7}$/);

    const wd = await request(app).get('/api/account/transactions?type=withdrawal').set('Authorization', p.auth);
    expect(wd.body.items.map((t: { type: string }) => t.type)).toEqual(['withdrawal']);
  });
});
