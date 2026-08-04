import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { PgGamesRepo } from './games-repo-pg.js';
import {
  DuplicateGameIdError,
  GameNotFoundError,
  InvalidGameError,
} from './games-repo.js';
import type { GameCreate } from './types.js';

function makeGame(override: Partial<GameCreate> = {}): GameCreate {
  return {
    gameId: 'galaxy-crash',
    name: 'Galaxy Crash',
    gameType: 'sprite',
    rtp: 0.97,
    theme: { gameType: 'sprite', name: 'default' },
    ...override,
  };
}

describe('GamesRepo — games', () => {
  let testDb: TestDb;
  let repo: PgGamesRepo;
  beforeEach(async () => {
    testDb = await makeTestDb();
    repo = new PgGamesRepo(testDb.pool);
  });
  afterEach(async () => { await testDb.cleanup(); });

  it('create + getById round-trips all fields', async () => {
    await repo.create(makeGame());
    const g = (await repo.getById('galaxy-crash'))!;
    expect(g.name).toBe('Galaxy Crash');
    expect(g.gameType).toBe('sprite');
    expect(g.rtp).toBe(0.97);
    expect(g.status).toBe('active');
    expect(g.theme).toEqual({ gameType: 'sprite', name: 'default' });
  });

  it('getById returns null for unknown', async () => {
    expect(await repo.getById('nope')).toBeNull();
  });

  it('duplicate gameId throws', async () => {
    await repo.create(makeGame());
    await expect(repo.create(makeGame())).rejects.toThrow(DuplicateGameIdError);
  });

  it('rejects rtp outside (0,1]', async () => {
    await expect(repo.create(makeGame({ rtp: 97 }))).rejects.toThrow(InvalidGameError);
    await expect(repo.create(makeGame({ rtp: 0 }))).rejects.toThrow(InvalidGameError);
    await expect(repo.create(makeGame({ rtp: 1 }))).resolves.toBeDefined();
  });

  it('rejects unknown gameType', async () => {
    await expect(repo.create(makeGame({ gameType: 'video' as never }))).rejects.toThrow(InvalidGameError);
  });

  it('rejects gameType that disagrees with theme.gameType', async () => {
    await expect(
      repo.create(makeGame({ gameType: 'gif', theme: { gameType: 'sprite' } })),
    ).rejects.toThrow(InvalidGameError);
  });

  it('accepts gif game whose theme declares gif', async () => {
    await expect(
      repo.create(makeGame({ gameId: 'cosmic-jet', gameType: 'gif', theme: { gameType: 'gif' } })),
    ).resolves.toBeDefined();
  });

  it('list hides archived unless asked', async () => {
    await repo.create(makeGame());
    await repo.create(makeGame({ gameId: 'cosmic-jet', gameType: 'gif', theme: { gameType: 'gif' } }));
    await repo.update('cosmic-jet', { status: 'archived' });
    expect((await repo.list()).map((g) => g.gameId)).toEqual(['galaxy-crash']);
    expect((await repo.list({ includeArchived: true })).length).toBe(2);
  });

  it('update on unknown game throws', async () => {
    await expect(repo.update('nope', { name: 'x' })).rejects.toThrow(GameNotFoundError);
  });

  // Regression: a game created by ANOTHER process (a Creator on a different
  // backend, a second replica, a direct DB insert) is invisible to this repo's
  // in-memory snapshot until refreshSnapshot() re-reads Postgres. The server
  // polls refreshSnapshot() so the round loop picks such games up without a restart.
  it('snapshot only sees out-of-band games after refreshSnapshot', async () => {
    const other = new PgGamesRepo(testDb.pool); // simulates a second process
    await repo.create(makeGame()); // created via `repo`, refreshes only repo's snapshot

    // `other` never handled the mutation → its snapshot is still empty.
    await other.refreshSnapshot(); // prime once (as at boot)
    // Insert a second game via `repo`; `other` doesn't know yet.
    await repo.create(makeGame({ gameId: 'cosmic-jet', gameType: 'gif', theme: { gameType: 'gif' } }));
    expect(other.snapshot().map((g) => g.gameId)).toEqual(['galaxy-crash']); // stale

    await other.refreshSnapshot(); // the periodic poll
    expect(other.snapshot().map((g) => g.gameId).sort()).toEqual(['cosmic-jet', 'galaxy-crash']);
  });

  it('update revalidates rtp and type↔theme', async () => {
    await repo.create(makeGame());
    await expect(repo.update('galaxy-crash', { rtp: 2 })).rejects.toThrow(InvalidGameError);
    await expect(repo.update('galaxy-crash', { gameType: 'gif' })).rejects.toThrow(InvalidGameError);
  });
});

describe('GamesRepo — operator_games + effectiveRtp', () => {
  let testDb: TestDb;
  let repo: PgGamesRepo;
  beforeEach(async () => {
    testDb = await makeTestDb();
    repo = new PgGamesRepo(testDb.pool);
    await repo.create(makeGame({ rtp: 0.97 }));
  });
  afterEach(async () => { await testDb.cleanup(); });

  it('default-deny: no row ⇒ effectiveRtp null', async () => {
    expect(await repo.effectiveRtp('acme', 'galaxy-crash')).toBeNull();
  });

  it('enabled row inherits game rtp', async () => {
    await repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true });
    expect(await repo.effectiveRtp('acme', 'galaxy-crash')).toBe(0.97);
  });

  it('rtpOverride wins over game rtp', async () => {
    await repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true, rtpOverride: 0.95 });
    expect(await repo.effectiveRtp('acme', 'galaxy-crash')).toBe(0.95);
  });

  it('disabled ⇒ null even with override', async () => {
    await repo.setOperatorGame('acme', 'galaxy-crash', { enabled: false, rtpOverride: 0.95 });
    expect(await repo.effectiveRtp('acme', 'galaxy-crash')).toBeNull();
  });

  it('archived game ⇒ null even if enabled', async () => {
    await repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true });
    await repo.update('galaxy-crash', { status: 'archived' });
    expect(await repo.effectiveRtp('acme', 'galaxy-crash')).toBeNull();
  });

  it('upsert preserves untouched fields', async () => {
    await repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true, rtpOverride: 0.9 });
    await repo.setOperatorGame('acme', 'galaxy-crash', { enabled: false }); // no rtpOverride passed
    const link = (await repo.getOperatorGame('acme', 'galaxy-crash'))!;
    expect(link.enabled).toBe(false);
    expect(link.rtpOverride).toBe(0.9);
  });

  it('rejects invalid rtpOverride', async () => {
    await expect(
      repo.setOperatorGame('acme', 'galaxy-crash', { rtpOverride: 97 }),
    ).rejects.toThrow(InvalidGameError);
  });
});
