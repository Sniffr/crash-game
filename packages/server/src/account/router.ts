/**
 * SimBet account API — phone-number accounts with SMS one-time codes.
 * Mounted at /api/account.
 *
 *   POST /register                {phone, password}      → code sent
 *   POST /register/verify         {phone, code}          → signed in
 *   POST /otp/resend              {phone, purpose}
 *   POST /login                   {phone, password}
 *   POST /password/forgot         {phone}                → code sent (never reveals if the phone exists)
 *   POST /password/verify         {phone, code}          → short-lived proof
 *   POST /password/reset          {proof, password}      → signed in, every other session signed out
 *   GET  /me                      player JWT
 *   PUT  /password                player JWT {oldPassword, newPassword}
 *   POST /self-exclusion          player JWT {period}    → signed out until it ends
 *   POST /deactivate/request      player JWT {reason}    → code sent
 *   POST /deactivate/confirm      player JWT {code, reason}
 *   POST /reactivate/request      {phone}
 *   POST /reactivate/verify       {phone, code}          → proof
 *   POST /reactivate/complete     {proof, password}      → signed in
 */

import { Router, type Request, type Response } from 'express';
import * as bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { normalizeKePhone } from '@crash/shared/phone';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import { requirePlayerJwt, signPlayerJwt } from '../http/lobby.js';
import { SmsDeliveryError } from '../sms/sender.js';
import { accountBlock, PhoneTakenError, type Account, type AccountsRepo } from './accounts-repo.js';
import { OtpCooldownError, type OtpCheck, type OtpPurpose, type OtpService } from './otp.js';

const BCRYPT_COST = 10;
const PROOF_TTL_SEC = 10 * 60;

const SELF_EXCLUSION_MS: Record<string, number> = {
  '24h': 24 * 3_600_000,
  '48h': 48 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};
const DEACTIVATION_REASONS = new Set(['fraud', 'addiction', 'other']);

export interface AccountRouterDeps {
  accounts: AccountsRepo;
  otp: OtpService;
  wallet: WalletLedger;
  now?: () => number;
}

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'Your password must be at least 8 characters long.';
  if (pw.length > 128) return 'Your password is too long.';
  return null;
}

function secretKey(): Uint8Array {
  const s = process.env['JWT_SECRET'];
  if (!s) throw new Error('JWT_SECRET not set');
  return new TextEncoder().encode(s);
}

/** A short-lived token proving the holder just passed an OTP for this account. */
async function signProof(acct: Account, purpose: OtpPurpose): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: 'otp-proof', purpose, ver: acct.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(acct.playerId)
    .setIssuedAt(now)
    .setExpirationTime(now + PROOF_TTL_SEC)
    .sign(secretKey());
}

async function readProof(token: unknown, purpose: OtpPurpose): Promise<{ playerId: string; ver: number } | null> {
  if (typeof token !== 'string' || !token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if (payload['typ'] !== 'otp-proof' || payload['purpose'] !== purpose || typeof payload.sub !== 'string') return null;
    return { playerId: payload.sub, ver: Number(payload['ver'] ?? -1) };
  } catch {
    return null;
  }
}

const OTP_ERRORS: Record<Exclude<OtpCheck, 'ok'>, [number, string, string]> = {
  invalid: [400, 'INVALID_CODE', 'That code is not correct.'],
  expired: [400, 'CODE_EXPIRED', 'That code has expired — request a new one.'],
  locked: [429, 'TOO_MANY_ATTEMPTS', 'Too many wrong attempts — request a new code.'],
};

export function createAccountRouter(deps: AccountRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        if (res.headersSent) return;
        if (err instanceof OtpCooldownError) {
          return fail(res, 429, 'OTP_COOLDOWN', `Please wait ${err.retryAfterSec}s before requesting another code.`, { retryAfterSec: err.retryAfterSec });
        }
        if (err instanceof SmsDeliveryError) {
          console.error('[account] SMS delivery failed:', err.message);
          return fail(res, 502, 'SMS_FAILED', "We couldn't send the SMS right now — please try again shortly.");
        }
        console.error('[account] request failed:', err);
        fail(res, 500, 'INTERNAL', 'internal error');
      }
    };

  const phoneOf = (req: Request): string | null => normalizeKePhone(String((req.body ?? {}).phone ?? ''));

  async function signedIn(res: Response, acct: Account, status = 200): Promise<void> {
    const token = await signPlayerJwt(acct.playerId, acct.tokenVersion);
    const balanceMinor = await deps.wallet.balance(acct.playerId, acct.currency);
    res.status(status).json({
      token,
      player: { playerId: acct.playerId, username: acct.username, phone: acct.phone },
      balanceMinor,
      currency: acct.currency,
    });
  }

  /** Issue a code, treating an active cooldown as "already sent" (the player still has it). */
  async function sendCode(phone: string, purpose: OtpPurpose): Promise<number> {
    try {
      return (await deps.otp.issue(phone, purpose)).resendInSec;
    } catch (err) {
      if (err instanceof OtpCooldownError) return err.retryAfterSec;
      throw err;
    }
  }

  // ── Sign-up ──────────────────────────────────────────────────────────────
  router.post('/register', handle(async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return fail(res, 400, 'INVALID_PHONE', 'Enter a valid Kenyan phone number.');
    const pwProblem = passwordProblem(req.body?.password);
    if (pwProblem) return fail(res, 400, 'WEAK_PASSWORD', pwProblem);

    const hash = await bcrypt.hash(req.body.password as string, BCRYPT_COST);
    const existing = await deps.accounts.findByPhone(phone);
    if (existing === 'ambiguous' || (existing && (existing.phoneVerifiedAt || existing.username !== phone))) {
      return fail(res, 409, 'PHONE_TAKEN', 'An account with this phone number already exists — log in instead.');
    }
    try {
      if (existing) await deps.accounts.replaceUnverifiedPassword(existing.playerId, hash);
      else await deps.accounts.createPhoneAccount(phone, hash);
    } catch (err) {
      if (err instanceof PhoneTakenError) return fail(res, 409, 'PHONE_TAKEN', err.message);
      throw err;
    }
    res.status(201).json({ phone, resendInSec: await sendCode(phone, 'register') });
  }));

  router.post('/register/verify', handle(async (req, res) => {
    const phone = phoneOf(req);
    const acct = phone ? await deps.accounts.findByPhone(phone) : null;
    if (!phone || !acct || acct === 'ambiguous') return fail(res, 400, 'CODE_EXPIRED', OTP_ERRORS.expired[2]);
    const check = await deps.otp.verify(phone, 'register', String(req.body?.code ?? ''));
    if (check !== 'ok') return fail(res, ...OTP_ERRORS[check]);
    await deps.accounts.markPhoneVerified(acct.playerId);
    await signedIn(res, (await deps.accounts.getById(acct.playerId))!);
  }));

  router.post('/otp/resend', handle(async (req, res) => {
    const phone = phoneOf(req);
    const purpose = String(req.body?.purpose ?? '') as OtpPurpose;
    if (!phone) return fail(res, 400, 'INVALID_PHONE', 'Enter a valid Kenyan phone number.');
    if (!['register', 'reset', 'reactivate'].includes(purpose)) return fail(res, 400, 'INVALID_PURPOSE', 'unknown code type');
    const acct = await deps.accounts.findByPhone(phone);
    const eligible = acct && acct !== 'ambiguous' && (
      purpose === 'register' ? !acct.phoneVerifiedAt
      : purpose === 'reactivate' ? acct.status === 'deactivated'
      : acct.status === 'active'
    );
    // A cooldown here is a real 429: the player explicitly asked for another code.
    const resendInSec = eligible ? (await deps.otp.issue(phone, purpose)).resendInSec : 60;
    res.json({ resendInSec });
  }));

  // ── Sign-in ──────────────────────────────────────────────────────────────
  router.post('/login', handle(async (req, res) => {
    const phone = phoneOf(req);
    const password = req.body?.password;
    if (!phone || typeof password !== 'string') return fail(res, 400, 'INVALID_REQUEST', 'Enter your phone number and password.');
    const acct = await deps.accounts.findByPhone(phone);
    if (acct === 'ambiguous') {
      return fail(res, 409, 'AMBIGUOUS_PHONE', 'Several accounts use this number — log in on Game Hub with your username.');
    }
    if (!acct || !(await bcrypt.compare(password, acct.passwordHash))) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Incorrect phone number or password.');
    }
    if (acct.username === phone && !acct.phoneVerifiedAt) {
      const resendInSec = await sendCode(phone, 'register');
      return fail(res, 403, 'PHONE_NOT_VERIFIED', 'Verify your phone number to continue.', { resendInSec });
    }
    const block = accountBlock(acct, now());
    if (block) return fail(res, 403, block.code, block.message, 'until' in block ? { until: block.until } : {});
    await signedIn(res, acct);
  }));

  // ── Forgotten password ───────────────────────────────────────────────────
  router.post('/password/forgot', handle(async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return fail(res, 400, 'INVALID_PHONE', 'Enter a valid Kenyan phone number.');
    const acct = await deps.accounts.findByPhone(phone);
    const resendInSec = acct && acct !== 'ambiguous' && acct.status === 'active' ? await sendCode(phone, 'reset') : 60;
    res.json({ resendInSec });
  }));

  router.post('/password/verify', handle(async (req, res) => {
    const phone = phoneOf(req);
    const acct = phone ? await deps.accounts.findByPhone(phone) : null;
    if (!phone || !acct || acct === 'ambiguous') return fail(res, 400, 'CODE_EXPIRED', OTP_ERRORS.expired[2]);
    const check = await deps.otp.verify(phone, 'reset', String(req.body?.code ?? ''));
    if (check !== 'ok') return fail(res, ...OTP_ERRORS[check]);
    res.json({ proof: await signProof(acct, 'reset') });
  }));

  router.post('/password/reset', handle(async (req, res) => {
    const proof = await readProof(req.body?.proof, 'reset');
    const acct = proof ? await deps.accounts.getById(proof.playerId) : null;
    if (!proof || !acct || proof.ver !== acct.tokenVersion) {
      return fail(res, 400, 'PROOF_EXPIRED', 'Your reset session expired — start again.');
    }
    const pwProblem = passwordProblem(req.body?.password);
    if (pwProblem) return fail(res, 400, 'WEAK_PASSWORD', pwProblem);
    await deps.accounts.setPassword(acct.playerId, await bcrypt.hash(req.body.password as string, BCRYPT_COST));
    await deps.accounts.markPhoneVerified(acct.playerId);
    const updated = (await deps.accounts.getById(acct.playerId))!;
    const block = accountBlock(updated, now());
    if (block) return fail(res, 403, block.code, block.message, 'until' in block ? { until: block.until } : {});
    await signedIn(res, updated);
  }));

  // ── Signed-in account management ─────────────────────────────────────────
  router.get('/me', requirePlayerJwt, handle(async (req, res) => {
    const acct = (await deps.accounts.getById(req.player!.playerId))!;
    res.json({
      playerId: acct.playerId,
      username: acct.username,
      phone: acct.phone,
      phoneVerified: acct.phoneVerifiedAt != null,
      currency: acct.currency,
      balanceMinor: await deps.wallet.balance(acct.playerId, acct.currency),
    });
  }));

  router.put('/password', requirePlayerJwt, handle(async (req, res) => {
    const acct = (await deps.accounts.getById(req.player!.playerId))!;
    if (typeof req.body?.oldPassword !== 'string' || !(await bcrypt.compare(req.body.oldPassword, acct.passwordHash))) {
      return fail(res, 400, 'WRONG_PASSWORD', 'Your current password is not correct.');
    }
    const pwProblem = passwordProblem(req.body?.newPassword);
    if (pwProblem) return fail(res, 400, 'WEAK_PASSWORD', pwProblem);
    await deps.accounts.setPassword(acct.playerId, await bcrypt.hash(req.body.newPassword as string, BCRYPT_COST));
    await signedIn(res, (await deps.accounts.getById(acct.playerId))!);
  }));

  router.post('/self-exclusion', requirePlayerJwt, handle(async (req, res) => {
    const ms = SELF_EXCLUSION_MS[String(req.body?.period ?? '')];
    if (!ms) return fail(res, 400, 'INVALID_PERIOD', 'Choose a self-exclusion period.');
    const until = new Date(now() + ms);
    await deps.accounts.selfExclude(req.player!.playerId, until);
    res.json({ until: until.toISOString() });
  }));

  router.post('/deactivate/request', requirePlayerJwt, handle(async (req, res) => {
    if (!DEACTIVATION_REASONS.has(String(req.body?.reason ?? ''))) return fail(res, 400, 'INVALID_REASON', 'Choose a reason.');
    const acct = (await deps.accounts.getById(req.player!.playerId))!;
    const phone = acct.phone ? normalizeKePhone(acct.phone) : null;
    if (!phone) return fail(res, 400, 'NO_PHONE', 'Your account has no phone number to send a code to — contact support.');
    res.json({ resendInSec: await sendCode(phone, 'deactivate') });
  }));

  router.post('/deactivate/confirm', requirePlayerJwt, handle(async (req, res) => {
    const reason = String(req.body?.reason ?? '');
    if (!DEACTIVATION_REASONS.has(reason)) return fail(res, 400, 'INVALID_REASON', 'Choose a reason.');
    const acct = (await deps.accounts.getById(req.player!.playerId))!;
    const phone = acct.phone ? normalizeKePhone(acct.phone) : null;
    if (!phone) return fail(res, 400, 'NO_PHONE', 'Your account has no phone number — contact support.');
    const check = await deps.otp.verify(phone, 'deactivate', String(req.body?.code ?? ''));
    if (check !== 'ok') return fail(res, ...OTP_ERRORS[check]);
    await deps.accounts.deactivate(acct.playerId, reason);
    res.json({ deactivated: true });
  }));

  // ── Reactivation ─────────────────────────────────────────────────────────
  router.post('/reactivate/request', handle(async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return fail(res, 400, 'INVALID_PHONE', 'Enter a valid Kenyan phone number.');
    const acct = await deps.accounts.findByPhone(phone);
    const resendInSec = acct && acct !== 'ambiguous' && acct.status === 'deactivated' ? await sendCode(phone, 'reactivate') : 60;
    res.json({ resendInSec });
  }));

  router.post('/reactivate/verify', handle(async (req, res) => {
    const phone = phoneOf(req);
    const acct = phone ? await deps.accounts.findByPhone(phone) : null;
    if (!phone || !acct || acct === 'ambiguous') return fail(res, 400, 'CODE_EXPIRED', OTP_ERRORS.expired[2]);
    const check = await deps.otp.verify(phone, 'reactivate', String(req.body?.code ?? ''));
    if (check !== 'ok') return fail(res, ...OTP_ERRORS[check]);
    res.json({ proof: await signProof(acct, 'reactivate') });
  }));

  router.post('/reactivate/complete', handle(async (req, res) => {
    const proof = await readProof(req.body?.proof, 'reactivate');
    const acct = proof ? await deps.accounts.getById(proof.playerId) : null;
    if (!proof || !acct || proof.ver !== acct.tokenVersion) {
      return fail(res, 400, 'PROOF_EXPIRED', 'Your reactivation session expired — start again.');
    }
    const pwProblem = passwordProblem(req.body?.password);
    if (pwProblem) return fail(res, 400, 'WEAK_PASSWORD', pwProblem);
    await deps.accounts.reactivate(acct.playerId, await bcrypt.hash(req.body.password as string, BCRYPT_COST));
    const updated = (await deps.accounts.getById(acct.playerId))!;
    const block = accountBlock(updated, now());
    if (block) return fail(res, 403, block.code, block.message, 'until' in block ? { until: block.until } : {});
    await signedIn(res, updated);
  }));

  return router;
}
