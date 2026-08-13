import { randomUUID, createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { PgDepositsRepo } from '@crash/wallet/deposits-repo';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { MapleradClient } from '../maplerad/client.js';
import { FincraClient } from '../fincra/client.js';
import type { VerifiedTxn } from '../payments/types.js';
import { createDepositWebhookRouter } from './deposit-webhook.js';

// ---------------------------------------------------------------------------
// Real signing helpers — both processors verify against their production
// scheme here (Svix HMAC-SHA256 for Maplerad, hex HMAC-SHA512 for Fincra), so
// the shared money path is exercised through real signature checks.
// ---------------------------------------------------------------------------
const MAPLE_SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const FINCRA_SECRET = 'fincra-whsec-test';
const TS = '1700000000';

function svixSign(id: string, body: string): Record<string, string> {
  const key = Buffer.from(MAPLE_SECRET.slice(MAPLE_SECRET.indexOf('_') + 1), 'base64');
  const sig = 'v1,' + createHmac('sha256', key).update(`${id}.${TS}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': TS, 'svix-signature': sig };
}

function fincraSign(_id: string, body: string): Record<string, string> {
  return { signature: createHmac('sha512', FINCRA_SECRET).update(body).digest('hex') };
}

let db: TestDb;
let app: express.Application;
let deposits: PgDepositsRepo;
let wallet: WalletLedger;
let players: PlayersRepo;
let verifyResult: VerifiedTxn;
let notifyCalls: Array<{ playerId: string; balanceMinor: number; currency: string }>;

beforeAll(async () => {
  db = await makeTestDb();
  wallet = new WalletLedger(db.pool);
  deposits = new PgDepositsRepo(db.pool);
  players = new PlayersRepo(db.pool);

  verifyResult = { status: 'success', reference: '' };
  // Real clients for signature checking + event parsing; only the network
  // re-verify call is stubbed out.
  const maplerad = new MapleradClient({ baseUrl: 'x', secretKey: 'y', webhookSecret: MAPLE_SECRET });
  const fincra = new FincraClient({ baseUrl: 'x', secretKey: 'y', businessId: 'b', publicKey: 'pk', webhookSecret: FINCRA_SECRET });
  maplerad.verifyTransaction = async () => verifyResult;
  fincra.verifyTransaction = async () => verifyResult;

  notifyCalls = [];
  const notifyBalance = (playerId: string, balanceMinor: number, currency: string) => {
    notifyCalls.push({ playerId, balanceMinor, currency });
  };

  app = express();
  // Stash the raw body exactly as the server's json middleware does —
  // signature verification must run against the exact bytes received.
  app.use('/webhooks', express.raw({ type: '*/*' }), (req, _res, next) => {
    (req as unknown as { rawBody: string }).rawBody = (req.body as Buffer).toString('utf8');
    next();
  });
  for (const provider of [maplerad, fincra]) {
    app.use('/webhooks', createDepositWebhookRouter({ path: `/${provider.name}`, provider, deposits, wallet, notifyBalance }));
  }
});

afterAll(async () => {
  await db.cleanup();
});

// Each processor's own path, event names and signing — same expectations.
const PROCESSORS = [
  { name: 'maplerad', ok: 'collection.successful', failed: 'collection.failed', sign: svixSign },
  { name: 'fincra', ok: 'charge.successful', failed: 'charge.failed', sign: fincraSign },
] as const;

function postWebhook(name: string, raw: string, headers: Record<string, string>) {
  return request(app).post(`/webhooks/${name}`).set('Content-Type', 'application/json').set(headers).send(raw);
}

async function pendingDeposit(amountMinor: number, currency = 'KES') {
  const player = await players.create(`t_${randomUUID()}`, 'hash', { currency });
  const reference = `game-dep-${player.playerId}-${randomUUID()}`;
  await deposits.createPending({ reference, playerId: player.playerId, currency, amountMinor });
  return { playerId: player.playerId, reference };
}

describe.each(PROCESSORS)('$name deposit webhook', (p) => {
  const event = (evt: string, data: Record<string, unknown>) => JSON.stringify({ event: evt, data });

  it('credits a game deposit once, and a replay does not double-credit', async () => {
    const { playerId, reference } = await pendingDeposit(5000);
    verifyResult = { status: 'success', reference, amountMinor: 5000, currency: 'KES' };

    const raw = event(p.ok, { reference, amount: 5000, status: 'success', id: 'tx1' });
    const headers = p.sign('e1', raw);

    const res1 = await postWebhook(p.name, raw, headers);
    expect(res1.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(5000);
    expect(notifyCalls.filter((c) => c.playerId === playerId)).toEqual([{ playerId, balanceMinor: 5000, currency: 'KES' }]);

    const res2 = await postWebhook(p.name, raw, headers);
    expect(res2.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(5000);
    expect(notifyCalls.filter((c) => c.playerId === playerId)).toHaveLength(1);
  });

  it('ignores a foreign reference (not game-dep-) with 200 and no credit', async () => {
    const raw = event(p.ok, { reference: 'sms-xyz', amount: 999, status: 'success', id: 'tx2' });
    const res = await postWebhook(p.name, raw, p.sign('e2', raw));
    expect(res.status).toBe(200);
  });

  it('does not credit when server-side re-verification does not confirm success (spoofed payload)', async () => {
    const { playerId, reference } = await pendingDeposit(4200);
    // The payload claims success, but the re-verify call (source of truth) disagrees.
    verifyResult = { status: 'pending', reference };

    const raw = event(p.ok, { reference, amount: 4200, status: 'success', id: 'tx5' });
    const res = await postWebhook(p.name, raw, p.sign('e5', raw));

    expect(res.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(0);
    expect((await deposits.get(reference))?.status).toBe('pending');
  });

  it('C1: does not credit when the verified transaction belongs to a DIFFERENT reference (forged webhook)', async () => {
    // Exploit shape: attacker knows a pending deposit's reference (B) and a
    // real successful transaction (T, from a tiny real deposit) and forges
    // {reference: B, id: T}. T verifies genuinely, but for another reference.
    const { playerId, reference } = await pendingDeposit(500_000);
    verifyResult = { status: 'success', reference: `game-dep-${playerId}-other`, amountMinor: 500_000, currency: 'KES' };

    const raw = event(p.ok, { reference, amount: 500_000, status: 'success', id: 'tx-real' });
    const res = await postWebhook(p.name, raw, p.sign('e7', raw));

    expect(res.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(0);
    expect((await deposits.get(reference))?.status).toBe('pending');
  });

  it('C1: does not credit when the verified amount does not match the deposit', async () => {
    const { playerId, reference } = await pendingDeposit(500_000);
    verifyResult = { status: 'success', reference, amountMinor: 100, currency: 'KES' };

    const raw = event(p.ok, { reference, amount: 500_000, status: 'success', id: 'tx-real' });
    const res = await postWebhook(p.name, raw, p.sign('e8', raw));

    expect(res.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(0);
    expect((await deposits.get(reference))?.status).toBe('pending');
  });

  it('returns 200 and does not credit for a game-dep- reference with no matching deposit row', async () => {
    const reference = `game-dep-unknown-${randomUUID()}`;
    const raw = event(p.ok, { reference, amount: 1000, status: 'success', id: 'tx6' });
    const res = await postWebhook(p.name, raw, p.sign('e6', raw));

    expect(res.status).toBe(200);
    expect(await deposits.get(reference)).toBeNull();
  });

  it('marks a pending deposit failed on a failure event (no credit)', async () => {
    const { playerId, reference } = await pendingDeposit(3000);

    const raw = event(p.failed, { reference, id: 'tx3' });
    const res = await postWebhook(p.name, raw, p.sign('e3', raw));

    expect(res.status).toBe(200);
    expect(await wallet.balance(playerId, 'KES')).toBe(0);
    expect((await deposits.get(reference))?.status).toBe('failed');
  });

  it('rejects a bad/absent signature with 400 and does not credit', async () => {
    const { playerId, reference } = await pendingDeposit(7000);
    verifyResult = { status: 'success', reference, amountMinor: 7000, currency: 'KES' };
    const raw = event(p.ok, { reference, amount: 7000, status: 'success', id: 'tx4' });

    expect((await postWebhook(p.name, raw, {})).status).toBe(400);
    const bad = p.name === 'fincra' ? { signature: 'deadbeef' } : { 'svix-id': 'e4', 'svix-timestamp': TS, 'svix-signature': 'v1,bad' };
    expect((await postWebhook(p.name, raw, bad)).status).toBe(400);

    expect(await wallet.balance(playerId, 'KES')).toBe(0);
  });
});
