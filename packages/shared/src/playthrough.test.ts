import { describe, it, expect } from 'vitest';
import {
  simulateSlip,
  verifySlip,
  drawScore,
  buildTimeline,
  halfTimeFrom,
  generateServerSeed,
  DEFAULT_SIMULATE_CONFIG,
  type Selection,
} from './simulate';
import { findOutcome, fitGoalRates, impliedFrom1x2 } from './football';

const RATES = fitGoalRates(impliedFrom1x2({ home: 2.55, draw: 3.6, away: 2.6 }).probs);

function sel(over: Partial<Selection> = {}): Selection {
  return {
    eventId: 'match-1',
    market: '1x2',
    pick: 'home',
    odds: 2.55,
    goalRates: RATES,
    ...over,
  };
}

describe('scoreline agrees with the leg result', () => {
  // The whole point: a player must never see "you lost" next to a scoreline
  // that shows their pick winning.
  const cases: Array<{ market: string; pick: string; odds: number }> = [
    { market: '1x2', pick: 'home', odds: 2.55 },
    { market: '1x2', pick: 'draw', odds: 3.6 },
    { market: '1x2', pick: 'away', odds: 2.6 },
    { market: 'btts', pick: 'yes', odds: 1.9 },
    { market: 'btts', pick: 'no', odds: 1.95 },
    { market: 'over_under_2_5', pick: 'over', odds: 1.85 },
    { market: 'over_under_2_5', pick: 'under', odds: 2.0 },
    { market: 'double_chance', pick: 'home_draw', odds: 1.45 },
    { market: 'correct_score', pick: '3_2', odds: 28 },
    { market: 'total_goals', pick: '2_3', odds: 2.1 },
  ];

  for (const c of cases) {
    it(`${c.market}/${c.pick} — scoreline always settles the way the leg did`, () => {
      const outcome = findOutcome(c.market, c.pick)!;
      let sawWin = false;
      let sawLoss = false;
      for (let i = 0; i < 400; i++) {
        const seed = generateServerSeed();
        const s = sel(c);
        const res = simulateSlip(seed, `n${i}`, [s]);
        const leg = res.legs[0]!;
        expect(leg.score, 'every score-settled market should produce a score').toBeDefined();
        expect(outcome.settles(leg.score!)).toBe(leg.won);
        if (leg.won) sawWin = true;
        else sawLoss = true;
      }
      // Guard against a vacuous test that only ever exercised one branch.
      expect(sawWin && sawLoss, 'should observe both wins and losses').toBe(true);
    });
  }
});

describe('timeline', () => {
  it('ends on the final score', () => {
    for (let i = 0; i < 200; i++) {
      const res = simulateSlip(generateServerSeed(), `t${i}`, [sel()]);
      const leg = res.legs[0]!;
      const tl = leg.timeline!;
      if (!tl.length) {
        expect(leg.score).toEqual({ home: 0, away: 0 });
        continue;
      }
      expect(tl[tl.length - 1]!.score).toEqual(leg.score);
    }
  });

  it('has one event per goal, in non-decreasing minutes within 1..90', () => {
    for (let i = 0; i < 200; i++) {
      const res = simulateSlip(generateServerSeed(), `m${i}`, [sel()]);
      const leg = res.legs[0]!;
      const tl = leg.timeline!;
      expect(tl.length).toBe(leg.score!.home + leg.score!.away);
      let prev = 0;
      for (const g of tl) {
        expect(g.minute).toBeGreaterThanOrEqual(1);
        expect(g.minute).toBeLessThanOrEqual(90);
        expect(g.minute).toBeGreaterThanOrEqual(prev);
        prev = g.minute;
      }
    }
  });

  it('running score increments by exactly one each goal', () => {
    const res = simulateSlip('seed-fixed', 'nonce-fixed', [sel({ odds: 1.2 })]);
    const tl = res.legs[0]!.timeline!;
    let h = 0;
    let a = 0;
    for (const g of tl) {
      if (g.team === 'home') h += 1;
      else a += 1;
      expect(g.score).toEqual({ home: h, away: a });
    }
  });

  it('half time score never exceeds full time', () => {
    for (let i = 0; i < 150; i++) {
      const res = simulateSlip(generateServerSeed(), `h${i}`, [sel()]);
      const leg = res.legs[0]!;
      expect(leg.halfTimeScore!.home).toBeLessThanOrEqual(leg.score!.home);
      expect(leg.halfTimeScore!.away).toBeLessThanOrEqual(leg.score!.away);
    }
  });

  it('counts only goals up to minute 45 as half time', () => {
    const tl = [
      { minute: 10, team: 'home' as const, score: { home: 1, away: 0 } },
      { minute: 45, team: 'away' as const, score: { home: 1, away: 1 } },
      { minute: 46, team: 'home' as const, score: { home: 2, away: 1 } },
    ];
    expect(halfTimeFrom(tl)).toEqual({ home: 1, away: 1 });
  });
});

describe('determinism and verification', () => {
  it('same seed and nonce reproduce the same scoreline', () => {
    const a = simulateSlip('seed-a', 'nonce-a', [sel()]);
    const b = simulateSlip('seed-a', 'nonce-a', [sel()]);
    expect(a.legs[0]!.score).toEqual(b.legs[0]!.score);
    expect(a.legs[0]!.timeline).toEqual(b.legs[0]!.timeline);
  });

  it('verifySlip accepts an honest playthrough', () => {
    const seed = generateServerSeed();
    const sels = [sel(), sel({ eventId: 'match-2', market: 'btts', pick: 'yes', odds: 1.9 })];
    const res = simulateSlip(seed, 'n', sels);
    expect(verifySlip(seed, res, sels).ok).toBe(true);
  });

  it('verifySlip rejects a doctored scoreline', () => {
    const seed = generateServerSeed();
    const sels = [sel()];
    const res = simulateSlip(seed, 'n', sels);
    const tampered = {
      ...res,
      legs: [{ ...res.legs[0]!, score: { home: 9, away: 0 } }],
    };
    const v = verifySlip(seed, tampered, sels);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/scoreline/);
  });

  it('verifySlip rejects a doctored timeline the honest score would hide', () => {
    // Fixed seed so the leg is guaranteed more than one goal to cut down to.
    const sels = [sel()];
    const res = simulateSlip('seed-N', 'n', sels);
    const leg = res.legs[0]!;
    const tampered = {
      ...res,
      // Final score left honest — only the playthrough the client renders is faked.
      legs: [{ ...leg, timeline: leg.timeline!.slice(0, 1), halfTimeScore: { home: 9, away: 9 } }],
    };
    const v = verifySlip('seed-N', tampered, sels);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/timeline/);
  });

  it('scores differ across legs of the same slip', () => {
    // Legs are domain-separated by index, so two identical fixtures on one
    // slip must not produce carbon-copy playthroughs.
    const sels = [
      sel({ eventId: 'a' }),
      sel({ eventId: 'b' }),
      sel({ eventId: 'c' }),
      sel({ eventId: 'd' }),
    ];
    const res = simulateSlip('seed-x', 'nonce-x', sels);
    const shapes = new Set(res.legs.map((l) => `${l.score!.home}-${l.score!.away}`));
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('leaves legs without goal rates still playable', () => {
    const s = sel({ goalRates: undefined });
    const res = simulateSlip('seed-y', 'nonce-y', [s]);
    expect(res.legs[0]!.score).toBeDefined(); // falls back to default rates
  });

  it('produces no scoreline for a market it cannot settle', () => {
    const s = sel({ market: 'first_goalscorer', pick: 'someone' });
    const res = simulateSlip('seed-z', 'nonce-z', [s]);
    expect(res.legs[0]!.score).toBeUndefined();
    expect(res.legs[0]!.won).toBeTypeOf('boolean'); // still settles normally
  });
});

describe('RTP is unaffected by the playthrough', () => {
  // The scoreline is drawn AFTER win/loss, so it must not move the payout.
  const N = 60_000;

  for (const rtp of [0.95, 0.97]) {
    it(`single leg still returns ≈ ${rtp}`, () => {
      const config = { ...DEFAULT_SIMULATE_CONFIG, rtp };
      let staked = 0;
      let returned = 0;
      for (let i = 0; i < N; i++) {
        const s = sel({ odds: 2.5 });
        const res = simulateSlip(`seed-${i}`, `n-${i}`, [s], config);
        staked += 1;
        returned += res.payoutMultiplier;
      }
      expect(returned / staked).toBeCloseTo(rtp, 1);
    });
  }

  it('two-leg accumulator still returns ≈ RTP', () => {
    let staked = 0;
    let returned = 0;
    for (let i = 0; i < N; i++) {
      const sels = [
        sel({ eventId: 'a', odds: 1.96 }),
        sel({ eventId: 'b', market: 'btts', pick: 'yes', odds: 2.4 }),
      ];
      const res = simulateSlip(`s-${i}`, `n-${i}`, sels);
      staked += 1;
      returned += res.payoutMultiplier;
    }
    expect(returned / staked).toBeCloseTo(0.95, 1);
  });
});

describe('drawScore edge cases', () => {
  it('returns null for an unknown market', () => {
    expect(drawScore('s', 'n', 0, sel({ market: 'nope' }), true)).toBeNull();
  });

  it('produces an empty timeline for 0-0', () => {
    expect(buildTimeline('s', 'n', 0, { home: 0, away: 0 })).toEqual([]);
  });
});
