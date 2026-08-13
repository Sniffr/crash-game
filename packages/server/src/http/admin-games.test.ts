import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PgOperatorRegistry, PgGamesRepo, PgBetLog } from '@crash/wallet';
import * as bcrypt from 'bcryptjs';

import { PgAdminAudit, PgAdminUsers } from '../admin/admin-store-pg.js';
import { createAdminRouter } from './admin.js';
import { WalletClientCache } from '../wallet/client-cache.js';

const TEST_SECRET = 'test-jwt-secret-admin-games';

interface Harness {
  app: express.Application;
  games: PgGamesRepo;
  registry: PgOperatorRegistry;
}

let currentDb: TestDb | undefined;

async function makeHarness(): Promise<Harness> {
  const testDb = await makeTestDb();
  currentDb = testDb;
  const pool = testDb.pool;
  const betLog = new PgBetLog(pool);
  const registry = new PgOperatorRegistry(pool);
  const games = new PgGamesRepo(pool);
  const adminUsers = new PgAdminUsers(pool);
  const adminAudit = new PgAdminAudit(pool);
  const walletClientCache = new WalletClientCache(registry, betLog);

  await adminUsers.create('alice', bcrypt.hashSync('secret', 10), ['admin']);

  const app = express();
  app.use(express.json());
  app.use('/admin/v1', createAdminRouter({
    walletClientCache, betLog, adminAudit, adminUsers, registry, games,
    revoked: new Set<string>(),
    reconciler: {} as never,
  }));
  return { app, games, registry };
}

async function token(app: express.Application): Promise<string> {
  const res = await request(app).post('/admin/v1/auth/login').send({ username: 'alice', password: 'secret' });
  return res.body.token as string;
}

beforeEach(() => { process.env['JWT_SECRET'] = TEST_SECRET; });
afterEach(async () => {
  delete process.env['JWT_SECRET'];
  if (currentDb) { await currentDb.cleanup(); currentDb = undefined; }
});

describe('POST /admin/v1/games', () => {
  it('creates a game; rtp echoed as percentage; 201', async () => {
    const { app } = await makeHarness();
    const jwt = await token(app);
    const res = await request(app)
      .post('/admin/v1/games')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'cosmic-jet', name: 'Cosmic Jet', gameType: 'gif', rtp: 95, theme: { gameType: 'gif' } });
    expect(res.status).toBe(201);
    expect(res.body.gameId).toBe('cosmic-jet');
    expect(res.body.rtp).toBe(95);
    expect(res.body.gameType).toBe('gif');
  });

  it('401 without JWT', async () => {
    const { app } = await makeHarness();
    const res = await request(app).post('/admin/v1/games').send({ gameId: 'x', name: 'x', gameType: 'sprite', rtp: 97 });
    expect(res.status).toBe(401);
  });

  it('409 on duplicate gameId', async () => {
    const { app } = await makeHarness();
    const jwt = await token(app);
    const body = { gameId: 'dup', name: 'Dup', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } };
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`).send(body);
    const res = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_GAME_ID');
  });

  it('400 when rtp is a fraction/out of (0,100] percentage', async () => {
    const { app } = await makeHarness();
    const jwt = await token(app);
    const tooBig = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'x', name: 'x', gameType: 'sprite', rtp: 150, theme: { gameType: 'sprite' } });
    expect(tooBig.status).toBe(400);
    const zero = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'y', name: 'y', gameType: 'sprite', rtp: 0, theme: { gameType: 'sprite' } });
    expect(zero.status).toBe(400);
  });

  it('400 when gameType disagrees with theme', async () => {
    const { app } = await makeHarness();
    const jwt = await token(app);
    const res = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'x', name: 'x', gameType: 'gif', rtp: 97, theme: { gameType: 'sprite' } });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/v1/games/:gameId', () => {
  it('updates rtp; 404 for unknown', async () => {
    const { app } = await makeHarness();
    const jwt = await token(app);
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'g', name: 'G', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } });
    const ok = await request(app).patch('/admin/v1/games/g').set('Authorization', `Bearer ${jwt}`).send({ rtp: 90 });
    expect(ok.status).toBe(200);
    expect(ok.body.rtp).toBe(90);
    const nf = await request(app).patch('/admin/v1/games/nope').set('Authorization', `Bearer ${jwt}`).send({ rtp: 90 });
    expect(nf.status).toBe(404);
  });
});

describe('GET /admin/v1/games', () => {
  it('lists active; hides archived unless includeArchived=1', async () => {
    const { app } = await makeHarness();
    const jwt = await token(app);
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'g1', name: 'G1', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } });
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'g2', name: 'G2', gameType: 'gif', rtp: 96, theme: { gameType: 'gif' } });
    await request(app).patch('/admin/v1/games/g2').set('Authorization', `Bearer ${jwt}`).send({ status: 'archived' });

    const active = await request(app).get('/admin/v1/games').set('Authorization', `Bearer ${jwt}`);
    expect(active.body.items.map((g: { gameId: string }) => g.gameId)).toEqual(['g1']);
    const all = await request(app).get('/admin/v1/games?includeArchived=1').set('Authorization', `Bearer ${jwt}`);
    expect(all.body.items.length).toBe(2);
  });
});

describe('DELETE /admin/v1/games/:gameId — permanent', () => {
  it('drops the row for good, cascades operator_games, and refuses the base game', async () => {
    const { app, games, registry } = await makeHarness();
    const jwt = await token(app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${jwt}`);

    await auth(request(app).post('/admin/v1/games'))
      .send({ gameId: 'doomed', name: 'Doomed', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } });

    // Wire it to an operator so we can prove the cascade fires.
    const { operator } = await registry.create({
      operatorId: 'op-del', name: 'Op', walletBaseUrl: 'https://w.example', adapter: 'generic-rest',
      currencies: ['EUR'], minBetMinor: 100, maxBetMinor: 100000, rtpVariant: 0.97, jurisdictions: ['MT'],
    });
    await games.setOperatorGame(operator.operatorId, 'doomed', { enabled: true });
    expect(await games.getOperatorGame(operator.operatorId, 'doomed')).not.toBeNull();

    const del = await auth(request(app).delete('/admin/v1/games/doomed'));
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ ok: true, gameId: 'doomed', betCount: 0 });

    // Gone for real — not merely archived, so includeArchived can't see it either.
    expect(await games.getById('doomed')).toBeNull();
    const all = await auth(request(app).get('/admin/v1/games?includeArchived=1'));
    expect(all.body.items.map((g: { gameId: string }) => g.gameId)).not.toContain('doomed');
    expect(await games.getOperatorGame(operator.operatorId, 'doomed')).toBeNull();

    // Second delete is a 404, and the base game is protected.
    expect((await auth(request(app).delete('/admin/v1/games/doomed'))).status).toBe(404);
    const base = await auth(request(app).delete('/admin/v1/games/galaxy-crash'));
    expect(base.status).toBe(409);
    expect(base.body.error.code).toBe('GAME_NOT_DELETABLE');
  });
});

describe('PATCH /admin/v1/operators/:id/games/:gameId', () => {
  it('persists enabled + rtpVariant into operator_games', async () => {
    const { app, registry, games } = await makeHarness();
    const jwt = await token(app);
    await registry.create({ operatorId: 'acme', name: 'Acme', walletBaseUrl: 'http://x', currencies: ['EUR'], status: 'active' });
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'g', name: 'G', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } });

    const res = await request(app).patch('/admin/v1/operators/acme/games/g')
      .set('Authorization', `Bearer ${jwt}`).send({ enabled: true, rtpVariant: 95 });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.rtpVariant).toBe(95);
    // Stored as fraction; effectiveRtp reflects the override.
    expect(await games.effectiveRtp('acme', 'g')).toBeCloseTo(0.95);
  });

  it('404 for unknown operator or game', async () => {
    const { app, registry } = await makeHarness();
    const jwt = await token(app);
    await registry.create({ operatorId: 'acme', name: 'Acme', walletBaseUrl: 'http://x', currencies: ['EUR'], status: 'active' });
    const noGame = await request(app).patch('/admin/v1/operators/acme/games/ghost').set('Authorization', `Bearer ${jwt}`).send({ enabled: true });
    expect(noGame.status).toBe(404);
    expect(noGame.body.error.code).toBe('GAME_NOT_FOUND');
    const noOp = await request(app).patch('/admin/v1/operators/ghost/games/x').set('Authorization', `Bearer ${jwt}`).send({ enabled: true });
    expect(noOp.status).toBe(404);
    expect(noOp.body.error.code).toBe('OPERATOR_NOT_FOUND');
  });
});
