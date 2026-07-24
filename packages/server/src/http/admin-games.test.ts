import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { OperatorRegistry, GamesRepo, BetLog } from '@crash/wallet';
import * as bcrypt from 'bcryptjs';

import { AdminAudit, AdminUsers } from '../admin/admin-store.js';
import { createAdminRouter } from './admin.js';
import { WalletClientCache } from '../wallet/client-cache.js';

const TEST_SECRET = 'test-jwt-secret-admin-games';

interface Harness {
  app: express.Application;
  games: GamesRepo;
  registry: OperatorRegistry;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  const betLog = new BetLog(db);
  const registry = new OperatorRegistry(db);
  const games = new GamesRepo(db);
  const adminUsers = new AdminUsers(db);
  const adminAudit = new AdminAudit(db);
  const walletClientCache = new WalletClientCache(registry, betLog);

  adminUsers.create('alice', bcrypt.hashSync('secret', 10), ['admin']);

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
afterEach(() => { delete process.env['JWT_SECRET']; });

describe('POST /admin/v1/games', () => {
  it('creates a game; rtp echoed as percentage; 201', async () => {
    const { app } = makeHarness();
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
    const { app } = makeHarness();
    const res = await request(app).post('/admin/v1/games').send({ gameId: 'x', name: 'x', gameType: 'sprite', rtp: 97 });
    expect(res.status).toBe(401);
  });

  it('409 on duplicate gameId', async () => {
    const { app } = makeHarness();
    const jwt = await token(app);
    const body = { gameId: 'dup', name: 'Dup', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } };
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`).send(body);
    const res = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_GAME_ID');
  });

  it('400 when rtp is a fraction/out of (0,100] percentage', async () => {
    const { app } = makeHarness();
    const jwt = await token(app);
    const tooBig = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'x', name: 'x', gameType: 'sprite', rtp: 150, theme: { gameType: 'sprite' } });
    expect(tooBig.status).toBe(400);
    const zero = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'y', name: 'y', gameType: 'sprite', rtp: 0, theme: { gameType: 'sprite' } });
    expect(zero.status).toBe(400);
  });

  it('400 when gameType disagrees with theme', async () => {
    const { app } = makeHarness();
    const jwt = await token(app);
    const res = await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'x', name: 'x', gameType: 'gif', rtp: 97, theme: { gameType: 'sprite' } });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/v1/games/:gameId', () => {
  it('updates rtp; 404 for unknown', async () => {
    const { app } = makeHarness();
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
    const { app } = makeHarness();
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

describe('PATCH /admin/v1/operators/:id/games/:gameId', () => {
  it('persists enabled + rtpVariant into operator_games', async () => {
    const { app, registry, games } = makeHarness();
    const jwt = await token(app);
    registry.create({ operatorId: 'acme', name: 'Acme', walletBaseUrl: 'http://x', currencies: ['EUR'], status: 'active' });
    await request(app).post('/admin/v1/games').set('Authorization', `Bearer ${jwt}`)
      .send({ gameId: 'g', name: 'G', gameType: 'sprite', rtp: 97, theme: { gameType: 'sprite' } });

    const res = await request(app).patch('/admin/v1/operators/acme/games/g')
      .set('Authorization', `Bearer ${jwt}`).send({ enabled: true, rtpVariant: 95 });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.rtpVariant).toBe(95);
    // Stored as fraction; effectiveRtp reflects the override.
    expect(games.effectiveRtp('acme', 'g')).toBeCloseTo(0.95);
  });

  it('404 for unknown operator or game', async () => {
    const { app, registry } = makeHarness();
    const jwt = await token(app);
    registry.create({ operatorId: 'acme', name: 'Acme', walletBaseUrl: 'http://x', currencies: ['EUR'], status: 'active' });
    const noGame = await request(app).patch('/admin/v1/operators/acme/games/ghost').set('Authorization', `Bearer ${jwt}`).send({ enabled: true });
    expect(noGame.status).toBe(404);
    expect(noGame.body.error.code).toBe('GAME_NOT_FOUND');
    const noOp = await request(app).patch('/admin/v1/operators/ghost/games/x').set('Authorization', `Bearer ${jwt}`).send({ enabled: true });
    expect(noOp.status).toBe(404);
    expect(noOp.body.error.code).toBe('OPERATOR_NOT_FOUND');
  });
});
