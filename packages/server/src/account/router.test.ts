const _prevJwtSecret = process.env['JWT_SECRET'];
process.env['JWT_SECRET'] = 'test-secret';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { setPlayerGate } from '../http/lobby.js';
import { AccountsRepo, makePlayerGate } from './accounts-repo.js';
import { OtpService } from './otp.js';
import { createAccountRouter } from './router.js';
import { SmsDeliveryError, type SmsSender } from '../sms/sender.js';

class RecordingSms implements SmsSender {
  sent: Array<{ phone: string; message: string }> = [];
  failNext = false;
  async send(phone: string, message: string) {
    if (this.failNext) { this.failNext = false; throw new SmsDeliveryError('gateway down'); }
    this.sent.push({ phone, message });
  }
  lastCode(phone: string): string {
    const msg = [...this.sent].reverse().find((s) => s.phone === phone)?.message ?? '';
    return /(\d{6})/.exec(msg)?.[1] ?? '';
  }
}

let db: TestDb;
let app: express.Application;
let sms: RecordingSms;
let accounts: AccountsRepo;
let clock = Date.UTC(2026, 9, 1, 12, 0, 0);
const tick = (sec: number) => { clock += sec * 1000; };

beforeAll(async () => {
  db = await makeTestDb();
  sms = new RecordingSms();
  accounts = new AccountsRepo(db.pool);
  const otp = new OtpService(db.pool, sms, () => 'otp-secret', {}, () => clock);
  setPlayerGate(makePlayerGate(accounts, () => clock));
  app = express();
  app.use(express.json());
  app.use('/api/account', createAccountRouter({ accounts, otp, wallet: new WalletLedger(db.pool), now: () => clock }));
});

afterAll(async () => {
  setPlayerGate(null);
  await db.cleanup();
  if (_prevJwtSecret === undefined) delete process.env['JWT_SECRET'];
  else process.env['JWT_SECRET'] = _prevJwtSecret;
});

beforeEach(() => tick(120)); // clear any resend cooldown between tests

const post = (path: string, body: unknown, token?: string) => {
  const r = request(app).post(`/api/account${path}`).send(body as object);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

/** Register + verify a phone account; returns its signed-in token. */
async function signUp(localPhone: string, password = 'password123'): Promise<string> {
  const phone = `+254${localPhone.slice(1)}`;
  expect((await post('/register', { phone: localPhone, password })).status).toBe(201);
  const res = await post('/register/verify', { phone: localPhone, code: sms.lastCode(phone) });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

describe('sign-up', () => {
  it('sends a code, verifies it, and signs the player in', async () => {
    const res = await post('/register', { phone: '0711000001', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('+254711000001');
    const code = sms.lastCode('+254711000001');
    expect(code).toMatch(/^\d{6}$/);

    const verified = await post('/register/verify', { phone: '+254 711 000 001', code });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ currency: 'KES', balanceMinor: 0, player: { phone: '+254711000001' } });

    const me = await request(app).get('/api/account/me').set('Authorization', `Bearer ${verified.body.token}`);
    expect(me.body).toMatchObject({ phone: '+254711000001', phoneVerified: true });
  });

  it('rejects a second registration of a verified number', async () => {
    await signUp('0711000002');
    expect((await post('/register', { phone: '0711000002', password: 'password123' })).body.error.code).toBe('PHONE_TAKEN');
  });

  it('validates the phone number and password length', async () => {
    expect((await post('/register', { phone: '12345', password: 'password123' })).body.error.code).toBe('INVALID_PHONE');
    expect((await post('/register', { phone: '0711000003', password: 'short' })).body.error.code).toBe('WEAK_PASSWORD');
  });

  it('asks an unverified account to verify at login, and resends a code', async () => {
    await post('/register', { phone: '0711000004', password: 'password123' });
    tick(120);
    const before = sms.sent.length;
    const res = await post('/login', { phone: '0711000004', password: 'password123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED');
    expect(sms.sent.length).toBe(before + 1);
  });

  it('locks a code after five wrong attempts', async () => {
    await post('/register', { phone: '0711000005', password: 'password123' });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post('/register/verify', { phone: '0711000005', code: '000000' })).body.error.code);
    expect(codes.slice(0, 4)).toEqual(['INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE']);
    expect(codes[4]).toBe('TOO_MANY_ATTEMPTS');
    const right = await post('/register/verify', { phone: '0711000005', code: sms.lastCode('+254711000005') });
    expect(right.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('enforces the resend cooldown', async () => {
    await post('/register', { phone: '0711000006', password: 'password123' });
    const res = await post('/otp/resend', { phone: '0711000006', purpose: 'register' });
    expect(res.status).toBe(429);
    expect(res.body.error.retryAfterSec).toBeGreaterThan(0);
  });

  it('reports an SMS failure and lets the player retry immediately', async () => {
    sms.failNext = true;
    const failed = await post('/register', { phone: '0711000007', password: 'password123' });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('SMS_FAILED');
    const retry = await post('/otp/resend', { phone: '0711000007', purpose: 'register' });
    expect(retry.status).toBe(200);
  });
});

describe('login', () => {
  it('signs in with phone + password and rejects a wrong password', async () => {
    await signUp('0722000001');
    expect((await post('/login', { phone: '0722000001', password: 'password123' })).status).toBe(200);
    expect((await post('/login', { phone: '0722000001', password: 'nope-nope' })).body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('lets a Game Hub account log in with the phone it registered', async () => {
    await db.pool.query(
      `INSERT INTO players (username, password_hash, currency, phone) VALUES ('legacyuser', $1, 'KES', '0722000002')`,
      [await bcrypt.hash('legacypass1', 4)],
    );
    const res = await post('/login', { phone: '+254722000002', password: 'legacypass1' });
    expect(res.status).toBe(200);
    expect(res.body.player.username).toBe('legacyuser');
  });

  it('refuses to guess when several Game Hub accounts share a number', async () => {
    const hash = await bcrypt.hash('legacypass1', 4);
    await db.pool.query(
      `INSERT INTO players (username, password_hash, currency, phone) VALUES ('twin1', $1, 'KES', '0722000003'), ('twin2', $1, 'KES', '254722000003')`,
      [hash],
    );
    expect((await post('/login', { phone: '0722000003', password: 'legacypass1' })).body.error.code).toBe('AMBIGUOUS_PHONE');
  });
});

describe('password reset', () => {
  it('resets via code + proof and signs out every old session', async () => {
    const oldToken = await signUp('0733000001');
    tick(120);
    expect((await post('/password/forgot', { phone: '0733000001' })).status).toBe(200);
    const verify = await post('/password/verify', { phone: '0733000001', code: sms.lastCode('+254733000001') });
    expect(verify.status).toBe(200);

    const reset = await post('/password/reset', { proof: verify.body.proof, password: 'brand-new-pass' });
    expect(reset.status).toBe(200);

    const stale = await request(app).get('/api/account/me').set('Authorization', `Bearer ${oldToken}`);
    expect(stale.body.error.code).toBe('SESSION_REVOKED');
    const fresh = await request(app).get('/api/account/me').set('Authorization', `Bearer ${reset.body.token}`);
    expect(fresh.status).toBe(200);

    expect((await post('/login', { phone: '0733000001', password: 'password123' })).status).toBe(401);
    expect((await post('/login', { phone: '0733000001', password: 'brand-new-pass' })).status).toBe(200);

    // The proof is single-use: the reset bumped the token version it carried.
    expect((await post('/password/reset', { proof: verify.body.proof, password: 'another-pass-1' })).body.error.code).toBe('PROOF_EXPIRED');
  });

  it('does not reveal whether a number has an account', async () => {
    const before = sms.sent.length;
    const res = await post('/password/forgot', { phone: '0799999999' });
    expect(res.status).toBe(200);
    expect(sms.sent.length).toBe(before);
  });
});

describe('signed-in settings', () => {
  it('changes the password and revokes the old session', async () => {
    const token = await signUp('0744000001');
    expect((await request(app).put('/api/account/password').set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'wrong-pass', newPassword: 'newpassword1' })).body.error.code).toBe('WRONG_PASSWORD');
    const ok = await request(app).put('/api/account/password').set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'password123', newPassword: 'newpassword1' });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/account/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('self-exclusion signs the player out and blocks login until it ends', async () => {
    const token = await signUp('0744000002');
    const res = await post('/self-exclusion', { period: '24h' }, token);
    expect(res.status).toBe(200);
    expect(Date.parse(res.body.until)).toBe(clock + 24 * 3_600_000);
    expect((await request(app).get('/api/account/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);

    const blocked = await post('/login', { phone: '0744000002', password: 'password123' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: 'SELF_EXCLUDED', until: res.body.until });

    tick(24 * 3600 + 1);
    expect((await post('/login', { phone: '0744000002', password: 'password123' })).status).toBe(200);
  });

  it('deactivates with a code and reactivates with a code + new password', async () => {
    const token = await signUp('0744000003');
    tick(120);
    expect((await post('/deactivate/request', { reason: 'other' }, token)).status).toBe(200);
    const confirm = await post('/deactivate/confirm', { reason: 'other', code: sms.lastCode('+254744000003') }, token);
    expect(confirm.status).toBe(200);
    expect((await post('/login', { phone: '0744000003', password: 'password123' })).body.error.code).toBe('ACCOUNT_DEACTIVATED');

    tick(120);
    expect((await post('/reactivate/request', { phone: '0744000003' })).status).toBe(200);
    const verify = await post('/reactivate/verify', { phone: '0744000003', code: sms.lastCode('+254744000003') });
    const done = await post('/reactivate/complete', { proof: verify.body.proof, password: 'welcome-back-1' });
    expect(done.status).toBe(200);
    expect((await post('/login', { phone: '0744000003', password: 'welcome-back-1' })).status).toBe(200);
  });
});
