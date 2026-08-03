import { config } from 'dotenv';
config({ path: '../../.env' });

// Player JWTs are signed/verified with this secret (read at request time).
// Save the prior value and restore it in afterAll so we don't poison other
// test files that share this worker's process.env (they run sequentially).
const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getPool } from '@crash/wallet/pg';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { createLobbyRouter } from './lobby.js';

const pool = getPool();
const players = new PlayersRepo(pool);
const wallet = new WalletLedger(pool);

const app = express();
app.use(express.json());
app.use('/api/lobby', createLobbyRouter({ players, wallet }));

const createdUsernames: string[] = [];

afterAll(async () => {
  for (const username of createdUsernames) {
    const { rows } = await pool.query<{ player_id: string }>(
      'SELECT player_id FROM players WHERE username = $1',
      [username],
    );
    const id = rows[0]?.player_id;
    if (id) {
      await pool.query('DELETE FROM wallet_ledger WHERE player_id = $1', [id]);
      await pool.query('DELETE FROM players WHERE player_id = $1', [id]);
    }
  }
  await pool.end();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

describe('lobby router', () => {
  it('register → login → me → deposit → me', async () => {
    const username = `t_${randomUUID()}`;
    const password = 'p@ssw0rd';
    createdUsernames.push(username);

    // Register
    const reg = await request(app).post('/api/lobby/register').send({ username, password });
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

    // Deposit 5000
    const dep = await request(app)
      .post('/api/lobby/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });
    expect(dep.status).toBe(200);
    expect(dep.body.balanceMinor).toBe(5000);

    // /me shows 5000
    const me1 = await request(app).get('/api/lobby/me').set('Authorization', `Bearer ${token}`);
    expect(me1.status).toBe(200);
    expect(me1.body.balanceMinor).toBe(5000);
  });

  it('rejects /me without a token (401)', async () => {
    const res = await request(app).get('/api/lobby/me');
    expect(res.status).toBe(401);
  });

  it('rejects a bad login with 401 (no user enumeration)', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);
    await request(app).post('/api/lobby/register').send({ username, password: 'right-pass' });

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

    const first = await request(app).post('/api/lobby/register').send({ username, password: 'pw' });
    expect(first.status).toBe(201);

    const dup = await request(app).post('/api/lobby/register').send({ username, password: 'pw2' });
    expect(dup.status).toBe(409);
  });

  it('rejects deposit of a non-positive amount (400)', async () => {
    const username = `t_${randomUUID()}`;
    createdUsernames.push(username);
    const reg = await request(app).post('/api/lobby/register').send({ username, password: 'pw' });
    const token = reg.body.token as string;

    const res = await request(app)
      .post('/api/lobby/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: -1 });
    expect(res.status).toBe(400);
  });
});
