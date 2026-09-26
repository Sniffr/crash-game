import { describe, it, expect } from 'vitest';
import {
  BUDGET_TENTHS,
  SQUAD_SIZE,
  squadIssues,
  squadPoints,
  rankByPoints,
  splitPool,
  payouts,
  type Position,
  type SquadPlayer,
  type SquadPick,
} from './fantasy';

// A cheap, legal 4-4-2 across 11 different clubs: ids 1..11.
const FORMATION: Position[] = ['GKP', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD'];

function pool(overrides: Partial<Record<number, Partial<SquadPlayer>>> = {}, extra: SquadPlayer[] = []): Map<number, SquadPlayer> {
  const m = new Map<number, SquadPlayer>();
  FORMATION.forEach((position, i) => {
    const id = i + 1;
    m.set(id, { id, position, teamId: id, cost: 50, ...overrides[id] });
  });
  for (const p of extra) m.set(p.id, p);
  return m;
}

const validPick = (): SquadPick => ({ playerIds: FORMATION.map((_, i) => i + 1), captainId: 10, viceCaptainId: 11 });

describe('squadIssues', () => {
  it('accepts a legal XI', () => {
    expect(squadIssues(validPick(), pool())).toEqual([]);
  });

  it('rejects the wrong number of players', () => {
    const pick = { ...validPick(), playerIds: validPick().playerIds.slice(0, 10) };
    expect(squadIssues(pick, pool()).join(' ')).toContain(`exactly ${SQUAD_SIZE}`);
  });

  it('rejects a duplicate player', () => {
    const ids = validPick().playerIds;
    ids[10] = ids[9]!;
    expect(squadIssues({ ...validPick(), playerIds: ids }, pool()).join(' ')).toContain('only be picked once');
  });

  it('rejects an illegal formation (two goalkeepers)', () => {
    const p = pool({}, [{ id: 99, position: 'GKP', teamId: 99, cost: 40 }]);
    const ids = validPick().playerIds;
    ids[1] = 99; // a DEF replaced by a second GKP
    expect(squadIssues({ ...validPick(), playerIds: ids }, p).join(' ')).toContain('at most 1 GKP');
  });

  it('rejects more than 3 players from one club', () => {
    const p = pool({ 2: { teamId: 1 }, 3: { teamId: 1 }, 4: { teamId: 1 } });
    expect(squadIssues(validPick(), p).join(' ')).toContain('No more than 3');
  });

  it('rejects an over-budget XI', () => {
    const p = pool({ 10: { cost: BUDGET_TENTHS } });
    expect(squadIssues(validPick(), p).join(' ')).toContain('Over budget');
  });

  it('rejects a player missing from the selectable pool', () => {
    const p = pool();
    p.delete(5);
    expect(squadIssues(validPick(), p).join(' ')).toContain('no longer available');
  });

  it('requires captain and vice-captain to be distinct members of the XI', () => {
    expect(squadIssues({ ...validPick(), captainId: 42 }, pool()).join(' ')).toContain('captain from your XI');
    expect(squadIssues({ ...validPick(), viceCaptainId: 10 }, pool()).join(' ')).toContain('must be different');
  });
});

describe('squadPoints', () => {
  const live = (entries: Array<[number, number, number]>) =>
    new Map(entries.map(([id, points, minutes]) => [id, { points, minutes }]));

  it('sums the XI and doubles the captain', () => {
    const pts = squadPoints(validPick(), live([[1, 2, 90], [10, 8, 90], [11, 3, 90]]));
    expect(pts).toBe(2 + 8 + 3 + 8);
  });

  it('doubles the vice-captain when the captain did not play', () => {
    const pts = squadPoints(validPick(), live([[10, 0, 0], [11, 5, 90]]));
    expect(pts).toBe(5 + 5);
  });

  it('treats players with no live data as zero', () => {
    expect(squadPoints(validPick(), new Map())).toBe(0);
  });
});

describe('rankByPoints', () => {
  it('uses competition ranking and keeps input order within ties', () => {
    const r = rankByPoints([
      { key: 'a', points: 10 },
      { key: 'b', points: 30 },
      { key: 'c', points: 10 },
      { key: 'd', points: 5 },
    ]);
    expect(r.map((e) => [e.key, e.rank])).toEqual([['b', 1], ['a', 2], ['c', 2], ['d', 4]]);
  });
});

describe('splitPool', () => {
  it('takes the rake off the top', () => {
    expect(splitPool(50_000, 10, 1000)).toEqual({ poolMinor: 500_000, rakeMinor: 50_000, prizePoolMinor: 450_000 });
  });
});

describe('payouts', () => {
  const BPS = [5000, 3000, 2000];

  it('pays 50/30/20 to the top three', () => {
    const { byKey, dustMinor } = payouts(
      [{ key: 'a', rank: 1 }, { key: 'b', rank: 2 }, { key: 'c', rank: 3 }, { key: 'd', rank: 4 }],
      1000,
      BPS,
    );
    expect([...byKey]).toEqual([['a', 500], ['b', 300], ['c', 200]]);
    expect(dustMinor).toBe(0);
  });

  it('splits the combined shares of tied places', () => {
    const { byKey } = payouts([{ key: 'a', rank: 1 }, { key: 'b', rank: 1 }, { key: 'c', rank: 3 }], 1000, BPS);
    expect(byKey.get('a')).toBe(400);
    expect(byKey.get('b')).toBe(400);
    expect(byKey.get('c')).toBe(200);
  });

  it('splits only the in-range share when a tie straddles the last paid place', () => {
    const { byKey } = payouts(
      [{ key: 'a', rank: 1 }, { key: 'b', rank: 2 }, { key: 'c', rank: 3 }, { key: 'd', rank: 3 }],
      1000,
      BPS,
    );
    expect(byKey.get('c')).toBe(100);
    expect(byKey.get('d')).toBe(100);
  });

  it('redistributes unclaimed places pro rata when there are fewer entrants', () => {
    const { byKey, dustMinor } = payouts([{ key: 'a', rank: 1 }, { key: 'b', rank: 2 }], 800, BPS);
    expect(byKey.get('a')).toBe(500);
    expect(byKey.get('b')).toBe(300);
    expect(dustMinor).toBe(0);
  });

  it('never pays out more than the pool, reporting rounding dust', () => {
    const { byKey, dustMinor } = payouts([{ key: 'a', rank: 1 }, { key: 'b', rank: 1 }, { key: 'c', rank: 1 }], 1001, BPS);
    const paid = [...byKey.values()].reduce((a, v) => a + v, 0);
    expect(paid + dustMinor).toBe(1001);
    expect(dustMinor).toBeGreaterThanOrEqual(0);
  });
});
