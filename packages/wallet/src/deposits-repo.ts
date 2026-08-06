import type { Pool } from './pg.js';

// ---------------------------------------------------------------------------
// Deposits repository (Maplerad pay-in, Phase 1).
//
// Backed by the Postgres `deposits` table (bootstrapped in pg.ts):
//   reference text pk, player_id uuid, currency text, amount_minor bigint,
//   status text ('pending'|'settled'|'failed'), created_at, updated_at
//
// A pending row is created when a Maplerad collection is started; the signed
// webhook (Task 8) settles or fails it. `markSettled` is the idempotency
// gate — it only flips a *pending* row, so a replayed webhook event is a
// harmless no-op (returns false on the second call).
// ---------------------------------------------------------------------------

export type DepositStatus = 'pending' | 'settled' | 'failed';

export interface Deposit {
  playerId: string;
  currency: string;
  amountMinor: number;
  status: DepositStatus;
}

interface DepositRow {
  player_id: string;
  currency: string;
  amount_minor: string | number;
  status: DepositStatus;
}

function rowToDeposit(row: DepositRow): Deposit {
  return {
    playerId: row.player_id,
    currency: row.currency,
    // bigint arrives as a string from pg — parse to a JS number (minor units).
    amountMinor: Number(row.amount_minor),
    status: row.status,
  };
}

export class PgDepositsRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Insert a new pending deposit. */
  async createPending(input: { reference: string; playerId: string; currency: string; amountMinor: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO deposits (reference, player_id, currency, amount_minor, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [input.reference, input.playerId, input.currency, input.amountMinor],
    );
  }

  /**
   * Flip a pending deposit to settled. Idempotent: only a row still in
   * 'pending' is updated, so replays return false instead of double-crediting.
   */
  async markSettled(reference: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE deposits SET status = 'settled', updated_at = now() WHERE reference = $1 AND status = 'pending'`,
      [reference],
    );
    return rowCount === 1;
  }

  /** Flip a pending deposit to failed. */
  async markFailed(reference: string): Promise<void> {
    await this.pool.query(
      `UPDATE deposits SET status = 'failed', updated_at = now() WHERE reference = $1 AND status = 'pending'`,
      [reference],
    );
  }

  /** Fetch a deposit by reference, or null if unknown. */
  async get(reference: string): Promise<Deposit | null> {
    const { rows } = await this.pool.query<DepositRow>(
      `SELECT player_id, currency, amount_minor, status FROM deposits WHERE reference = $1`,
      [reference],
    );
    return rows[0] ? rowToDeposit(rows[0]) : null;
  }
}
