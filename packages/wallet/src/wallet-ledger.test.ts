import { config } from 'dotenv';
config({ path: '../../.env' });

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { getPool, bootstrapCasinoSchema } from './pg.js';
import { PlayersRepo } from './players-repo.js';
import { WalletLedger, InsufficientFundsError } from './wallet-ledger.js';

const pool = getPool();
const players = new PlayersRepo(pool);
const ledger = new WalletLedger(pool);

const createdPlayerIds: string[] = [];

async function makePlayer(): Promise<string> {
  const p = await players.create(`t_${randomUUID()}`, 'hash');
  createdPlayerIds.push(p.playerId);
  return p.playerId;
}

afterAll(async () => {
  for (const id of createdPlayerIds) {
    await pool.query('DELETE FROM wallet_ledger WHERE player_id = $1', [id]);
    await pool.query('DELETE FROM players WHERE player_id = $1', [id]);
  }
  await pool.end();
});

describe('WalletLedger', () => {
  it('starts at zero and credits deposits', async () => {
    const pid = await makePlayer();
    await bootstrapCasinoSchema(pool);
    expect(await ledger.balance(pid)).toBe(0);

    expect(await ledger.deposit(pid, 5000)).toBe(5000);
    expect(await ledger.deposit(pid, 2500)).toBe(7500);
    expect(await ledger.balance(pid)).toBe(7500);
  });

  it('bet reduces balance and win increases it', async () => {
    const pid = await makePlayer();
    await ledger.deposit(pid, 10_000);

    expect(await ledger.bet(pid, 3000, 'round-1')).toBe(7000);
    expect(await ledger.balance(pid)).toBe(7000);

    expect(await ledger.win(pid, 4500, 'round-1')).toBe(11_500);
    expect(await ledger.balance(pid)).toBe(11_500);
  });

  it('rejects a bet beyond the balance with InsufficientFundsError', async () => {
    const pid = await makePlayer();
    await ledger.deposit(pid, 1000);

    await expect(ledger.bet(pid, 5000, 'over')).rejects.toBeInstanceOf(InsufficientFundsError);
    // Balance unchanged after the rejected bet.
    expect(await ledger.balance(pid)).toBe(1000);
  });

  it('rejects non-positive / non-integer amounts', async () => {
    const pid = await makePlayer();
    await expect(ledger.deposit(pid, 0)).rejects.toThrow();
    await expect(ledger.deposit(pid, -100)).rejects.toThrow();
    await expect(ledger.deposit(pid, 1.5)).rejects.toThrow();
    await expect(ledger.bet(pid, -100, 'x')).rejects.toThrow();
  });

  it('serialises concurrent bets — advisory lock prevents overdraw', async () => {
    const pid = await makePlayer();
    await ledger.deposit(pid, 5000);

    // Two concurrent bets of 4000 each: together 8000 > 5000, so exactly one
    // must succeed and one must throw InsufficientFundsError.
    const results = await Promise.allSettled([
      ledger.bet(pid, 4000, 'concurrent-a'),
      ledger.bet(pid, 4000, 'concurrent-b'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);

    // Exactly one 4000 debit applied.
    expect(await ledger.balance(pid)).toBe(1000);
  });
});
