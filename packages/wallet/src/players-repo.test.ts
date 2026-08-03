import { config } from 'dotenv';
config({ path: '../../.env' });

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { getPool, bootstrapCasinoSchema } from './pg.js';
import { PlayersRepo, DuplicateUsernameError } from './players-repo.js';

const pool = getPool();
const repo = new PlayersRepo(pool);

// Track our own rows for cleanup — NEVER truncate (shared DB).
const createdPlayerIds: string[] = [];

afterAll(async () => {
  for (const id of createdPlayerIds) {
    await pool.query('DELETE FROM wallet_ledger WHERE player_id = $1', [id]);
    await pool.query('DELETE FROM players WHERE player_id = $1', [id]);
  }
  await pool.end();
});

describe('PlayersRepo', () => {
  it('bootstraps schema idempotently', async () => {
    await bootstrapCasinoSchema(pool);
    await bootstrapCasinoSchema(pool);
  });

  it('creates a player and reads it back by username and id', async () => {
    const username = `t_${randomUUID()}`;
    const player = await repo.create(username, 'hash-abc');
    createdPlayerIds.push(player.playerId);

    expect(player.username).toBe(username);
    expect(typeof player.playerId).toBe('string');
    expect(typeof player.createdAt).toBe('string');
    // Public shape must NOT leak the hash.
    expect((player as Record<string, unknown>)['passwordHash']).toBeUndefined();

    const byUsername = await repo.getByUsername(username);
    expect(byUsername?.playerId).toBe(player.playerId);
    expect((byUsername as Record<string, unknown> | null)?.['passwordHash']).toBeUndefined();

    const byId = await repo.getById(player.playerId);
    expect(byId?.username).toBe(username);
  });

  it('returns the hash only via getByUsernameWithHash', async () => {
    const username = `t_${randomUUID()}`;
    const player = await repo.create(username, 'secret-hash');
    createdPlayerIds.push(player.playerId);

    const withHash = await repo.getByUsernameWithHash(username);
    expect(withHash?.passwordHash).toBe('secret-hash');
  });

  it('returns null for a missing username / id', async () => {
    expect(await repo.getByUsername(`t_${randomUUID()}`)).toBeNull();
    expect(await repo.getById(randomUUID())).toBeNull();
  });

  it('throws DuplicateUsernameError on a duplicate username', async () => {
    const username = `t_${randomUUID()}`;
    const player = await repo.create(username, 'hash-1');
    createdPlayerIds.push(player.playerId);

    await expect(repo.create(username, 'hash-2')).rejects.toBeInstanceOf(DuplicateUsernameError);
  });
});
