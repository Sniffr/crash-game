import { randomUUID, createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { MapleradClient } from '../maplerad/client.js';
import { createMapleradWebhookRouter } from './maplerad-webhook.js';

// ---------------------------------------------------------------------------
// Real Svix HMAC signing helper — mirrors packages/server/src/maplerad/client.test.ts
// so this test exercises the same scheme the real client verifies.
// ---------------------------------------------------------------------------
function sign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.slice(secret.indexOf('_') + 1), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const TS = '1700000000';

let db: TestDb;
let app: express.Application;
let deposits: PgDepositsRepo;
let wallet: WalletLedger;
let players: PlayersRepo;
let verifyTransactionResult: Record<string, unknown>;
let notifyCalls: Array<{ playerId: string; balanceMinor: number; currency: string }>;

beforeAll(async () => {
  db = await makeTestDb();
  wallet = new WalletLedger(db.pool);
  deposits = new PgDepositsRepo(db.pool);
  players = new PlayersRepo(db.pool);

  const realClient = new MapleradClient({ baseUrl: 'x', secretKey: 'y', webhookSecret: SECRET });
  verifyTransactionResult = { status: 'success' };
  const maplerad = {
    verifyWebhookSignature: (svixId: string, svixTs: string, rawBody: string, sigHeader: string) =>
      realClient.verifyWebhookSignature(svixId, svixTs, rawBody, sigHeader),
    verifyTransaction: async (_id: string) => verifyTransactionResult,
  };

  notifyCalls = [];
  const notifyBalance = (playerId: string, balanceMinor: number, currency: string) => {
    notifyCalls.push({ playerId, balanceMinor, currency });
  };

  app = express();
  // Stash the raw body exactly as the middleware in Task 11 will — signature
  // verification must run against the exact bytes received.
  app.use(
    '/webhooks',
    express.raw({ type: '*/*' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: string }).rawBody = (req.body as Buffer).toString('utf8');
      next();
    },
  );
  app.use('/webhooks', createMapleradWebhookRouter({ maplerad, deposits, wallet, notifyBalance }));
});

afterAll(async () => {
  await db.cleanup();
});

function postWebhook(raw: string, headers: Record<string, string>) {
  return request(app)
    .post('/webhooks/maplerad')
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(raw);
}

describe('maplerad webhook router', () => {
  it('credits a game deposit once on collection.successful, and a replay does not double-credit', async () => {
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES' });
    const playerId = player.playerId;
    const reference = `game-dep-${playerId}-${randomUUID()}`;
    await deposits.createPending({ reference, playerId, currency: 'KES', amountMinor: 5000 });
    verifyTransactionResult = { status: 'success' };

    const raw = JSON.stringify({
      event: 'collection.successful',
      data: { reference, amount: 5000, status: 'success', id: 'tx1' },
    });
    const sig = sign(SECRET, 'e1', TS, raw);
    const headers = { 'svix-id': 'e1', 'svix-timestamp': TS, 'svix-signature': sig };

    const res1 = await postWebhook(raw, headers);
    expect(res1.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(5000);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual({ playerId, balanceMinor: 5000, currency: 'KES' });

    // Replay the identical event — must not double-credit.
    const res2 = await postWebhook(raw, headers);
    expect(res2.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(5000);
    expect(notifyCalls).toHaveLength(1);
  });

  it('ignores a foreign reference (not game-dep-) with 200 and no credit', async () => {
    const raw = JSON.stringify({
      event: 'collection.successful',
      data: { reference: 'sms-xyz', amount: 999, status: 'success', id: 'tx2' },
    });
    const sig = sign(SECRET, 'e2', TS, raw);
    const res = await postWebhook(raw, { 'svix-id': 'e2', 'svix-timestamp': TS, 'svix-signature': sig });
    expect(res.status).toBe(200);
    // No player to check a balance for — the key assertion is that nothing
    // blew up and no deposit lookup/credit occurred (foreign ref short-circuits).
  });

  it('does not credit when server-side re-verification does not confirm success (spoofed payload)', async () => {
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES' });
    const playerId = player.playerId;
    const reference = `game-dep-${playerId}-${randomUUID()}`;
    await deposits.createPending({ reference, playerId, currency: 'KES', amountMinor: 4200 });
    // The webhook payload claims success, but the re-verify call (the source
    // of truth) says otherwise — the handler must trust verifyTransaction,
    // not the payload.
    verifyTransactionResult = { id: 'tx5', status: 'pending' };

    const raw = JSON.stringify({
      event: 'collection.successful',
      data: { reference, amount: 4200, status: 'success', id: 'tx5' },
    });
    const sig = sign(SECRET, 'e5', TS, raw);
    const res = await postWebhook(raw, { 'svix-id': 'e5', 'svix-timestamp': TS, 'svix-signature': sig });

    expect(res.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(0);
    const dep = await deposits.get(reference);
    expect(dep?.status).toBe('pending');

    verifyTransactionResult = { status: 'success' };
  });

  it('returns 200 and does not credit for a game-dep- reference with no matching deposit row', async () => {
    const reference = `game-dep-unknown-${randomUUID()}`;
    const raw = JSON.stringify({
      event: 'collection.successful',
      data: { reference, amount: 1000, status: 'success', id: 'tx6' },
    });
    const sig = sign(SECRET, 'e6', TS, raw);
    const res = await postWebhook(raw, { 'svix-id': 'e6', 'svix-timestamp': TS, 'svix-signature': sig });

    expect(res.status).toBe(200);
    expect(await deposits.get(reference)).toBeNull();
  });

  it('marks a pending deposit failed on collection.failed (no credit)', async () => {
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES' });
    const playerId = player.playerId;
    const reference = `game-dep-${playerId}-${randomUUID()}`;
    await deposits.createPending({ reference, playerId, currency: 'KES', amountMinor: 3000 });

    const raw = JSON.stringify({ event: 'collection.failed', data: { reference, id: 'tx3' } });
    const sig = sign(SECRET, 'e3', TS, raw);
    const res = await postWebhook(raw, { 'svix-id': 'e3', 'svix-timestamp': TS, 'svix-signature': sig });

    expect(res.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(0);
    const dep = await deposits.get(reference);
    expect(dep?.status).toBe('failed');
  });

  it('rejects a bad/absent signature with 400 and does not credit', async () => {
    const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES' });
    const playerId = player.playerId;
    const reference = `game-dep-${playerId}-${randomUUID()}`;
    await deposits.createPending({ reference, playerId, currency: 'KES', amountMinor: 7000 });

    const raw = JSON.stringify({
      event: 'collection.successful',
      data: { reference, amount: 7000, status: 'success', id: 'tx4' },
    });

    // Absent signature headers entirely.
    const resNoSig = await postWebhook(raw, {});
    expect(resNoSig.status).toBe(400);

    // Bad signature.
    const resBadSig = await postWebhook(raw, { 'svix-id': 'e4', 'svix-timestamp': TS, 'svix-signature': 'v1,bad' });
    expect(resBadSig.status).toBe(400);

    expect(await wallet.balance(playerId, 'KES')).toBe(0);
  });
});
