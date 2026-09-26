import type { Pool } from 'pg';
import { normalizeKePhone } from '@crash/shared/phone';
import type { PlayerGate } from '../http/lobby.js';

export type AccountStatus = 'active' | 'deactivated';

export interface Account {
  playerId: string;
  username: string;
  passwordHash: string;
  phone: string | null;
  currency: string;
  phoneVerifiedAt: string | null;
  tokenVersion: number;
  status: AccountStatus;
  selfExcludedUntil: string | null;
}

interface AccountRow {
  player_id: string;
  username: string;
  password_hash: string;
  phone: string | null;
  currency: string;
  phone_verified_at: Date | null;
  token_version: number;
  account_status: string;
  self_excluded_until: Date | null;
}

const COLUMNS = `player_id, username, password_hash, phone, currency, phone_verified_at, token_version, account_status, self_excluded_until`;

function toAccount(r: AccountRow): Account {
  return {
    playerId: r.player_id,
    username: r.username,
    passwordHash: r.password_hash,
    phone: r.phone,
    currency: r.currency,
    phoneVerifiedAt: r.phone_verified_at?.toISOString() ?? null,
    tokenVersion: r.token_version,
    status: r.account_status as AccountStatus,
    selfExcludedUntil: r.self_excluded_until?.toISOString() ?? null,
  };
}

export class PhoneTakenError extends Error {
  constructor() {
    super('an account with this phone number already exists');
    this.name = 'PhoneTakenError';
  }
}

/** Account identity + security state for phone-number (SimBet) sign-in. */
export class AccountsRepo {
  constructor(private readonly pool: Pool) {}

  async getById(playerId: string): Promise<Account | null> {
    const { rows } = await this.pool.query<AccountRow>(`SELECT ${COLUMNS} FROM players WHERE player_id = $1`, [playerId]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  /**
   * The account for an E.164 phone: a SimBet account (username = phone) wins;
   * otherwise a Game Hub account whose stored phone normalises to it, if that
   * match is unique. Returns 'ambiguous' when several legacy accounts share it.
   */
  async findByPhone(phoneE164: string): Promise<Account | 'ambiguous' | null> {
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT ${COLUMNS} FROM players
       WHERE username = $1 OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = $2`,
      [phoneE164, phoneE164.slice(-9)],
    );
    const accounts = rows.map(toAccount);
    const own = accounts.find((a) => a.username === phoneE164);
    if (own) return own;
    const legacy = accounts.filter((a) => a.phone && normalizeKePhone(a.phone) === phoneE164);
    if (legacy.length > 1) return 'ambiguous';
    return legacy[0] ?? null;
  }

  async createPhoneAccount(phoneE164: string, passwordHash: string): Promise<Account> {
    if (await this.findByPhone(phoneE164)) throw new PhoneTakenError();
    try {
      const { rows } = await this.pool.query<AccountRow>(
        `INSERT INTO players (username, password_hash, currency, phone, country)
         VALUES ($1, $2, 'KES', $1, 'KE') RETURNING ${COLUMNS}`,
        [phoneE164, passwordHash],
      );
      return toAccount(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new PhoneTakenError();
      throw err;
    }
  }

  /** Re-registering an unverified number replaces its password (the old one was never proven). */
  async replaceUnverifiedPassword(playerId: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE players SET password_hash = $2 WHERE player_id = $1 AND phone_verified_at IS NULL`,
      [playerId, passwordHash],
    );
  }

  async markPhoneVerified(playerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE players SET phone_verified_at = coalesce(phone_verified_at, now()) WHERE player_id = $1`,
      [playerId],
    );
  }

  /** New password, signs out every existing session. Returns the new token version. */
  async setPassword(playerId: string, passwordHash: string): Promise<number> {
    return this.bump(playerId, `password_hash = $2`, [passwordHash]);
  }

  async selfExclude(playerId: string, until: Date): Promise<number> {
    return this.bump(playerId, `self_excluded_until = $2`, [until]);
  }

  async deactivate(playerId: string, reason: string): Promise<number> {
    return this.bump(playerId, `account_status = 'deactivated', deactivation_reason = $2`, [reason]);
  }

  /** Reactivation proves phone ownership (OTP) and sets a fresh password. */
  async reactivate(playerId: string, passwordHash: string): Promise<number> {
    return this.bump(
      playerId,
      `account_status = 'active', deactivation_reason = NULL, password_hash = $2, phone_verified_at = coalesce(phone_verified_at, now())`,
      [passwordHash],
    );
  }

  private async bump(playerId: string, set: string, params: unknown[]): Promise<number> {
    const { rows } = await this.pool.query<{ token_version: number }>(
      `UPDATE players SET ${set}, token_version = token_version + 1 WHERE player_id = $1 RETURNING token_version`,
      [playerId, ...params],
    );
    if (!rows[0]) throw new Error(`player ${playerId} not found`);
    return rows[0].token_version;
  }
}

export type AccountBlock =
  | { code: 'ACCOUNT_DEACTIVATED'; message: string }
  | { code: 'SELF_EXCLUDED'; message: string; until: string };

/** Why this account may not sign in or play right now, if anything. */
export function accountBlock(acct: Account, nowMs = Date.now()): AccountBlock | null {
  if (acct.status === 'deactivated') {
    return { code: 'ACCOUNT_DEACTIVATED', message: 'This account is deactivated. Reactivate it to continue.' };
  }
  if (acct.selfExcludedUntil && Date.parse(acct.selfExcludedUntil) > nowMs) {
    return { code: 'SELF_EXCLUDED', message: 'You are self-excluded until the date shown.', until: acct.selfExcludedUntil };
  }
  return null;
}

export function makePlayerGate(repo: AccountsRepo, now: () => number = Date.now): PlayerGate {
  return async (playerId, tokenVersion) => {
    const acct = await repo.getById(playerId);
    if (!acct) return { ok: false, status: 401, code: 'INVALID_JWT', message: 'account not found' };
    if (tokenVersion !== acct.tokenVersion) {
      return { ok: false, status: 401, code: 'SESSION_REVOKED', message: 'Your session has ended — please log in again.' };
    }
    const block = accountBlock(acct, now());
    if (block) return { ok: false, status: 403, ...block };
    return { ok: true };
  };
}
