import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { bootstrapCasinoSchema } from './pg.js';
import { PlayersRepo } from './players-repo.js';
import { WalletLedger, InsufficientFundsError } from './wallet-ledger.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let players: PlayersRepo;
let ledger: WalletLedger;

beforeAll(async () => {
  db = await makeTestDb();
  players = new PlayersRepo(db.pool);
  ledger = new WalletLedger(db.pool);
});
afterAll(async () => { await db.cleanup(); }); // drops the whole schema

async function makePlayer(): Promise<string> {
  const p = await players.create(`t_${randomUUID()}`, 'hash');
  return p.playerId;
}

describe('WalletLedger', () => {
  it('starts at zero and credits deposits', async () => {
    const pid = await makePlayer();
    await bootstrapCasinoSchema(db.pool);
    expect(await ledger.balance(pid)).toBe(0);

    expect(await ledger.deposit(pid, 5000)).toBe(5000);
    expect(await ledger.deposit(pid, 2500)).toBe(7500);
    expect(await ledger.balance(pid)).toBe(7500);
  });

  it('I1: deposits with the same reference credit exactly once (idempotent replay/crash-safety)', async () => {
    const pid = await makePlayer();
    const ref = 'game-dep-xyz-1';
    expect(await ledger.deposit(pid, 5000, 'KES', ref)).toBe(5000);
    // Replay the identical credit (webhook retry / crash-then-retry): no-op.
    expect(await ledger.deposit(pid, 5000, 'KES', ref)).toBe(5000);
    expect(await ledger.balance(pid)).toBe(5000);
    // A null ref is never deduped — distinct top-ups still stack.
    await ledger.deposit(pid, 100, 'KES', null);
    await ledger.deposit(pid, 100, 'KES', null);
    expect(await ledger.balance(pid)).toBe(5200);
  });

  it('reserve debits (overdraw-guarded) and is idempotent per reference', async () => {
    const pid = await makePlayer();
    await ledger.deposit(pid, 10_000);
    const ref = 'game-wd-abc-1';

    // Reserves the amount once.
    expect(await ledger.reserve(pid, 4000, ref)).toBe(6000);
    // Re-tried request with the same reference is a no-op (no double debit).
    expect(await ledger.reserve(pid, 4000, ref)).toBe(6000);
    expect(await ledger.balance(pid)).toBe(6000);

    // Overdraw is rejected and leaves the balance untouched.
    await expect(ledger.reserve(pid, 999_999, 'game-wd-abc-2')).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.balance(pid)).toBe(6000);
  });

  it('refund credits back exactly once per reference (idempotent replay)', async () => {
    const pid = await makePlayer();
    await ledger.deposit(pid, 5000);
    const ref = 'game-wd-def-1';
    await ledger.reserve(pid, 5000, ref);
    expect(await ledger.balance(pid)).toBe(0);

    expect(await ledger.refund(pid, 5000, ref)).toBe(5000);
    // Replayed transfer.failed webhook — must not double-refund.
    expect(await ledger.refund(pid, 5000, ref)).toBe(5000);
    expect(await ledger.balance(pid)).toBe(5000);
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
