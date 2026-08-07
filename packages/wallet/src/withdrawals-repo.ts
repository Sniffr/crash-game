import type { Pool } from './pg.js';

// ---------------------------------------------------------------------------
// Withdrawals repository (Maplerad payout, Phase 2).
//
// Mirrors the deposits repo, backed by the Postgres `withdrawals` table:
//   reference text pk, player_id uuid, currency text, amount_minor bigint,
//   maplerad_id text, status ('pending'|'settled'|'failed'), created_at, updated_at
//
// Flow: a pending row is created and the wallet is DEBITED (reserved) when a
// withdrawal is requested; the Maplerad transfer id is stored for webhook
// correlation (the transfer webhook may not echo our reference). The signed
// `transfer.successful`/`transfer.failed` webhook finalises the row —
// `markSettled` on success, `markFailed` + refund on failure. Both are
// idempotency gates (CAS on a *pending* row), so replayed events are no-ops.
// ---------------------------------------------------------------------------

export type WithdrawalStatus = 'pending' | 'settled' | 'failed';

export interface Withdrawal {
  reference: string;
  playerId: string;
  currency: string;
  amountMinor: number;
  mapleradId: string | null;
  status: WithdrawalStatus;
}

interface WithdrawalRow {
  reference: string;
  player_id: string;
  currency: string;
  amount_minor: string | number;
  maplerad_id: string | null;
  status: WithdrawalStatus;
}

function rowToWithdrawal(row: WithdrawalRow): Withdrawal {
  return {
    reference: row.reference,
    playerId: row.player_id,
    currency: row.currency,
    // bigint arrives as a string from pg — parse to a JS number (minor units).
    amountMinor: Number(row.amount_minor),
    mapleradId: row.maplerad_id,
    status: row.status,
  };
}

const SELECT = `SELECT reference, player_id, currency, amount_minor, maplerad_id, status FROM withdrawals`;

export class PgWithdrawalsRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Insert a new pending withdrawal (funds are reserved separately by the caller). */
  async createPending(input: { reference: string; playerId: string; currency: string; amountMinor: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO withdrawals (reference, player_id, currency, amount_minor, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [input.reference, input.playerId, input.currency, input.amountMinor],
    );
  }

  /** Record the Maplerad transfer id once the disbursement has been initiated. */
  async setMapleradId(reference: string, mapleradId: string): Promise<void> {
    await this.pool.query(
      `UPDATE withdrawals SET maplerad_id = $2, updated_at = now() WHERE reference = $1`,
      [reference, mapleradId],
    );
  }

  /**
   * Flip a pending withdrawal to settled. Idempotent: only a row still in
   * 'pending' is updated, so replays return false.
   */
  async markSettled(reference: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE withdrawals SET status = 'settled', updated_at = now() WHERE reference = $1 AND status = 'pending'`,
      [reference],
    );
    return rowCount === 1;
  }

  /**
   * Flip a pending withdrawal to failed. Idempotent: returns true only on the
   * first pending→failed transition, so the caller refunds exactly once.
   */
  async markFailed(reference: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE withdrawals SET status = 'failed', updated_at = now() WHERE reference = $1 AND status = 'pending'`,
      [reference],
    );
    return rowCount === 1;
  }

  /** Fetch a withdrawal by reference, or null if unknown. */
  async get(reference: string): Promise<Withdrawal | null> {
    const { rows } = await this.pool.query<WithdrawalRow>(`${SELECT} WHERE reference = $1`, [reference]);
    return rows[0] ? rowToWithdrawal(rows[0]) : null;
  }

  /** Fetch a withdrawal by its Maplerad transfer id (webhook correlation), or null. */
  async getByMapleradId(mapleradId: string): Promise<Withdrawal | null> {
    const { rows } = await this.pool.query<WithdrawalRow>(`${SELECT} WHERE maplerad_id = $1`, [mapleradId]);
    return rows[0] ? rowToWithdrawal(rows[0]) : null;
  }
}
