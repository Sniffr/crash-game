import { randomUUID } from 'node:crypto';
import type { Pool } from './pg.js';
import type { WalletLedger } from './wallet-ledger.js';

// ---------------------------------------------------------------------------
// Withdrawals (money out). Lifecycle:
//   pending    — funds debited, payout not yet accepted by the provider
//   processing — provider accepted the payout, waiting for its final status
//   success    — paid out
//   failed     — not paid; funds credited back (exactly once)
// ---------------------------------------------------------------------------

export type WithdrawalStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface Withdrawal {
  reference: string;
  playerId: string;
  currency: string;
  amountMinor: number;
  phone: string;
  provider: string;
  providerTxnId: string | null;
  status: WithdrawalStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  reference: string;
  player_id: string;
  currency: string;
  amount_minor: string;
  phone: string;
  provider: string;
  provider_txn_id: string | null;
  status: string;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function toWithdrawal(r: Row): Withdrawal {
  return {
    reference: r.reference,
    playerId: r.player_id,
    currency: r.currency,
    amountMinor: Number(r.amount_minor),
    phone: r.phone,
    provider: r.provider,
    providerTxnId: r.provider_txn_id,
    status: r.status as WithdrawalStatus,
    failureReason: r.failure_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export const WITHDRAWAL_REF_PREFIX = 'game-wd-';

export class PgWithdrawalsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly wallet: WalletLedger,
  ) {}

  /** Debit the funds and record a pending withdrawal, atomically. Throws InsufficientFundsError. */
  async request(input: { playerId: string; currency: string; amountMinor: number; phone: string; provider: string }): Promise<{ withdrawal: Withdrawal; balanceMinor: number }> {
    const reference = `${WITHDRAWAL_REF_PREFIX}${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const balanceMinor = await this.wallet.debitInTx(client, input.playerId, input.amountMinor, reference, input.currency, 'withdrawal');
      const { rows } = await client.query<Row>(
        `INSERT INTO withdrawals (reference, player_id, currency, amount_minor, phone, provider)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [reference, input.playerId, input.currency, input.amountMinor, input.phone, input.provider],
      );
      await client.query('COMMIT');
      return { withdrawal: toWithdrawal(rows[0]!), balanceMinor };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already aborted */ });
      throw err;
    } finally {
      client.release();
    }
  }

  async get(reference: string): Promise<Withdrawal | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM withdrawals WHERE reference = $1`, [reference]);
    return rows[0] ? toWithdrawal(rows[0]) : null;
  }

  /** Provider accepted the payout. Only moves forward from pending. */
  async markProcessing(reference: string, providerTxnId: string | null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE withdrawals SET status = 'processing', provider_txn_id = coalesce($2, provider_txn_id), updated_at = now()
       WHERE reference = $1 AND status = 'pending'`,
      [reference, providerTxnId],
    );
    return rowCount === 1;
  }

  /** Paid out. Returns false if it was already final. */
  async markSucceeded(reference: string, providerTxnId: string | null = null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE withdrawals SET status = 'success', provider_txn_id = coalesce($2, provider_txn_id), updated_at = now()
       WHERE reference = $1 AND status IN ('pending','processing')`,
      [reference, providerTxnId],
    );
    return rowCount === 1;
  }

  /**
   * Not paid: mark failed and return the funds, in one transaction. The status
   * guard makes this exactly-once — a repeated failure event refunds nothing.
   */
  async failAndRefund(reference: string, reason: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `UPDATE withdrawals SET status = 'failed', failure_reason = $2, updated_at = now()
         WHERE reference = $1 AND status IN ('pending','processing') RETURNING *`,
        [reference, reason.slice(0, 500)],
      );
      const w = rows[0];
      if (w) {
        await this.wallet.creditInTx(client, w.player_id, Number(w.amount_minor), 'adjust', `wd-refund:${reference}`, w.currency);
      }
      await client.query('COMMIT');
      return !!w;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already aborted */ });
      throw err;
    } finally {
      client.release();
    }
  }

  async list(statuses: WithdrawalStatus[], limit = 100): Promise<Withdrawal[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM withdrawals WHERE status = ANY($1) ORDER BY created_at DESC LIMIT $2`,
      [statuses, limit],
    );
    return rows.map(toWithdrawal);
  }

  /** Non-final withdrawals untouched for at least `olderThanMs` — the reconciliation queue. */
  async listUnsettled(olderThanMs: number, nowMs = Date.now()): Promise<Withdrawal[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM withdrawals WHERE status IN ('pending','processing') AND updated_at <= $1 ORDER BY updated_at ASC LIMIT 200`,
      [new Date(nowMs - olderThanMs)],
    );
    return rows.map(toWithdrawal);
  }
}
