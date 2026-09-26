const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { PgWithdrawalsRepo } from '@crash/wallet/withdrawals-repo-pg';
import { AccountsRepo } from '../account/accounts-repo.js';
import { signPlayerJwt } from '../http/lobby.js';
import { signAdminJwt } from '../http/middleware/admin-auth.js';
import { createWithdrawalsRouter } from '../http/withdrawals.js';
import { createAdminOpsRouter } from '../http/admin-ops.js';
import { SupportRepo } from '../support/support-repo.js';
import { createSupportRouter } from '../support/router.js';
import { WithdrawalService } from './withdrawals.js';
import { providerRejected, type PayOutProvider, type PayoutInput, type PayoutResult, type PayoutStatus } from './types.js';

class StubPayouts implements PayOutProvider {
  readonly name = 'maplerad';
  webhookSigned = true;
  sent: PayoutInput[] = [];
  next: 'accept' | 'reject' | 'network' = 'accept';
  lookups = new Map<string, PayoutStatus | null>();
  supportsPayout(currency: string) { return currency === 'KES'; }
  async payout(input: PayoutInput): Promise<PayoutResult> {
    this.sent.push(input);
    if (this.next === 'reject') throw providerRejected('insufficient merchant balance');
    if (this.next === 'network') throw new Error('socket hang up');
    return { providerTxnId: `mr-${this.sent.length}`, status: 'pending' };
  }
  async lookupPayout(id: string) { return this.lookups.get(id) ?? null; }
  parsePayoutEvent(payload: unknown) {
    const p = payload as { event: string; data: { reference: string; id: string } };
    if (!p.event.startsWith('transfer.')) return null;
    return { reference: p.data.reference, providerTxnId: p.data.id, status: p.event === 'transfer.successful' ? 'success' as const : 'failed' as const };
  }
}

let db: TestDb;
let wallet: WalletLedger;
let repo: PgWithdrawalsRepo;
let provider: StubPayouts;
let service: WithdrawalService;
let app: express.Application;
const quiet = { warn: () => {}, error: () => {}, log: () => {} };

beforeAll(async () => {
  db = await makeTestDb();
  wallet = new WalletLedger(db.pool);
  repo = new PgWithdrawalsRepo(db.pool, wallet);
  provider = new StubPayouts();
  service = new WithdrawalService(repo, provider, quiet);
  const support = new SupportRepo(db.pool);
  app = express();
  app.use(express.json());
  app.use('/api/account', createWithdrawalsRouter({
    accounts: new AccountsRepo(db.pool), withdrawals: repo, service, provider,
    limits: { minWithdrawalMinor: 5_000, maxWithdrawalMinor: 1_000_000 },
    betLimits: { minStakeMinor: 1_000, maxStakeMinor: 1_000_000, maxPayoutMinor: 100_000_000 },
  }));
  app.use('/api/account/support', createSupportRouter({ support }));
  app.use('/admin/v1', createAdminOpsRouter({ withdrawals: repo, support, adminAudit: { record: () => {} }, revoked: new Set() }));
});

afterAll(async () => {
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

beforeEach(() => { provider.next = 'accept'; provider.webhookSigned = true; });

let seq = 0;
async function player(fundMinor = 100_000, phone: string | null = '+254700000001') {
  seq += 1;
  const { rows } = await db.pool.query<{ player_id: string }>(
    `INSERT INTO players (username, password_hash, currency, phone) VALUES ($1, 'h', 'KES', $2) RETURNING player_id`,
    [`wd-player-${seq}`, phone],
  );
  const id = rows[0]!.player_id;
  if (fundMinor > 0) await wallet.deposit(id, fundMinor, 'KES', `fund-wd-${seq}`);
  return { id, auth: `Bearer ${await signPlayerJwt(id)}` };
}

const withdraw = (auth: string, amountMinor: number) =>
  request(app).post('/api/account/withdraw').set('Authorization', auth).send({ amountMinor });

const transferEvent = (event: string, reference: string, id: string) => ({ event, data: { reference, id } });

async function financeToken(roles: Array<'finance' | 'support' | 'admin'> = ['finance']) {
  return `Bearer ${(await signAdminJwt({ sub: 'ops', roles }, { ttlSeconds: 600 })).token}`;
}

describe('POST /api/account/withdraw', () => {
  it('holds the funds and sends the payout to the phone on file', async () => {
    const p = await player();
    const res = await withdraw(p.auth, 20_000);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'processing', balanceMinor: 80_000, phone: '+254700000001' });
    expect(provider.sent.at(-1)).toMatchObject({ amountMinor: 20_000, phone: '+254700000001', currency: 'KES' });
    expect(await wallet.balance(p.id)).toBe(80_000);
  });

  it('refunds immediately when the provider rejects the payout', async () => {
    const p = await player();
    provider.next = 'reject';
    const res = await withdraw(p.auth, 20_000);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WITHDRAWAL_FAILED');
    expect(await wallet.balance(p.id)).toBe(100_000);
  });

  it('keeps the funds held (no refund, no retry) when the outcome is unknown', async () => {
    const p = await player();
    provider.next = 'network';
    const res = await withdraw(p.auth, 20_000);
    expect(res.body.status).toBe('pending');
    expect(await wallet.balance(p.id)).toBe(80_000);
  });

  it('enforces limits, balance and a phone on file', async () => {
    const p = await player(10_000);
    expect((await withdraw(p.auth, 1_000)).body.error.code).toBe('AMOUNT_TOO_SMALL');
    expect((await withdraw(p.auth, 2_000_000)).body.error.code).toBe('AMOUNT_TOO_LARGE');
    expect((await withdraw(p.auth, 50_000)).body.error.code).toBe('INSUFFICIENT_FUNDS');
    const noPhone = await player(100_000, null);
    expect((await withdraw(noPhone.auth, 10_000)).body.error.code).toBe('NO_PHONE');
  });
});

describe('payout webhooks and reconciliation', () => {
  async function processingWithdrawal() {
    const p = await player();
    const res = await withdraw(p.auth, 30_000);
    const w = (await repo.get(res.body.reference))!;
    return { p, w };
  }

  it('marks a payout paid on a signed success event', async () => {
    const { p, w } = await processingWithdrawal();
    expect(await service.onWebhook(transferEvent('transfer.successful', w.reference, w.providerTxnId!))).toBe('applied');
    expect((await repo.get(w.reference))!.status).toBe('success');
    expect(await wallet.balance(p.id)).toBe(70_000);
  });

  it('does not trust a success event when webhooks are unsigned and there is no lookup', async () => {
    const { w } = await processingWithdrawal();
    provider.webhookSigned = false;
    expect(await service.onWebhook(transferEvent('transfer.successful', w.reference, w.providerTxnId!))).toBe('deferred');
    expect((await repo.get(w.reference))!.status).toBe('processing');
  });

  it('never refunds on an unconfirmed failure event', async () => {
    const { p, w } = await processingWithdrawal();
    expect(await service.onWebhook(transferEvent('transfer.failed', w.reference, w.providerTxnId!))).toBe('deferred');
    expect((await repo.get(w.reference))!.status).toBe('processing');
    expect(await wallet.balance(p.id)).toBe(70_000);
  });

  it('refunds exactly once on a confirmed failure, even when the event is replayed', async () => {
    const { p, w } = await processingWithdrawal();
    provider.lookups.set(w.providerTxnId!, 'failed');
    const evt = transferEvent('transfer.failed', w.reference, w.providerTxnId!);
    expect(await service.onWebhook(evt)).toBe('applied');
    expect(await service.onWebhook(evt)).toBe('ignored');
    expect(await wallet.balance(p.id)).toBe(100_000);
  });

  it('ignores events that are not ours', async () => {
    expect(await service.onWebhook(transferEvent('transfer.successful', 'someone-else-123', 'x'))).toBe('ignored');
    expect(await service.onWebhook({ event: 'collection.successful', data: { reference: 'game-dep-1', id: 'y' } })).toBe('ignored');
  });

  it('reconciliation settles what it can confirm and flags the rest for review', async () => {
    const confirmed = await processingWithdrawal();
    provider.lookups.set(confirmed.w.providerTxnId!, 'success');
    provider.next = 'network';
    const unknown = await player();
    const unknownRes = await withdraw(unknown.auth, 10_000);

    const later = Date.now() + 60 * 60_000;
    const review = await service.reconcile(later);
    expect((await repo.get(confirmed.w.reference))!.status).toBe('success');
    expect(review).toContain(unknownRes.body.reference);
  });
});

describe('admin resolution', () => {
  it('finance can settle an unknown payout as failed (refund once) — support cannot', async () => {
    provider.next = 'network';
    const p = await player();
    const ref = (await withdraw(p.auth, 25_000)).body.reference;

    const denied = await request(app).post(`/admin/v1/withdrawals/${ref}/resolve`).set('Authorization', await financeToken(['support']))
      .send({ outcome: 'failed' });
    expect(denied.status).toBe(403);

    const queue = await request(app).get('/admin/v1/withdrawals').set('Authorization', await financeToken());
    expect(queue.body.items.map((w: { reference: string }) => w.reference)).toContain(ref);

    const ok = await request(app).post(`/admin/v1/withdrawals/${ref}/resolve`).set('Authorization', await financeToken())
      .send({ outcome: 'failed', note: 'Maplerad confirmed not sent' });
    expect(ok.status).toBe(200);
    expect(ok.body.withdrawal.status).toBe('failed');
    expect(await wallet.balance(p.id)).toBe(100_000);

    const again = await request(app).post(`/admin/v1/withdrawals/${ref}/resolve`).set('Authorization', await financeToken())
      .send({ outcome: 'failed' });
    expect(again.status).toBe(409);
    expect(await wallet.balance(p.id)).toBe(100_000);
  });
});

describe('support chat', () => {
  it('threads player messages and agent replies with unread counts', async () => {
    const p = await player(0);
    const send = (body: string) => request(app).post('/api/account/support/messages').set('Authorization', p.auth).send({ body });
    expect((await send('My deposit has not arrived')).status).toBe(201);

    const agent = await financeToken(['support']);
    const inbox = await request(app).get('/admin/v1/support/threads').set('Authorization', agent);
    const thread = inbox.body.items.find((t: { playerId: string }) => t.playerId === p.id);
    expect(thread).toMatchObject({ lastMessage: 'My deposit has not arrived', unreadFromPlayer: 1 });

    await request(app).get(`/admin/v1/support/threads/${p.id}`).set('Authorization', agent);
    await request(app).post(`/admin/v1/support/threads/${p.id}/messages`).set('Authorization', agent).send({ body: 'Checking now.' });

    expect((await request(app).get('/api/account/support/unread').set('Authorization', p.auth)).body.count).toBe(1);
    const msgs = await request(app).get('/api/account/support/messages').set('Authorization', p.auth);
    expect(msgs.body.messages.map((m: { sender: string; body: string }) => [m.sender, m.body])).toEqual([
      ['player', 'My deposit has not arrived'],
      ['agent', 'Checking now.'],
    ]);
    expect((await request(app).get('/api/account/support/unread').set('Authorization', p.auth)).body.count).toBe(0);
  });

  it('rejects empty messages and rate-limits bursts', async () => {
    const p = await player(0);
    const send = (body: string) => request(app).post('/api/account/support/messages').set('Authorization', p.auth).send({ body });
    expect((await send('   ')).body.error.code).toBe('EMPTY_MESSAGE');
    for (let i = 0; i < 10; i++) await send(`message ${i}`);
    expect((await send('one too many')).status).toBe(429);
  });
});
