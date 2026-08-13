import { describe, it, expect } from 'vitest';
import {
  impliedFrom1x2,
  fitGoalRates,
  scoreGrid,
  outcomeProbs,
  marketCatalogue,
  findOutcome,
  outcomeProbability,
  priceMarkets,
} from './football';

describe('implied probabilities', () => {
  it('strips the margin so probabilities sum to 1', () => {
    const { probs, overround } = impliedFrom1x2({ home: 2.55, draw: 3.6, away: 2.6 });
    expect(probs.home + probs.draw + probs.away).toBeCloseTo(1, 10);
    expect(overround).toBeGreaterThan(1);
  });

  it('reports a fair book as ~1.0 overround', () => {
    // 1/4 + 1/4 + 1/2 = 1 exactly.
    const { overround } = impliedFrom1x2({ home: 4, draw: 4, away: 2 });
    expect(overround).toBeCloseTo(1, 10);
  });

  it('ranks a short favourite above the outsider', () => {
    const { probs } = impliedFrom1x2({ home: 1.2, draw: 6, away: 12 });
    expect(probs.home).toBeGreaterThan(probs.draw);
    expect(probs.draw).toBeGreaterThan(probs.away);
  });
});

describe('score grid', () => {
  it('is a normalised distribution', () => {
    const grid = scoreGrid({ home: 1.6, away: 1.2 });
    const total = grid.flat().reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(grid.flat().every((p) => p >= 0)).toBe(true);
  });

  it('shifts mass toward the stronger side', () => {
    const strongHome = outcomeProbs(scoreGrid({ home: 2.4, away: 0.7 }));
    const strongAway = outcomeProbs(scoreGrid({ home: 0.7, away: 2.4 }));
    expect(strongHome.home).toBeGreaterThan(strongHome.away);
    expect(strongAway.away).toBeGreaterThan(strongAway.home);
  });

  it('is symmetric when both sides are equal', () => {
    const p = outcomeProbs(scoreGrid({ home: 1.3, away: 1.3 }));
    expect(p.home).toBeCloseTo(p.away, 9);
  });
});

describe('fitting goal rates to 1x2', () => {
  const books = [
    { home: 2.55, draw: 3.6, away: 2.6 },
    { home: 1.2, draw: 6.5, away: 13 },
    { home: 4.5, draw: 3.7, away: 1.8 },
    { home: 2.05, draw: 3.3, away: 3.7 },
    { home: 1.35, draw: 5.25, away: 7.5 },
  ];

  for (const book of books) {
    // 0.002 is ~6x the worst error the fit actually produces (0.00035 across
    // these books). Loose enough not to be brittle, tight enough that a real
    // regression in the grid search fails instead of sliding under a 3pp bar.
    it(`reproduces ${book.home}/${book.draw}/${book.away} within 0.2pp`, () => {
      const target = impliedFrom1x2(book).probs;
      const rates = fitGoalRates(target);
      const got = outcomeProbs(scoreGrid(rates));
      expect(Math.abs(got.home - target.home)).toBeLessThan(0.002);
      expect(Math.abs(got.draw - target.draw)).toBeLessThan(0.002);
      expect(Math.abs(got.away - target.away)).toBeLessThan(0.002);
    });
  }

  it('is deterministic', () => {
    const a = fitGoalRates(impliedFrom1x2({ home: 2.1, draw: 3.4, away: 3.35 }).probs);
    const b = fitGoalRates(impliedFrom1x2({ home: 2.1, draw: 3.4, away: 3.35 }).probs);
    expect(a).toEqual(b);
  });

  it('gives the favourite the higher goal rate', () => {
    const rates = fitGoalRates(impliedFrom1x2({ home: 1.3, draw: 5.5, away: 9 }).probs);
    expect(rates.home).toBeGreaterThan(rates.away);
  });
});

describe('market catalogue', () => {
  it('has mutually exclusive, exhaustive outcomes per market', () => {
    const grid = scoreGrid({ home: 1.5, away: 1.2 });
    for (const group of marketCatalogue()) {
      // Double chance is the deliberate exception: 1X / 12 / X2 each cover two
      // of the three results, so their probabilities sum to 2, not 1.
      if (group.market === 'double_chance') continue;
      const total = group.outcomes.reduce(
        (acc, o) => acc + outcomeProbability(grid, o),
        0,
      );
      expect(total, `${group.market} should partition the space`).toBeCloseTo(1, 6);
    }
  });

  it('double chance covers exactly two thirds of the outcome space', () => {
    const grid = scoreGrid({ home: 1.5, away: 1.2 });
    const dc = marketCatalogue().find((g) => g.market === 'double_chance')!;
    const total = dc.outcomes.reduce((acc, o) => acc + outcomeProbability(grid, o), 0);
    expect(total).toBeCloseTo(2, 6);
  });

  it('settles 1x2 from the scoreline', () => {
    expect(findOutcome('1x2', 'home')!.settles({ home: 3, away: 2 })).toBe(true);
    expect(findOutcome('1x2', 'draw')!.settles({ home: 2, away: 2 })).toBe(true);
    expect(findOutcome('1x2', 'away')!.settles({ home: 0, away: 1 })).toBe(true);
    expect(findOutcome('1x2', 'home')!.settles({ home: 1, away: 1 })).toBe(false);
  });

  it('settles over/under and BTTS from the scoreline', () => {
    expect(findOutcome('over_under_2_5', 'over')!.settles({ home: 3, away: 2 })).toBe(true);
    expect(findOutcome('over_under_2_5', 'under')!.settles({ home: 1, away: 1 })).toBe(true);
    expect(findOutcome('btts', 'yes')!.settles({ home: 3, away: 2 })).toBe(true);
    expect(findOutcome('btts', 'yes')!.settles({ home: 3, away: 0 })).toBe(false);
    expect(findOutcome('btts', 'no')!.settles({ home: 3, away: 0 })).toBe(true);
  });

  it('settles double chance and correct score', () => {
    expect(findOutcome('double_chance', 'home_draw')!.settles({ home: 1, away: 1 })).toBe(true);
    expect(findOutcome('double_chance', 'home_away')!.settles({ home: 1, away: 1 })).toBe(false);
    expect(findOutcome('correct_score', '3_2')!.settles({ home: 3, away: 2 })).toBe(true);
    expect(findOutcome('correct_score', 'other')!.settles({ home: 5, away: 1 })).toBe(true);
  });

  it('has no pushable line (every total settles one way)', () => {
    for (const group of marketCatalogue()) {
      if (!group.market.startsWith('over_under')) continue;
      for (let total = 0; total <= 9; total++) {
        const score = { home: total, away: 0 };
        const hits = group.outcomes.filter((o) => o.settles(score)).length;
        expect(hits, `${group.market} at ${total} goals`).toBe(1);
      }
    }
  });
});

describe('pricing', () => {
  it('prices every catalogue outcome above 1', () => {
    const rates = fitGoalRates(impliedFrom1x2({ home: 2.55, draw: 3.6, away: 2.6 }).probs);
    for (const m of priceMarkets(rates, 1.06)) {
      for (const o of m.outcomes) {
        expect(o.odds, `${m.market}/${o.pick}`).toBeGreaterThan(1);
        expect(Number.isFinite(o.odds)).toBe(true);
      }
    }
  });

  it('passes through the real 1x2 odds when given them', () => {
    const real = { home: 2.55, draw: 3.6, away: 2.6 };
    const priced = priceMarkets(fitGoalRates(impliedFrom1x2(real).probs), 1.06, { real1x2: real });
    const m = priced.find((x) => x.market === '1x2')!;
    expect(m.outcomes.find((o) => o.pick === 'home')!.odds).toBe(2.55);
    expect(m.outcomes.find((o) => o.pick === 'draw')!.odds).toBe(3.6);
    expect(m.outcomes.find((o) => o.pick === 'away')!.odds).toBe(2.6);
  });

  it('applies the margin — derived prices sit below fair value', () => {
    const rates = { home: 1.4, away: 1.4 };
    const grid = scoreGrid(rates);
    const fair = priceMarkets(rates, 1.0);
    const juiced = priceMarkets(rates, 1.1);
    const pick = (ms: ReturnType<typeof priceMarkets>) =>
      ms.find((m) => m.market === 'btts')!.outcomes.find((o) => o.pick === 'yes')!;
    expect(pick(juiced).odds).toBeLessThan(pick(fair).odds);
    // and the fair price really is 1/p, to within priceMarkets' own 2dp
    // rounding (half-step 0.005) — the only error that should be present here.
    const p = outcomeProbability(grid, findOutcome('btts', 'yes')!);
    expect(Math.abs(pick(fair).odds - 1 / p)).toBeLessThan(0.006);
  });

  it('makes long shots long and favourites short', () => {
    const rates = fitGoalRates(impliedFrom1x2({ home: 1.2, draw: 6.5, away: 13 }).probs);
    const priced = priceMarkets(rates, 1.05);
    const cs = priced.find((m) => m.market === 'correct_score')!;
    const nilNil = cs.outcomes.find((o) => o.pick === '0_0')!;
    const threeNil = cs.outcomes.find((o) => o.pick === '3_0')!;
    // A heavy favourite should be likelier to win 3-0 than to draw 0-0.
    expect(threeNil.odds).toBeLessThan(nilNil.odds);
  });
});
