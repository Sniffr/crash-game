import type { Pool, PoolClient } from './pg.js';

// ---------------------------------------------------------------------------
// Wallet ledger (Wave A — personal lobby).
//
// Append-only double-entry-style ledger backed by the Postgres `wallet_ledger`
// table (bootstrapped in pg.ts). Balance = SUM(amount_minor) per (player, currency).
//   - deposit / win : positive rows (credit)
//   - bet           : negative rows (debit) — guarded against overdraw
//
// All amounts are in MINOR units (e.g. cents) and must be positive integers on
// the way in; the sign is applied internally.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class InsufficientFundsError extends Error {
  readonly playerId: string;
  readonly balanceMinor: number;
  readonly requestedMinor: number;
  constructor(playerId: string, balanceMinor: number, requestedMinor: number) {
    super(`Insufficient funds: balance ${balanceMinor} < requested ${requestedMinor}`);
    this.name = 'InsufficientFundsError';
    this.playerId = playerId;
    this.balanceMinor = balanceMinor;
    this.requestedMinor = requestedMinor;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertPositiveInt(amountMinor: number, label: string): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`${label} must be a positive integer (minor units), got ${amountMinor}`);
  }
}

// ---------------------------------------------------------------------------
// WalletLedger
// ---------------------------------------------------------------------------

export class WalletLedger {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Current balance (minor units) = SUM(amount_minor) for the player+currency. */
  async balance(playerId: string, currency = 'KES'): Promise<number> {
    const { rows } = await this.pool.query<{ balance: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS balance
       FROM wallet_ledger WHERE player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    // bigint arrives as a string from pg — parse to a JS number (minor units).
    return Number(rows[0]?.balance ?? 0);
  }

  /** Compute balance on an in-transaction client (after the advisory lock). */
  private async balanceOnClient(client: PoolClient, playerId: string, currency: string): Promise<number> {
    const { rows } = await client.query<{ balance: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS balance
       FROM wallet_ledger WHERE player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  /**
   * Credit a deposit (top-up). Returns the new balance.
   *
   * Idempotent on `ref` (partial unique index `uq_wallet_deposit_ref`): a
   * replayed webhook with the same reference is a no-op credit, so crediting
   * can run BEFORE the deposit row is marked settled without ever
   * double-crediting — closing the crash window between the two writes.
   */
  async deposit(playerId: string, amountMinor: number, currency = 'KES', ref: string | null = null): Promise<number> {
    assertPositiveInt(amountMinor, 'amountMinor');
    await this.pool.query(
      `INSERT INTO wallet_ledger (player_id, currency, amount_minor, kind, ref)
       VALUES ($1, $2, $3, 'deposit', $4)
       ON CONFLICT (ref) WHERE kind = 'deposit' DO NOTHING`,
      [playerId, currency, amountMinor, ref],
    );
    return this.balance(playerId, currency);
  }

  /**
   * Reserve (debit) funds for a withdrawal, ATOMICALLY and overdraw-guarded —
   * same advisory-lock discipline as `bet`, so two concurrent withdrawals can
   * never both pass the balance check. Idempotent on `ref` (a re-tried withdraw
   * request with the same reference is a no-op, returning the current balance).
   * Throws InsufficientFundsError if balance < amount. Returns the new balance.
   */
  async reserve(playerId: string, amountMinor: number, ref: string, currency = 'KES'): Promise<number> {
    assertPositiveInt(amountMinor, 'amountMinor');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [playerId]);

      // Idempotent: if this reference is already reserved, don't debit twice.
      const existing = await client.query(`SELECT 1 FROM wallet_ledger WHERE ref = $1 AND kind = 'withdraw'`, [ref]);
      if ((existing.rowCount ?? 0) > 0) {
        const bal = await this.balanceOnClient(client, playerId, currency);
        await client.query('COMMIT');
        return bal;
      }

      const bal = await this.balanceOnClient(client, playerId, currency);
      if (bal < amountMinor) {
        await client.query('ROLLBACK');
        throw new InsufficientFundsError(playerId, bal, amountMinor);
      }

      await client.query(
        `INSERT INTO wallet_ledger (player_id, currency, amount_minor, kind, ref)
         VALUES ($1, $2, $3, 'withdraw', $4)`,
        [playerId, currency, -amountMinor, ref],
      );

      await client.query('COMMIT');
      return bal - amountMinor;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Refund a failed withdrawal — credit the reserved amount back. Keyed by the
   * withdrawal's own `ref` and idempotent (partial unique index
   * `uq_wallet_refund_ref`), so a replayed transfer.failed webhook restores the
   * funds exactly once. Returns the new balance.
   */
  async refund(playerId: string, amountMinor: number, ref: string, currency = 'KES'): Promise<number> {
    assertPositiveInt(amountMinor, 'amountMinor');
    await this.pool.query(
      `INSERT INTO wallet_ledger (player_id, currency, amount_minor, kind, ref)
       VALUES ($1, $2, $3, 'refund', $4)
       ON CONFLICT (ref) WHERE kind = 'refund' DO NOTHING`,
      [playerId, currency, amountMinor, ref],
    );
    return this.balance(playerId, currency);
  }

  /**
   * Debit a bet ATOMICALLY. Serialised per player via a transaction-scoped
   * advisory lock so two concurrent bets can never both pass the balance check
   * and overdraw the account. Throws InsufficientFundsError if balance < amount.
   * Returns the new balance.
   */
  async bet(playerId: string, amountMinor: number, ref: string, currency = 'KES'): Promise<number> {
    assertPositiveInt(amountMinor, 'amountMinor');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise all balance-mutating ops for this player within the txn.
      // hashtextextended keeps the full uuid space; hashtext is fine here and
      // matches the requested advisory-lock approach.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [playerId]);

      const bal = await this.balanceOnClient(client, playerId, currency);
      if (bal < amountMinor) {
        await client.query('ROLLBACK');
        throw new InsufficientFundsError(playerId, bal, amountMinor);
      }

      await client.query(
        `INSERT INTO wallet_ledger (player_id, currency, amount_minor, kind, ref)
         VALUES ($1, $2, $3, 'bet', $4)`,
        [playerId, currency, -amountMinor, ref],
      );

      await client.query('COMMIT');
      return bal - amountMinor;
    } catch (err) {
      // Roll back on any error (balance check already rolled back before throwing).
      try {
        await client.query('ROLLBACK');
      } catch {
        // best-effort — the connection may already be in a rolled-back state
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Credit a win. Returns the new balance. */
  async win(playerId: string, amountMinor: number, ref: string, currency = 'KES'): Promise<number> {
    assertPositiveInt(amountMinor, 'amountMinor');
    await this.pool.query(
      `INSERT INTO wallet_ledger (player_id, currency, amount_minor, kind, ref)
       VALUES ($1, $2, $3, 'win', $4)`,
      [playerId, currency, amountMinor, ref],
    );
    return this.balance(playerId, currency);
  }

  /**
   * Manual adjustment (positive or negative). Amount is a signed integer of
   * minor units. Returns the new balance. Not overdraw-guarded — admin use only.
   */
  async adjust(playerId: string, amountMinor: number, ref: string, currency = 'KES'): Promise<number> {
    if (!Number.isInteger(amountMinor) || amountMinor === 0) {
      throw new Error(`amountMinor must be a non-zero integer (minor units), got ${amountMinor}`);
    }
    await this.pool.query(
      `INSERT INTO wallet_ledger (player_id, currency, amount_minor, kind, ref)
       VALUES ($1, $2, $3, 'adjust', $4)`,
      [playerId, currency, amountMinor, ref],
    );
    return this.balance(playerId, currency);
  }
}
