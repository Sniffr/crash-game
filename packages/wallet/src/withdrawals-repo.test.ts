import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { PlayersRepo } from './players-repo.js';
import { PgWithdrawalsRepo } from './withdrawals-repo.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let players: PlayersRepo;
let repo: PgWithdrawalsRepo;
let playerId: string;

beforeAll(async () => {
  db = await makeTestDb();
  players = new PlayersRepo(db.pool);
  repo = new PgWithdrawalsRepo(db.pool);
  const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES', phone: '254700000000' });
  playerId = player.playerId;
});
afterAll(async () => { await db.cleanup(); });

describe('PgWithdrawalsRepo', () => {
  it('markSettled flips pending→settled once (idempotent)', async () => {
    const reference = `game-wd-${playerId}-a`;
    await repo.createPending({ reference, playerId, currency: 'KES', amountMinor: 5000 });
    expect(await repo.get(reference)).toEqual({ reference, playerId, currency: 'KES', amountMinor: 5000, mapleradId: null, status: 'pending' });

    expect(await repo.markSettled(reference)).toBe(true);
    expect(await repo.markSettled(reference)).toBe(false);
    expect((await repo.get(reference))?.status).toBe('settled');
  });

  it('markFailed flips pending→failed once (idempotent — caller refunds exactly once)', async () => {
    const reference = `game-wd-${playerId}-b`;
    await repo.createPending({ reference, playerId, currency: 'KES', amountMinor: 3000 });

    expect(await repo.markFailed(reference)).toBe(true);
    expect(await repo.markFailed(reference)).toBe(false);
    expect((await repo.get(reference))?.status).toBe('failed');
  });

  it('correlates by Maplerad transfer id (webhook may not echo our reference)', async () => {
    const reference = `game-wd-${playerId}-c`;
    await repo.createPending({ reference, playerId, currency: 'KES', amountMinor: 1500 });
    await repo.setMapleradId(reference, 'tx-777');

    const wd = await repo.getByMapleradId('tx-777');
    expect(wd?.reference).toBe(reference);
    expect(wd?.mapleradId).toBe('tx-777');
    expect(await repo.getByMapleradId('nope')).toBeNull();
  });

  it('get returns null for an unknown reference', async () => {
    expect(await repo.get('game-wd-unknown')).toBeNull();
  });
});
