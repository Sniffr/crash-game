// Player JWTs are signed/verified with this secret (read at request time).
// Save the prior value and restore it in afterAll so we don't poison other
// test files that share this worker's process.env (they run sequentially).
const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import { providerRejected, type CollectInput, type PayInProvider } from '../payments/types.js';
import { signPlayerJwt } from './lobby.js';
import { createLobbyDepositRouter } from './lobby-deposit.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let app: express.Application;
let deposits: PgDepositsRepo;
let calls: Array<{ provider: string; input: CollectInput }>;
/** Per-provider failure injection: undefined = succeed. */
let failWith: Record<string, Error | undefined>;

/** Stub processor: KES + ZMW capable, records every collect it is handed. */
function stubProvider(name: string, redirectUrl?: string): PayInProvider {
  return {
    name,
    supports: (currency: string) => currency === 'KES' || currency === 'ZMW',
    collect: async (input: CollectInput) => {
      calls.push({ provider: name, input });
      const err = failWith[name];
      if (err) throw err;
      return redirectUrl ? { redirectUrl } : {};
    },
    verifyWebhookSignature: () => true,
    parseEvent: () => ({ reference: '', outcome: 'ignore' as const, txnKey: '' }),
    verifyTransaction: async () => ({ status: 'success', reference: '' }),
  };
}

beforeAll(async () => {
  db = await makeTestDb();
  const players = new PlayersRepo(db.pool);
  deposits = new PgDepositsRepo(db.pool);
  app = express();
  app.use(express.json());
  const providers = [stubProvider('maplerad'), stubProvider('fincra', 'https://checkout.fincra.com/pay/fcr-p-1')];
  app.use('/api/lobby', createLobbyDepositRouter({ players, deposits, providers }));
});

beforeEach(() => {
  calls = [];
  failWith = {};
});

afterAll(async () => {
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

async function depositAs(opts: { currency: string; phone?: string; email?: string }, amountMinor = 5000) {
  const players = new PlayersRepo(db.pool);
  const player = await players.create(`t_${randomUUID()}`, 'hash', {
    currency: opts.currency,
    ...(opts.phone ? { phone: opts.phone } : {}),
    ...(opts.email ? { email: opts.email } : {}),
  });
  const token = await signPlayerJwt(player.playerId);
  const res = await request(app).post('/api/lobby/deposit').set('Authorization', `Bearer ${token}`).send({ amountMinor });
  return { player, res };
}

describe('lobby-deposit router', () => {
  it('collects on the first processor and records a pending deposit', async () => {
    const phone = '254700000000';
    const { player, res } = await depositAs({ currency: 'KES', phone });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.provider).toBe('maplerad');
    expect(res.body.reference.startsWith('game-dep-')).toBe(true);

    expect(await deposits.get(res.body.reference)).toEqual({
      playerId: player.playerId,
      currency: 'KES',
      amountMinor: 5000,
      status: 'pending',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'maplerad', input: { currency: 'KES', amountMinor: 5000, phone, reference: res.body.reference } });
  });

  it('fails over to the next processor when the first REJECTS the charge', async () => {
    failWith = { maplerad: providerRejected('down for maintenance') };
    const { res } = await depositAs({ currency: 'KES', phone: '254700000002' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('fincra');
    expect(calls.map((c) => c.provider)).toEqual(['maplerad', 'fincra']);
    // Both attempts share one reference, so at most one deposit can ever settle.
    expect(new Set(calls.map((c) => c.input.reference)).size).toBe(1);
    // A redirect-collecting processor surfaces its hosted page to the client.
    expect(res.body.redirectUrl).toBe('https://checkout.fincra.com/pay/fcr-p-1');
    expect(res.body.message).toMatch(/Complete your payment/);
  });

  it('omits redirectUrl for a phone-prompt processor', async () => {
    const { res } = await depositAs({ currency: 'KES', phone: '254700000005' });
    expect(res.body.provider).toBe('maplerad');
    expect(res.body.redirectUrl).toBeUndefined();
    expect(res.body.message).toMatch(/Check your phone/);
  });

  it('does NOT fail over on a network error — the charge may already exist', async () => {
    failWith = { maplerad: new Error('ETIMEDOUT') };
    const { res } = await depositAs({ currency: 'KES', phone: '254700000003' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('DEPOSIT_FAILED');
    expect(calls.map((c) => c.provider)).toEqual(['maplerad']);
  });

  it('marks the deposit failed when every processor rejects', async () => {
    failWith = { maplerad: providerRejected('no'), fincra: providerRejected('no') };
    const { res } = await depositAs({ currency: 'KES', phone: '254700000004' });

    expect(res.status).toBe(502);
    expect(calls.map((c) => c.provider)).toEqual(['maplerad', 'fincra']);
  });

  it('rejects a non-positive amountMinor (400 INVALID_AMOUNT)', async () => {
    const { res } = await depositAs({ currency: 'KES', phone: '254700000001' }, -1);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  it('rejects deposits for a currency no processor can collect (400 DEPOSIT_UNAVAILABLE)', async () => {
    const { res } = await depositAs({ currency: 'ZAR', email: 'p@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPOSIT_UNAVAILABLE');
  });

  it('M1: rejects a phone-rail deposit when the player has no phone on file (400 CONTACT_MISSING)', async () => {
    // The router must not call a processor with phone: null — reject first.
    const { res } = await depositAs({ currency: 'KES' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONTACT_MISSING');
    expect(calls).toHaveLength(0);
  });

  it('rejects a request without a player JWT (401)', async () => {
    const res = await request(app).post('/api/lobby/deposit').send({ amountMinor: 5000 });
    expect(res.status).toBe(401);
  });
});
