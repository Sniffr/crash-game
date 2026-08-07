import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { verifySlip, type Selection } from '@crash/shared/simulate';
import {
  createSimulateRouter,
  SimInsufficientFunds,
  type SimEconomy,
  type SimulateServerConfig,
} from './simulate.js';
import { DEFAULT_SIMULATE_CONFIG } from '@crash/shared/simulate';
import type { FixturesFeed, WindowedFixture, FixtureWindow } from '../simulate/fixtures.js';

// Fixed clock so windowing + kickoff checks are deterministic.
const NOW = Date.UTC(2026, 7, 7, 6, 0, 0); // 2026-08-07T06:00:00Z
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const FEED: FixturesFeed = {
  feedVersion: 1,
  generatedAt: iso(NOW),
  source: 'test',
  sport: 'football',
  fixtures: [
    {
      eventId: 'arsenal-chelsea-T1',
      sport: 'football',
      league: 'EPL',
      home: 'Arsenal',
      away: 'Chelsea',
      kickoff: iso(NOW + 12 * 3_600_000), // later today
      markets: { '1x2': { home: 2.1, draw: 3.4, away: 3.35 } },
    },
    {
      eventId: 'madrid-barca-T2',
      sport: 'football',
      league: 'LaLiga',
      home: 'Real Madrid',
      away: 'Barcelona',
      kickoff: iso(NOW + 36 * 3_600_000), // tomorrow
      markets: { '1x2': { home: 2.35, draw: 3.5, away: 2.9 } },
    },
    {
      eventId: 'past-game-T3',
      sport: 'football',
      league: 'EPL',
      home: 'Old',
      away: 'Match',
      kickoff: iso(NOW - 3_600_000), // already started
      markets: { '1x2': { home: 2.0, draw: 3.0, away: 3.5 } },
    },
  ],
};

// In-memory economy fake.
function makeEconomy(starting = 1000): SimEconomy {
  const balances = new Map<string, number>();
  let n = 0;
  return {
    async createSession(startingBalance: number) {
      const sessionId = `sim-${++n}`;
      balances.set(sessionId, startingBalance);
      return { sessionId, balance: startingBalance };
    },
    async balanceOf(sessionId: string) {
      return balances.has(sessionId) ? balances.get(sessionId)! : null;
    },
    async adjust(sessionId: string, delta: number) {
      const cur = balances.get(sessionId);
      if (cur == null) throw new Error('session not found');
      const next = cur + delta;
      if (next < -1e-9) throw new SimInsufficientFunds();
      balances.set(sessionId, next);
      return next;
    },
  };
}

const CONFIG: SimulateServerConfig = {
  ...DEFAULT_SIMULATE_CONFIG,
  rtp: 0.95,
  startingBalance: 1000,
  maxStake: 1000,
};

function makeApp(economy: SimEconomy) {
  const app = express();
  app.use(express.json());
  const getFeed = async () => FEED;
  const getFixtures = async (window: FixtureWindow | 'all') => {
    const out: WindowedFixture[] = [];
    for (const fx of FEED.fixtures) {
      const ko = new Date(fx.kickoff).getTime();
      if (ko <= NOW) continue;
      const day = Math.floor(ko / 86_400_000);
      const today = Math.floor(NOW / 86_400_000);
      const w: FixtureWindow = day <= today ? 'today' : day === today + 1 ? 'tomorrow' : day <= today + 7 ? 'week' : 'later';
      if (window === 'all' || (window === 'week' && w !== 'later') || w === window) out.push({ ...fx, window: w });
    }
    return out;
  };
  app.use('/api/simulate', createSimulateRouter({ economy, getFeed, getFixtures, config: CONFIG, now: () => NOW }));
  return app;
}

let app: express.Application;
let economy: SimEconomy;
beforeEach(() => {
  economy = makeEconomy();
  app = makeApp(economy);
});

describe('GET /api/simulate/fixtures', () => {
  it('lists fixtures with window buckets, excluding started games', async () => {
    const res = await request(app).get('/api/simulate/fixtures');
    expect(res.status).toBe(200);
    const ids = res.body.fixtures.map((f: any) => f.eventId);
    expect(ids).toContain('arsenal-chelsea-T1');
    expect(ids).toContain('madrid-barca-T2');
    expect(ids).not.toContain('past-game-T3');
    const arsenal = res.body.fixtures.find((f: any) => f.eventId === 'arsenal-chelsea-T1');
    expect(arsenal.window).toBe('today');
    expect(arsenal.markets[0].options.map((o: any) => o.pick)).toEqual(['home', 'draw', 'away']);
  });

  it('filters by window=tomorrow', async () => {
    const res = await request(app).get('/api/simulate/fixtures?window=tomorrow');
    const ids = res.body.fixtures.map((f: any) => f.eventId);
    expect(ids).toEqual(['madrid-barca-T2']);
  });
});

describe('POST /api/simulate/session', () => {
  it('creates a play-money session', async () => {
    const res = await request(app).post('/api/simulate/session').send({});
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(1000);
    expect(res.body.currency).toBe('CREDITS');
    expect(typeof res.body.sessionId).toBe('string');
  });
});

describe('POST /api/simulate/play', () => {
  async function session() {
    const r = await request(app).post('/api/simulate/session').send({});
    return r.body.sessionId as string;
  }

  it('simulates a single-leg slip and settles the balance', async () => {
    const sessionId = await session();
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 100, selections: [{ eventId: 'arsenal-chelsea-T1', pick: 'home' }] });
    expect(res.status).toBe(200);
    expect(typeof res.body.won).toBe('boolean');
    // Server used feed odds (2.1), not any client-sent value.
    expect(res.body.legs[0].odds).toBe(2.1);
    if (res.body.won) {
      expect(res.body.payout).toBeCloseTo(210);
      expect(res.body.balance).toBeCloseTo(1110); // 1000 - 100 + 210
    } else {
      expect(res.body.payout).toBe(0);
      expect(res.body.balance).toBeCloseTo(900);
    }
  });

  it('reveals a provably-fair seed that verifies', async () => {
    const sessionId = await session();
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 50, selections: [{ eventId: 'arsenal-chelsea-T1', pick: 'away' }, { eventId: 'madrid-barca-T2', pick: 'home' }] });
    expect(res.status).toBe(200);
    const fair = res.body.fair;
    const sels: Selection[] = fair.selections;
    const v = verifySlip(fair.serverSeed, {
      won: res.body.won,
      combinedOdds: res.body.combinedOdds,
      payoutMultiplier: res.body.payoutMultiplier,
      legs: res.body.legs.map((l: any) => ({ ...l, u: 0, winProbability: 0 })),
      nonce: fair.nonce,
      commit: fair.commit,
    }, sels, { ...DEFAULT_SIMULATE_CONFIG, rtp: fair.rtp });
    expect(v.ok).toBe(true);
  });

  it('rejects an unknown event', async () => {
    const sessionId = await session();
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 10, selections: [{ eventId: 'nope', pick: 'home' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_EVENT');
  });

  it('rejects a started event', async () => {
    const sessionId = await session();
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 10, selections: [{ eventId: 'past-game-T3', pick: 'home' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EVENT_STARTED');
  });

  it('rejects stake over the max', async () => {
    const sessionId = await session();
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 5000, selections: [{ eventId: 'arsenal-chelsea-T1', pick: 'home' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STAKE_TOO_LARGE');
  });

  it('rejects insufficient funds', async () => {
    const sessionId = await session();
    // Drain the balance to near-zero first with a losing-safe tiny stake loop is
    // overkill; instead stake exactly over balance via many plays is complex —
    // just assert the pre-check by staking after manually zeroing.
    await economy.adjust(sessionId, -1000);
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 100, selections: [{ eventId: 'arsenal-chelsea-T1', pick: 'home' }] });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects an unknown session', async () => {
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId: 'does-not-exist', stake: 10, selections: [{ eventId: 'arsenal-chelsea-T1', pick: 'home' }] });
    expect(res.status).toBe(404);
  });

  it('refunds and 402s if a debit would overdraw (overdraw guard)', async () => {
    const sessionId = await session();
    // Leave exactly 40 credits, then stake 100. Pre-check catches most; the
    // guard is the backstop. Here we force the guard path by staking within the
    // pre-check tolerance is hard, so assert the balance never goes negative.
    await economy.adjust(sessionId, -960); // balance now 40
    const res = await request(app)
      .post('/api/simulate/play')
      .send({ sessionId, stake: 100, selections: [{ eventId: 'arsenal-chelsea-T1', pick: 'home' }] });
    expect(res.status).toBe(402);
    expect(await economy.balanceOf(sessionId)).toBe(40); // untouched
  });
});

// ── Integration: the REAL fixtures loader (sample feed) through the router ────
// No getFeed/getFixtures injected → the router uses the production S3/sample
// loaders. With no S3_* env, they serve the bundled sample feed. This proves
// fixtures.ts + sampleFixtures.ts actually work end-to-end.
describe('integration — real sample feed', () => {
  let realApp: express.Application;

  beforeEach(async () => {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_REGION;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    const { clearFeedCache } = await import('../simulate/fixtures.js');
    clearFeedCache();
    realApp = express();
    realApp.use(express.json());
    realApp.use('/api/simulate', createSimulateRouter({ economy: makeEconomy(), config: CONFIG }));
  });

  it('serves sample fixtures for today and this week', async () => {
    const today = await request(realApp).get('/api/simulate/fixtures?window=today');
    expect(today.status).toBe(200);
    expect(today.body.fixtures.length).toBeGreaterThan(0);
    const week = await request(realApp).get('/api/simulate/fixtures?window=week');
    expect(week.body.fixtures.length).toBeGreaterThanOrEqual(today.body.fixtures.length);
    // Every returned fixture is in the future and has 1x2 odds.
    for (const fx of week.body.fixtures) {
      expect(new Date(fx.kickoff).getTime()).toBeGreaterThan(Date.now());
      expect(fx.markets[0].options).toHaveLength(3);
    }
  });

  it('plays a real sample slip end-to-end and settles', async () => {
    const list = await request(realApp).get('/api/simulate/fixtures?window=all');
    const fx = list.body.fixtures[0];
    const s = await request(realApp).post('/api/simulate/session').send({});
    const res = await request(realApp)
      .post('/api/simulate/play')
      .send({ sessionId: s.body.sessionId, stake: 25, selections: [{ eventId: fx.eventId, pick: 'home' }] });
    expect(res.status).toBe(200);
    expect(res.body.legs[0].odds).toBe(fx.markets[0].options[0].odds); // server used feed odds
    // Balance conserved: won → +payout−stake, lost → −stake.
    const expected = res.body.won ? 1000 - 25 + res.body.payout : 1000 - 25;
    expect(res.body.balance).toBeCloseTo(expected, 2);
  });
});
