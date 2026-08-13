// Player JWTs are signed/verified with this secret (read at request time).
// Save the prior value and restore it in afterAll so we don't poison other
// test files that share this worker's process.env (they run sequentially).
const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { createLobbyRouter } from './lobby.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let app: express.Application;

beforeAll(async () => {
  db = await makeTestDb();
  const players = new PlayersRepo(db.pool);
  const wallet = new WalletLedger(db.pool);
  app = express();
  app.use(express.json());
  app.use('/api/lobby', createLobbyRouter({ players, wallet }));
});

// Retained so existing `.push(...)` calls stay harmless; the schema drop cleans up.
const createdUsernames: string[] = [];

afterAll(async () => {
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

describe('lobby router', () => {
  it('register → login → me', async () => {
    const username = `t_${randomUUID()}`;
    const password = 'p@ssw0rd';
    createdUsernames.push(username);

    // Register
    const reg = await request(app)
      .post('/api/lobby/register')
      .send({ username, password, currency: 'KES', phone: '254700000000' });
    expect(reg.status).toBe(201);
    expect(reg.body.balanceMinor).toBe(0);
    expect(reg.body.player.username).toBe(username);
    expect(typeof reg.body.token).toBe('string');

    // Login
    const login = await request(app).post('/api/lobby/login').send({ username, password });
    expect(login.status).toBe(200);
    expect(login.body.balanceMinor).toBe(0);
    const token = login.body.token as string;
    expect(typeof token).toBe('string');

    // /me shows balance 0
    const me0 = await request(app).get('/api/lobby/me').set('Authorization', `Bearer ${token}`);
    expect(me0.status).toBe(200);
    expect(me0.body.username).toBe(username);
    expect(me0.body.balanceMinor).toBe(0);
  });

  it('rejects /me without a token (401)', async () => {
    const res = await request(app).get('/api/lobby/me');
    expect(res.status).toBe(401);
  });

  it('rejects a bad login with 401 (no user enumeration)', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);
    await request(app)
      .post('/api/lobby/register')
      .send({ username, password: 'right-pass', currency: 'KES', phone: '254700000001' });

    const unknownUser = await request(app)
      .post('/api/lobby/login')
      .send({ username: `t_${randomUUID()}`, password: 'whatever' });
    const badPass = await request(app)
      .post('/api/lobby/login')
      .send({ username, password: 'wrong-pass' });

    expect(unknownUser.status).toBe(401);
    expect(badPass.status).toBe(401);
    // Identical message — no enumeration.
    expect(unknownUser.body.error.message).toBe(badPass.body.error.message);
  });

  it('returns 409 on a duplicate register', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);

    const first = await request(app)
      .post('/api/lobby/register')
      .send({ username, password: 'pw', currency: 'KES', phone: '254700000002' });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post('/api/lobby/register')
      .send({ username, password: 'pw2', currency: 'KES', phone: '254700000002' });
    expect(dup.status).toBe(409);
  });

  it('registers with currency + phone (momo)', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);
    const res = await request(app)
      .post('/api/lobby/register')
      .send({ username, password: 'pw12345', currency: 'KES', phone: '254700000000' });
    expect(res.status).toBe(201);
  });

  it('rejects an unsupported currency', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);
    const res = await request(app)
      .post('/api/lobby/register')
      .send({ username, password: 'pw12345', currency: 'EUR', phone: '1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  it('I2: a non-KES (ZAR) player gets their balance read + currency echoed in login/me, not hardcoded KES', async () => {
    const username = `t_${randomUUID()}`;
    const password = 'p@ssw0rd';
    createdUsernames.push(username);

    const reg = await request(app)
      .post('/api/lobby/register')
      .send({ username, password, currency: 'ZAR', email: 'zar-player@example.com' });
    expect(reg.status).toBe(201);

    const login = await request(app).post('/api/lobby/login').send({ username, password });
    expect(login.status).toBe(200);
    expect(login.body.currency).toBe('ZAR');
    expect(login.body.balanceMinor).toBe(0);
    const token = login.body.token as string;

    const me = await request(app).get('/api/lobby/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.currency).toBe('ZAR');
    expect(me.body.balanceMinor).toBe(0);
  });

  it('rejects a momo currency with no phone', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);
    const res = await request(app)
      .post('/api/lobby/register')
      .send({ username, password: 'pw12345', currency: 'KES' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONTACT_REQUIRED');
  });
});
