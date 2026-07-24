import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  GamesRepo,
  DuplicateGameIdError,
  GameNotFoundError,
  InvalidGameError,
} from './games-repo.js';
import type { GameCreate } from './types.js';

function makeRepo() {
  return new GamesRepo(new Database(':memory:'));
}

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
  let repo: GamesRepo;
  beforeEach(() => { repo = makeRepo(); });

  it('create + getById round-trips all fields', () => {
    repo.create(makeGame());
    const g = repo.getById('galaxy-crash')!;
    expect(g.name).toBe('Galaxy Crash');
    expect(g.gameType).toBe('sprite');
    expect(g.rtp).toBe(0.97);
    expect(g.status).toBe('active');
    expect(g.theme).toEqual({ gameType: 'sprite', name: 'default' });
  });

  it('getById returns null for unknown', () => {
    expect(repo.getById('nope')).toBeNull();
  });

  it('duplicate gameId throws', () => {
    repo.create(makeGame());
    expect(() => repo.create(makeGame())).toThrow(DuplicateGameIdError);
  });

  it('rejects rtp outside (0,1]', () => {
    expect(() => repo.create(makeGame({ rtp: 97 }))).toThrow(InvalidGameError);
    expect(() => repo.create(makeGame({ rtp: 0 }))).toThrow(InvalidGameError);
    expect(() => repo.create(makeGame({ rtp: 1 }))).not.toThrow();
  });

  it('rejects unknown gameType', () => {
    expect(() => repo.create(makeGame({ gameType: 'video' as never }))).toThrow(InvalidGameError);
  });

  it('rejects gameType that disagrees with theme.gameType', () => {
    expect(() =>
      repo.create(makeGame({ gameType: 'gif', theme: { gameType: 'sprite' } })),
    ).toThrow(InvalidGameError);
  });

  it('accepts gif game whose theme declares gif', () => {
    expect(() =>
      repo.create(makeGame({ gameId: 'cosmic-jet', gameType: 'gif', theme: { gameType: 'gif' } })),
    ).not.toThrow();
  });

  it('list hides archived unless asked', () => {
    repo.create(makeGame());
    repo.create(makeGame({ gameId: 'cosmic-jet', gameType: 'gif', theme: { gameType: 'gif' } }));
    repo.update('cosmic-jet', { status: 'archived' });
    expect(repo.list().map((g) => g.gameId)).toEqual(['galaxy-crash']);
    expect(repo.list({ includeArchived: true }).length).toBe(2);
  });

  it('update on unknown game throws', () => {
    expect(() => repo.update('nope', { name: 'x' })).toThrow(GameNotFoundError);
  });

  it('update revalidates rtp and type↔theme', () => {
    repo.create(makeGame());
    expect(() => repo.update('galaxy-crash', { rtp: 2 })).toThrow(InvalidGameError);
    expect(() => repo.update('galaxy-crash', { gameType: 'gif' })).toThrow(InvalidGameError);
  });
});

describe('GamesRepo — operator_games + effectiveRtp', () => {
  let repo: GamesRepo;
  beforeEach(() => {
    repo = makeRepo();
    repo.create(makeGame({ rtp: 0.97 }));
  });

  it('default-deny: no row ⇒ effectiveRtp null', () => {
    expect(repo.effectiveRtp('acme', 'galaxy-crash')).toBeNull();
  });

  it('enabled row inherits game rtp', () => {
    repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true });
    expect(repo.effectiveRtp('acme', 'galaxy-crash')).toBe(0.97);
  });

  it('rtpOverride wins over game rtp', () => {
    repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true, rtpOverride: 0.95 });
    expect(repo.effectiveRtp('acme', 'galaxy-crash')).toBe(0.95);
  });

  it('disabled ⇒ null even with override', () => {
    repo.setOperatorGame('acme', 'galaxy-crash', { enabled: false, rtpOverride: 0.95 });
    expect(repo.effectiveRtp('acme', 'galaxy-crash')).toBeNull();
  });

  it('archived game ⇒ null even if enabled', () => {
    repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true });
    repo.update('galaxy-crash', { status: 'archived' });
    expect(repo.effectiveRtp('acme', 'galaxy-crash')).toBeNull();
  });

  it('upsert preserves untouched fields', () => {
    repo.setOperatorGame('acme', 'galaxy-crash', { enabled: true, rtpOverride: 0.9 });
    repo.setOperatorGame('acme', 'galaxy-crash', { enabled: false }); // no rtpOverride passed
    const link = repo.getOperatorGame('acme', 'galaxy-crash')!;
    expect(link.enabled).toBe(false);
    expect(link.rtpOverride).toBe(0.9);
  });

  it('rejects invalid rtpOverride', () => {
    expect(() =>
      repo.setOperatorGame('acme', 'galaxy-crash', { rtpOverride: 97 }),
    ).toThrow(InvalidGameError);
  });
});
