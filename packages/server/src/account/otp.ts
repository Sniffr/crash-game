import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { SmsSender } from '../sms/sender.js';

export type OtpPurpose = 'register' | 'reset' | 'deactivate' | 'reactivate';

export type OtpCheck = 'ok' | 'invalid' | 'expired' | 'locked';

export class OtpCooldownError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`wait ${retryAfterSec}s before requesting another code`);
    this.name = 'OtpCooldownError';
  }
}

export interface OtpOptions {
  ttlSec: number;
  cooldownSec: number;
  maxAttempts: number;
}

const DEFAULTS: OtpOptions = { ttlSec: 600, cooldownSec: 60, maxAttempts: 5 };

const MESSAGES: Record<OtpPurpose, (code: string) => string> = {
  register: (c) => `Your SimBet verification code is ${c}. It expires in 10 minutes. Never share it with anyone.`,
  reset: (c) => `Your SimBet password reset code is ${c}. It expires in 10 minutes. Never share it with anyone.`,
  deactivate: (c) => `Your SimBet account deactivation code is ${c}. If you didn't request this, change your password now.`,
  reactivate: (c) => `Your SimBet account reactivation code is ${c}. It expires in 10 minutes. Never share it with anyone.`,
};

/** 6-digit SMS codes, stored only as keyed hashes, one live code per phone+purpose. */
export class OtpService {
  private readonly opts: OtpOptions;

  constructor(
    private readonly pool: Pool,
    private readonly sms: SmsSender,
    private readonly secret: () => string,
    opts: Partial<OtpOptions> = {},
    private readonly now: () => number = Date.now,
    private readonly newCode: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Send a fresh code. Throws OtpCooldownError if one was sent too recently. */
  async issue(phone: string, purpose: OtpPurpose): Promise<{ resendInSec: number }> {
    const { rows } = await this.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM otp_codes WHERE phone = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
      [phone, purpose],
    );
    const last = rows[0]?.created_at.getTime();
    if (last != null) {
      const waitMs = last + this.opts.cooldownSec * 1000 - this.now();
      if (waitMs > 0) throw new OtpCooldownError(Math.ceil(waitMs / 1000));
    }

    const code = this.newCode();
    const nowMs = this.now();
    const { rows: inserted } = await this.pool.query<{ id: string }>(
      `INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [phone, purpose, this.hash(phone, purpose, code), new Date(nowMs + this.opts.ttlSec * 1000), new Date(nowMs)],
    );
    try {
      await this.sms.send(phone, MESSAGES[purpose](code));
    } catch (err) {
      // An undelivered code shouldn't hold the cooldown or stay verifiable.
      await this.pool.query(`DELETE FROM otp_codes WHERE id = $1`, [inserted[0]!.id]);
      throw err;
    }
    return { resendInSec: this.opts.cooldownSec };
  }

  /** Check (and on success consume) the latest code for this phone+purpose. */
  async verify(phone: string, purpose: OtpPurpose, code: string): Promise<OtpCheck> {
    const { rows } = await this.pool.query<{ id: string; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
      `SELECT id, code_hash, attempts, expires_at, consumed_at FROM otp_codes
       WHERE phone = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
      [phone, purpose],
    );
    const row = rows[0];
    if (!row || row.consumed_at || row.expires_at.getTime() <= this.now()) return 'expired';
    if (row.attempts >= this.opts.maxAttempts) return 'locked';

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(this.hash(phone, purpose, String(code).trim()), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await this.pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      return row.attempts + 1 >= this.opts.maxAttempts ? 'locked' : 'invalid';
    }
    // Conditional update: two concurrent correct submissions can't both win.
    const { rowCount } = await this.pool.query(
      `UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
      [row.id],
    );
    return rowCount === 1 ? 'ok' : 'expired';
  }

  private hash(phone: string, purpose: OtpPurpose, code: string): string {
    return createHmac('sha256', this.secret()).update(`${phone}:${purpose}:${code}`).digest('hex');
  }
}
