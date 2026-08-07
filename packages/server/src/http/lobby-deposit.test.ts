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
import { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import type { MapleradCollectInput } from '../maplerad/client.js';
import { signPlayerJwt } from './lobby.js';
import { createLobbyDepositRouter } from './lobby-deposit.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let app: express.Application;
let deposits: PgDepositsRepo;
let collectCalls: MapleradCollectInput[];

beforeAll(async () => {
  db = await makeTestDb();
  const players = new PlayersRepo(db.pool);
  const wallet = new WalletLedger(db.pool);
  deposits = new PgDepositsRepo(db.pool);
  collectCalls = [];
  const maplerad = {
    collect: async (input: MapleradCollectInput) => {
      collectCalls.push(input);
      return { status: 'pending' };
    },
  };
  app = express();
  app.use(express.json());
  app.use('/api/lobby', createLobbyDepositRouter({ players, deposits, maplerad, wallet }));
});

afterAll(async () => {
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

describe('lobby-deposit router', () => {
  it('starts a Maplerad collection and records a pending deposit', async () => {
    const players = new PlayersRepo(db.pool);
    const phone = '254700000000';
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES', phone });
    const token = await signPlayerJwt(player.playerId);

    const res = await request(app)
      .post('/api/lobby/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.reference).toBe('string');
    expect(res.body.reference.startsWith('gd-')).toBe(true);

    const dep = await deposits.get(res.body.reference);
    expect(dep).toEqual({ playerId: player.playerId, currency: 'KES', amountMinor: 5000, status: 'pending' });

    expect(collectCalls).toHaveLength(1);
    expect(collectCalls[0]).toMatchObject({
      currency: 'KES',
      amountMinor: 5000,
      phone,
      bankCode: '1291',
      reference: res.body.reference,
    });
  });

  it('rejects a non-positive amountMinor (400 INVALID_AMOUNT)', async () => {
    const players = new PlayersRepo(db.pool);
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES', phone: '254700000001' });
    const token = await signPlayerJwt(player.playerId);

    const res = await request(app)
      .post('/api/lobby/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  it('rejects deposits for a currency without a ready rail (400 DEPOSIT_UNAVAILABLE)', async () => {
    const players = new PlayersRepo(db.pool);
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'ZAR', email: 'p@example.com' });
    const token = await signPlayerJwt(player.playerId);

    const res = await request(app)
      .post('/api/lobby/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPOSIT_UNAVAILABLE');
  });

  it('M1: rejects a KES (phone-rail) deposit when the player has no phone on file (400 CONTACT_MISSING)', async () => {
    const players = new PlayersRepo(db.pool);
    // A KES player with no phone (e.g. cleared later) — the router must not
    // call Maplerad with phone: null; it should reject before ever collecting.
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES' });
    const token = await signPlayerJwt(player.playerId);

    const before = collectCalls.length;
    const res = await request(app)
      .post('/api/lobby/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONTACT_MISSING');
    expect(collectCalls.length).toBe(before);
  });

  it('rejects a request without a player JWT (401)', async () => {
    const res = await request(app).post('/api/lobby/deposit').send({ amountMinor: 5000 });
    expect(res.status).toBe(401);
  });
});
