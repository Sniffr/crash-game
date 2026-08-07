// Player JWTs are signed/verified with this secret (read at request time).
const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { PgWithdrawalsRepo } from '@crash/wallet/withdrawals-repo';
import { RAILS } from '@crash/wallet';
import type { MapleradDisburseInput } from '../maplerad/client.js';
import { signPlayerJwt } from './lobby.js';
import { createLobbyWithdrawRouter } from './lobby-withdraw.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let app: express.Application;
let wallet: WalletLedger;
let withdrawals: PgWithdrawalsRepo;
let disburseCalls: MapleradDisburseInput[];
let disburseShouldThrow = false;

// KES payout is gated in prod (no live institution code yet). Fill a placeholder
// so isPayoutable(KES) is true for these tests; restore afterwards.
const _prevKesPayoutCode = RAILS.KES!.payOut.institutionCode;

beforeAll(async () => {
  RAILS.KES!.payOut.institutionCode = 'MPESA_TEST';
  db = await makeTestDb();
  const players = new PlayersRepo(db.pool);
  wallet = new WalletLedger(db.pool);
  withdrawals = new PgWithdrawalsRepo(db.pool);
  disburseCalls = [];
  const maplerad = {
    disburse: async (input: MapleradDisburseInput) => {
      disburseCalls.push(input);
      if (disburseShouldThrow) throw new Error('provider down');
      return { id: 'tx-1', status: 'PENDING' };
    },
  };
  app = express();
  app.use(express.json());
  app.use('/api/lobby', createLobbyWithdrawRouter({ players, withdrawals, maplerad, wallet }));
});

afterAll(async () => {
  RAILS.KES!.payOut.institutionCode = _prevKesPayoutCode;
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

async function fundedPlayer(balanceMinor: number): Promise<{ playerId: string; token: string }> {
  const players = new PlayersRepo(db.pool);
  const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES', phone: '254700000000' });
  if (balanceMinor > 0) await wallet.deposit(player.playerId, balanceMinor, 'KES');
  return { playerId: player.playerId, token: await signPlayerJwt(player.playerId) };
}

describe('lobby-withdraw router', () => {
  it('reserves funds, disburses, and records a pending withdrawal', async () => {
    disburseShouldThrow = false;
    const { playerId, token } = await fundedPlayer(10_000);

    const res = await request(app)
      .post('/api/lobby/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 4000 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.reference.startsWith('game-wd-')).toBe(true);

    // Wallet debited by the reserve.
    expect(await wallet.balance(playerId, 'KES')).toBe(6000);

    const wd = await withdrawals.get(res.body.reference);
    expect(wd).toMatchObject({ playerId, currency: 'KES', amountMinor: 4000, status: 'pending', mapleradId: 'tx-1' });

    const call = disburseCalls.at(-1)!;
    expect(call).toMatchObject({ currency: 'KES', amountMinor: 4000, phone: '254700000000', bankCode: 'MPESA_TEST', reference: res.body.reference });
  });

  it('rejects an overdraw with 400 INSUFFICIENT_FUNDS and does not disburse', async () => {
    disburseShouldThrow = false;
    const { playerId, token } = await fundedPlayer(1000);
    const before = disburseCalls.length;

    const res = await request(app)
      .post('/api/lobby/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(disburseCalls.length).toBe(before);
    expect(await wallet.balance(playerId, 'KES')).toBe(1000);
  });

  it('refunds the reserve when the disbursement call fails (502 DISBURSE_FAILED)', async () => {
    disburseShouldThrow = true;
    const { playerId, token } = await fundedPlayer(8000);

    const res = await request(app)
      .post('/api/lobby/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('DISBURSE_FAILED');
    // Balance restored — the failed payout left the player whole.
    expect(await wallet.balance(playerId, 'KES')).toBe(8000);
    disburseShouldThrow = false;
  });

  it('rejects withdrawals for a currency without a ready payout rail (400 WITHDRAW_UNAVAILABLE)', async () => {
    const players = new PlayersRepo(db.pool);
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'ZAR', email: 'p@example.com' });
    const token = await signPlayerJwt(player.playerId);

    const res = await request(app)
      .post('/api/lobby/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountMinor: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WITHDRAW_UNAVAILABLE');
  });

  it('rejects a request without a player JWT (401)', async () => {
    const res = await request(app).post('/api/lobby/withdraw').send({ amountMinor: 5000 });
    expect(res.status).toBe(401);
  });
});
