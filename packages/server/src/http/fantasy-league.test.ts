// Player JWTs are signed/verified with this secret (read at request time).
// Restored in afterAll — test files in this worker share process.env.
const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { PgFantasyLeagueRepo } from '@crash/wallet/fantasy-league-repo-pg';
import type { LeagueTemplate } from '@crash/wallet/fantasy-league-repo';
import type { LivePlayerPoints, Position, SquadPick } from '@crash/shared/fantasy';
import type { CatalogPlayer, FantasyCatalog, FantasyProvider, FplEntry } from '../fantasy/provider.js';
import { runFantasyTick } from '../fantasy/scheduler.js';
import { signPlayerJwt } from './lobby.js';
import { createFantasyLeagueRouter } from './fantasy-league.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const DEADLINE = new Date(NOW + 24 * 3_600_000).toISOString();
const FEE = 5_000;
const TEMPLATES: LeagueTemplate[] = [{ templateId: 'test', name: 'Test League', blurb: '', entryFeeMinor: FEE, currency: 'KES' }];
const LEAGUE = 'test-gw6';

// 20 clubs × one of each position, so any 4-4-2 of ids 1..11 below is legal.
const POSITIONS: Position[] = ['GKP', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD'];
const PLAYERS: CatalogPlayer[] = [
  ...POSITIONS.map((position, i) => ({
    id: i + 1, name: `P${i + 1}`, teamId: i + 1, position, cost: 60, status: 'a', news: '', canSelect: true,
  })),
  { id: 99, name: 'Gone', teamId: 12, position: 'MID', cost: 50, status: 'u', news: 'Left the club', canSelect: false },
];

const XI = (captainId = 10): SquadPick => ({
  playerIds: POSITIONS.map((_, i) => i + 1),
  captainId,
  viceCaptainId: captainId === 11 ? 10 : 11,
});

class FakeProvider implements FantasyProvider {
  finished = false;
  live = new Map<number, LivePlayerPoints>();
  async catalog(): Promise<FantasyCatalog> {
    return {
      players: PLAYERS,
      teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Club ${i + 1}`, shortName: `C${i + 1}` })),
      gameweeks: [
        { id: 5, name: 'Gameweek 5', deadline: new Date(NOW - 7 * 86_400_000).toISOString(), finished: true, dataChecked: true, isCurrent: true, isNext: false },
        { id: 6, name: 'Gameweek 6', deadline: DEADLINE, finished: this.finished, dataChecked: this.finished, isCurrent: false, isNext: true },
      ],
    };
  }
  async livePoints(): Promise<Map<number, LivePlayerPoints>> { return this.live; }
  async entry(entryId: number): Promise<FplEntry | null> {
    return entryId === 42 ? { entryId: 42, teamName: 'The Answer FC', managerName: 'Deep Thought', currentGameweek: 5 } : null;
  }
  async entryXi(entryId: number, gameweek: number): Promise<SquadPick | null> {
    return entryId === 42 && gameweek === 5 ? XI(9) : null;
  }
}

let db: TestDb;
let app: express.Application;
let players: PlayersRepo;
let wallet: WalletLedger;
let leagues: PgFantasyLeagueRepo;
let provider: FakeProvider;
let clock = NOW;

beforeAll(async () => {
  db = await makeTestDb();
  players = new PlayersRepo(db.pool);
  wallet = new WalletLedger(db.pool);
  leagues = new PgFantasyLeagueRepo(db.pool, wallet);
  provider = new FakeProvider();
  await runFantasyTick(leagues, provider, TEMPLATES, NOW);

  app = express();
  app.use(express.json());
  app.use('/api/fantasy-league', createFantasyLeagueRouter({ leagues, players, provider, now: () => clock }));
});

afterAll(async () => {
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

async function player(username: string, opts: { fundMinor?: number; currency?: string } = {}) {
  const p = await players.create(username, 'hash', { currency: opts.currency ?? 'KES' });
  const fund = opts.fundMinor ?? 100_000;
  if (fund > 0) await wallet.deposit(p.playerId, fund, opts.currency ?? 'KES', `fund-${username}`);
  return { playerId: p.playerId, auth: `Bearer ${await signPlayerJwt(p.playerId)}` };
}

const join = (auth: string, body: unknown) =>
  request(app).post(`/api/fantasy-league/leagues/${LEAGUE}/join`).set('Authorization', auth).send(body);

describe('catalog + leagues', () => {
  it('serves the upcoming gameweek and only selectable players', async () => {
    const res = await request(app).get('/api/fantasy-league/catalog');
    expect(res.status).toBe(200);
    expect(res.body.gameweek).toMatchObject({ id: 6, deadline: DEADLINE });
    expect(res.body.players.map((p: { id: number }) => p.id)).not.toContain(99);
  });

  it('the scheduler opened a league for the upcoming gameweek', async () => {
    const res = await request(app).get('/api/fantasy-league/leagues');
    expect(res.body.items).toEqual([expect.objectContaining({ leagueId: LEAGUE, gameweek: 6, phase: 'open' })]);
  });
});

describe('POST /leagues/:id/join', () => {
  it('requires a player token', async () => {
    expect((await request(app).post(`/api/fantasy-league/leagues/${LEAGUE}/join`).send(XI())).status).toBe(401);
  });

  it('rejects a squad that breaks the rules, listing every issue', async () => {
    const { auth } = await player('rulebreaker');
    const res = await join(auth, { ...XI(), playerIds: [...XI().playerIds.slice(0, 10), 99] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SQUAD');
    expect(res.body.error.issues.join(' ')).toContain('no longer available');
  });

  it('rejects a player whose account currency differs from the league', async () => {
    const { auth } = await player('ugandan', { currency: 'UGX' });
    const res = await join(auth, XI());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('returns 402 without taking money when the balance is too low', async () => {
    const { auth, playerId } = await player('broke', { fundMinor: 0 });
    expect((await join(auth, XI())).status).toBe(402);
    expect(await leagues.getEntry(LEAGUE, playerId)).toBeNull();
  });

  it('joins, debits once, and refuses a second entry', async () => {
    const { auth, playerId } = await player('joiner');
    const res = await join(auth, XI());
    expect(res.status).toBe(201);
    expect(res.body.balanceMinor).toBe(100_000 - FEE);
    const again = await join(auth, XI());
    expect(again.status).toBe(409);
    expect(await wallet.balance(playerId)).toBe(100_000 - FEE);

    const me = await request(app).get(`/api/fantasy-league/leagues/${LEAGUE}/me`).set('Authorization', auth);
    expect(me.body.entry.squad).toEqual(XI());
    expect(me.body.entry.rank).toBeNull(); // no points before the deadline

    const mine = await request(app).get('/api/fantasy-league/my-leagues').set('Authorization', auth);
    expect(mine.body.leagueIds).toEqual([LEAGUE]);
  });
});

describe('FPL link', () => {
  it('links by Team ID, imports the latest XI, and unlinks', async () => {
    const { auth } = await player('fplfan');
    expect((await request(app).put('/api/fantasy-league/fpl-link').set('Authorization', auth).send({ entryId: 7 })).status).toBe(404);

    const link = await request(app).put('/api/fantasy-league/fpl-link').set('Authorization', auth).send({ entryId: 42 });
    expect(link.body.link).toMatchObject({ entryId: 42, teamName: 'The Answer FC' });

    const xi = await request(app).get('/api/fantasy-league/fpl-link/xi').set('Authorization', auth);
    expect(xi.body).toMatchObject({ gameweek: 5, captainId: 9, playerIds: XI().playerIds });

    await request(app).delete('/api/fantasy-league/fpl-link').set('Authorization', auth);
    expect((await request(app).get('/api/fantasy-league/fpl-link').set('Authorization', auth)).body.link).toBeNull();
  });
});

describe('live table → settlement', () => {
  it('ranks live after the deadline, then the scheduler settles and pays out once', async () => {
    const second = await player('second');
    expect((await join(second.auth, XI(11))).status).toBe(201);
    expect((await leagues.entries(LEAGUE)).length).toBe(2);

    // After the deadline: joins close, table is live.
    clock = Date.parse(DEADLINE) + 60_000;
    provider.live = new Map([[10, { points: 12, minutes: 90 }], [11, { points: 2, minutes: 90 }]]);
    expect((await join((await player('late')).auth, XI())).body.error.code).toBe('LEAGUE_LOCKED');

    const live = await request(app).get(`/api/fantasy-league/leagues/${LEAGUE}`);
    expect(live.body.league.phase).toBe('live');
    expect(live.body.standings.map((s: { username: string; rank: number; points: number }) => [s.username, s.rank, s.points]))
      .toEqual([['joiner', 1, 26], ['second', 2, 16]]);

    // FPL marks the gameweek final → the scheduler settles it.
    provider.finished = true;
    await runFantasyTick(leagues, provider, TEMPLATES, clock);
    await runFantasyTick(leagues, provider, TEMPLATES, clock);

    const final = await request(app).get(`/api/fantasy-league/leagues/${LEAGUE}`);
    expect(final.body.league).toMatchObject({ phase: 'settled', poolMinor: 2 * FEE, rakeMinor: 1_000 });
    // 2 entrants → places 1–2 paid 50:30 of the 9,000 prize pool, pro rata.
    expect(final.body.standings.map((s: { payoutMinor: number }) => s.payoutMinor)).toEqual([5_625, 3_375]);
    const joinerId = (await leagues.entries(LEAGUE)).find((e) => e.username === 'joiner')!.playerId;
    expect(await wallet.balance(joinerId)).toBe(100_000 - FEE + 5_625);
  });
});
