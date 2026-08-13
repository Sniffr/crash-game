/**
 * Football scoreline model — the bridge between harvested 1x2 odds, the wider
 * market catalogue, and the simulated playthrough.
 *
 * Why a model at all
 * ------------------
 * The harvested feed carries 1x2 prices per fixture (that is all OddsPortal's
 * date listing exposes). Simulate wants two further things:
 *
 *   1. more markets to bet on (over/under, BTTS, correct score, ...), and
 *   2. a concrete scoreline — "3:2" — with a goal-by-goal playthrough.
 *
 * Both are derived from ONE distribution over scorelines, fitted so that its
 * implied home/draw/away probabilities reproduce the real harvested odds. That
 * shared origin is the point: the scoreline shown to the player is drawn from
 * the same grid used to price every market, so a slip that wins "over 2.5"
 * always displays a scoreline with 3+ goals. Pricing markets from an
 * independent source would let the two disagree.
 *
 * The model is independent Poisson goals per side (λ_home, λ_away). It is not
 * a forecasting tool — Simulate's payouts come from the RTP engine, not from
 * these probabilities — it only has to be *plausible and self-consistent*.
 *
 * Fitting: reparametrised as total goals T = λh + λa and supremacy
 * S = λh − λa, then a coarse grid search refined locally. Two free parameters
 * against two independent targets (P(home) − P(away), and P(draw)).
 */

// Scores above this are lumped into the tail; 10 covers ~all realistic games.
const MAX_GOALS = 10;

export interface Odds1x2 {
  home: number;
  draw: number;
  away: number;
}

export interface Probs1x2 {
  home: number;
  draw: number;
  away: number;
}

export interface GoalRates {
  /** Expected home goals. */
  home: number;
  /** Expected away goals. */
  away: number;
}

// ---------------------------------------------------------------------------
// Implied probabilities
// ---------------------------------------------------------------------------

/**
 * Strip the bookmaker margin from 1x2 decimal odds.
 *
 * Returns the normalised probabilities plus the `overround` (sum of raw
 * 1/odds; 1.06 = a 6% book). The overround is reapplied when pricing derived
 * markets so they carry the same margin as the harvested ones.
 */
export function impliedFrom1x2(odds: Odds1x2): { probs: Probs1x2; overround: number } {
  const raw = {
    home: 1 / odds.home,
    draw: 1 / odds.draw,
    away: 1 / odds.away,
  };
  const overround = raw.home + raw.draw + raw.away;
  return {
    probs: {
      home: raw.home / overround,
      draw: raw.draw / overround,
      away: raw.away / overround,
    },
    overround,
  };
}

// ---------------------------------------------------------------------------
// Poisson score grid
// ---------------------------------------------------------------------------

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // exp(-λ) λ^k / k!  — computed in log space for stability at high k.
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Joint distribution over scorelines, `grid[h][a] = P(home h, away a)`.
 *
 * Rows/cols run 0..MAX_GOALS inclusive; the residual tail mass is folded into
 * the final cell so the grid sums to 1.
 */
export function scoreGrid(rates: GoalRates, maxGoals: number = MAX_GOALS): number[][] {
  const h = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(rates.home, k));
  const a = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(rates.away, k));
  const grid: number[][] = [];
  let total = 0;
  for (let i = 0; i <= maxGoals; i++) {
    const row: number[] = [];
    for (let j = 0; j <= maxGoals; j++) {
      const p = h[i]! * a[j]!;
      row.push(p);
      total += p;
    }
    grid.push(row);
  }
  // Renormalise so truncation doesn't leak probability.
  if (total > 0) {
    for (const row of grid) {
      for (let j = 0; j < row.length; j++) row[j] = row[j]! / total;
    }
  }
  return grid;
}

/** Home/draw/away probabilities implied by a score grid. */
export function outcomeProbs(grid: number[][]): Probs1x2 {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i]!.length; j++) {
      const p = grid[i]![j]!;
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  return { home, draw, away };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

function fitError(rates: GoalRates, target: Probs1x2): number {
  const p = outcomeProbs(scoreGrid(rates, 8)); // 8 is plenty while searching
  return (
    (p.home - target.home) ** 2 +
    (p.draw - target.draw) ** 2 +
    (p.away - target.away) ** 2
  );
}

/**
 * Find (λ_home, λ_away) whose Poisson scoreline distribution reproduces
 * `target` home/draw/away probabilities.
 *
 * Coarse grid over total goals T ∈ [0.4, 6.5] and supremacy S ∈ [−3, 3],
 * then three local refinements. Deterministic, and fast enough to run per
 * fixture (callers still cache — see the server's market cache).
 */
export function fitGoalRates(target: Probs1x2): GoalRates {
  let bestT = 2.6;
  let bestS = 0;
  let bestErr = Infinity;

  const evaluate = (T: number, S: number) => {
    // Keep both rates positive; a side is never expected to score < 0.05.
    const home = Math.max(0.05, (T + S) / 2);
    const away = Math.max(0.05, (T - S) / 2);
    const err = fitError({ home, away }, target);
    if (err < bestErr) {
      bestErr = err;
      bestT = T;
      bestS = S;
    }
  };

  for (let ti = 0; ti <= 24; ti++) {
    const T = 0.4 + (6.5 - 0.4) * (ti / 24);
    for (let si = 0; si <= 24; si++) {
      const S = -3 + 6 * (si / 24);
      evaluate(T, S);
    }
  }

  let stepT = (6.5 - 0.4) / 24;
  let stepS = 6 / 24;
  for (let pass = 0; pass < 3; pass++) {
    const centreT = bestT;
    const centreS = bestS;
    for (let ti = -4; ti <= 4; ti++) {
      for (let si = -4; si <= 4; si++) {
        evaluate(
          Math.max(0.2, centreT + (stepT * ti) / 4),
          centreS + (stepS * si) / 4,
        );
      }
    }
    stepT /= 4;
    stepS /= 4;
  }

  return {
    home: Math.max(0.05, (bestT + bestS) / 2),
    away: Math.max(0.05, (bestT - bestS) / 2),
  };
}

// ---------------------------------------------------------------------------
// Market catalogue
// ---------------------------------------------------------------------------

export interface Score {
  home: number;
  away: number;
}

export interface MarketOutcome {
  /** Market token, e.g. '1x2', 'over_under_2_5'. */
  market: string;
  /** Outcome token within the market, e.g. 'home', 'over'. */
  pick: string;
  /** Short label for the UI button, e.g. '1', 'Over 2.5'. */
  label: string;
  /** True iff this outcome is settled as a win by the given final score. */
  settles: (s: Score) => boolean;
}

export interface MarketGroup {
  market: string;
  /** Human name for the UI, e.g. 'Match Result'. */
  name: string;
  outcomes: MarketOutcome[];
}

const OVER_UNDER_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];

function lineToken(line: number): string {
  return String(line).replace('.', '_');
}

/**
 * Every market Simulate offers, with the predicate that settles it.
 *
 * Every outcome is a pure function of the FINAL SCORE. That is deliberate: the
 * engine draws a scoreline consistent with the leg's win/loss, so any market
 * expressible this way settles consistently with the playthrough shown. It is
 * also why markets needing more than the final score (first goalscorer,
 * half-time/full-time) are absent — they would need the timeline to be
 * conditioned too, not just the score.
 *
 * All lines are .5 so no outcome can push; a push would refund the stake and
 * break the exact-RTP identity the engine relies on.
 */
export function marketCatalogue(): MarketGroup[] {
  const groups: MarketGroup[] = [
    {
      market: '1x2',
      name: 'Match Result',
      outcomes: [
        { market: '1x2', pick: 'home', label: '1', settles: (s) => s.home > s.away },
        { market: '1x2', pick: 'draw', label: 'X', settles: (s) => s.home === s.away },
        { market: '1x2', pick: 'away', label: '2', settles: (s) => s.home < s.away },
      ],
    },
    {
      market: 'double_chance',
      name: 'Double Chance',
      outcomes: [
        { market: 'double_chance', pick: 'home_draw', label: '1X', settles: (s) => s.home >= s.away },
        { market: 'double_chance', pick: 'home_away', label: '12', settles: (s) => s.home !== s.away },
        { market: 'double_chance', pick: 'draw_away', label: 'X2', settles: (s) => s.home <= s.away },
      ],
    },
    {
      market: 'btts',
      name: 'Both Teams to Score',
      outcomes: [
        { market: 'btts', pick: 'yes', label: 'Yes', settles: (s) => s.home > 0 && s.away > 0 },
        { market: 'btts', pick: 'no', label: 'No', settles: (s) => s.home === 0 || s.away === 0 },
      ],
    },
  ];

  for (const line of OVER_UNDER_LINES) {
    const market = `over_under_${lineToken(line)}`;
    groups.push({
      market,
      name: `Over/Under ${line}`,
      outcomes: [
        { market, pick: 'over', label: `Over ${line}`, settles: (s) => s.home + s.away > line },
        { market, pick: 'under', label: `Under ${line}`, settles: (s) => s.home + s.away < line },
      ],
    });
  }

  groups.push({
    market: 'total_goals',
    name: 'Total Goals',
    outcomes: [
      { market: 'total_goals', pick: '0_1', label: '0-1', settles: (s) => s.home + s.away <= 1 },
      { market: 'total_goals', pick: '2_3', label: '2-3', settles: (s) => { const t = s.home + s.away; return t >= 2 && t <= 3; } },
      { market: 'total_goals', pick: '4_6', label: '4-6', settles: (s) => { const t = s.home + s.away; return t >= 4 && t <= 6; } },
      { market: 'total_goals', pick: '7_plus', label: '7+', settles: (s) => s.home + s.away >= 7 },
    ],
  });

  // Correct score up to 3-3, plus an "any other" catch-all so the market's
  // outcomes are exhaustive and mutually exclusive.
  const csOutcomes: MarketOutcome[] = [];
  for (let h = 0; h <= 3; h++) {
    for (let a = 0; a <= 3; a++) {
      csOutcomes.push({
        market: 'correct_score',
        pick: `${h}_${a}`,
        label: `${h}-${a}`,
        settles: (s) => s.home === h && s.away === a,
      });
    }
  }
  csOutcomes.push({
    market: 'correct_score',
    pick: 'other',
    label: 'Any other',
    settles: (s) => s.home > 3 || s.away > 3,
  });
  groups.push({ market: 'correct_score', name: 'Correct Score', outcomes: csOutcomes });

  return groups;
}

// The catalogue is stateless, so build it once. Rebuilding all ~41 outcomes per
// lookup dominated simulateSlip, which calls findOutcome once per leg.
const CATALOGUE = marketCatalogue();
const INDEX = new Map<string, MarketOutcome>(
  CATALOGUE.flatMap((g) => g.outcomes.map((o) => [`${g.market}:${o.pick}`, o] as const)),
);

/** Look up a single outcome's settle predicate. */
export function findOutcome(market: string, pick: string): MarketOutcome | null {
  return INDEX.get(`${market}:${pick}`) ?? null;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Probability an outcome settles, under a score grid. */
export function outcomeProbability(grid: number[][], outcome: MarketOutcome): number {
  let p = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i]!.length; j++) {
      if (outcome.settles({ home: i, away: j })) p += grid[i]![j]!;
    }
  }
  return p;
}

export interface PricedOutcome {
  market: string;
  pick: string;
  label: string;
  odds: number;
  /** Fair (margin-free) probability, exposed for audit. */
  probability: number;
}

export interface PricedMarket {
  market: string;
  name: string;
  outcomes: PricedOutcome[];
}

/** Hard bounds so a near-impossible outcome can't produce absurd odds. */
const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;

/**
 * Price the whole catalogue from fitted goal rates.
 *
 * `overround` is the margin carried over from the harvested 1x2 book, applied
 * per-market so derived prices sit on the same commercial footing as the real
 * ones (a fair 2.00 shown at ~1.92 in a 6% book).
 */
export function priceMarkets(
  rates: GoalRates,
  overround: number,
  opts: { real1x2?: Odds1x2 } = {},
): PricedMarket[] {
  const grid = scoreGrid(rates);
  // Never shrink prices; a book below 1 would pay out above fair value.
  const margin = Math.max(1, overround);

  return CATALOGUE.map((group) => ({
    market: group.market,
    name: group.name,
    outcomes: group.outcomes.map((o) => {
      const probability = outcomeProbability(grid, o);
      // Prefer the genuinely harvested prices for 1x2 over the model's.
      if (group.market === '1x2' && opts.real1x2) {
        const real =
          o.pick === 'home' ? opts.real1x2.home
          : o.pick === 'draw' ? opts.real1x2.draw
          : opts.real1x2.away;
        return { market: o.market, pick: o.pick, label: o.label, odds: real, probability };
      }
      const odds = probability <= 0
        ? MAX_ODDS
        : Math.min(MAX_ODDS, Math.max(MIN_ODDS, 1 / (probability * margin)));
      return {
        market: o.market,
        pick: o.pick,
        label: o.label,
        odds: Math.round(odds * 100) / 100,
        probability,
      };
    }),
  }));
}
