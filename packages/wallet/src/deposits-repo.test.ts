import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { PlayersRepo } from './players-repo.js';
import { PgDepositsRepo } from './deposits-repo.js';

// Isolated throwaway Postgres schema per file — never touches the real casino DB.
let db: TestDb;
let players: PlayersRepo;
let repo: PgDepositsRepo;
let playerId: string;

beforeAll(async () => {
  db = await makeTestDb();
  players = new PlayersRepo(db.pool);
  repo = new PgDepositsRepo(db.pool);
  const player = await players.create(`t_${randomUUID()}`, 'hash', { currency: 'KES', phone: '254700000000' });
  playerId = player.playerId;
});
afterAll(async () => { await db.cleanup(); }); // drops the whole schema — no per-row cleanup needed

describe('PgDepositsRepo', () => {
  it('markSettled flips pending→settled once (idempotent)', async () => {
    const reference = `game-dep-${playerId}-a`;
    await repo.createPending({ reference, playerId, currency: 'KES', amountMinor: 5000 });

    const before = await repo.get(reference);
    expect(before).toEqual({ playerId, currency: 'KES', amountMinor: 5000, status: 'pending' });

    expect(await repo.markSettled(reference)).toBe(true);
    const after = await repo.get(reference);
    expect(after?.status).toBe('settled');

    // already settled — second call is a no-op and reports false.
    expect(await repo.markSettled(reference)).toBe(false);
  });

  it('markFailed sets status to failed', async () => {
    const reference = `game-dep-${playerId}-b`;
    await repo.createPending({ reference, playerId, currency: 'KES', amountMinor: 1000 });
    await repo.markFailed(reference);
    const after = await repo.get(reference);
    expect(after?.status).toBe('failed');
  });

  it('get returns null for an unknown reference', async () => {
    expect(await repo.get(`game-dep-${playerId}-missing`)).toBeNull();
  });
});
