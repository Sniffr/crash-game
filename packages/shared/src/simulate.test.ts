import { describe, it, expect } from 'vitest';
import {
  simulateSlip,
  verifySlip,
  combinedOdds,
  assertValidSlip,
  legUniform,
  generateServerSeed,
  commitSeed,
  InvalidSlipError,
  DEFAULT_SIMULATE_CONFIG,
  type Selection,
  type SimulateConfig,
} from './simulate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Empirically measure RTP for a fixed slip shape by replaying it across many
 * nonces under one seed and averaging the realised payout multiplier.
 *
 *     RTP = E[ payoutMultiplier ] = P(win) · combinedOdds
 *
 * For a correctly-built resolver this converges to `config.rtp` regardless of
 * the odds or the number of legs.
 */
function measureRtp(selections: Selection[], rounds: number, config: SimulateConfig): number {
  const seed = 'fixed-seed-for-rtp-measurement-000000000000000000000000000000';
  let totalReturn = 0;
  for (let i = 0; i < rounds; i++) {
    const r = simulateSlip(seed, String(i), selections, config);
    totalReturn += r.payoutMultiplier;
  }
  return totalReturn / rounds;
}

const sel = (eventId: string, pick: string, odds: number): Selection => ({
  eventId,
  market: '1x2',
  pick,
  odds,
});

// ---------------------------------------------------------------------------
// Determinism & fairness
// ---------------------------------------------------------------------------

describe('simulateSlip — determinism', () => {
  it('is deterministic in (seed, nonce, selections)', () => {
    const seed = generateServerSeed();
    const slip = [sel('e1', 'home', 1.96), sel('e2', 'away', 2.4)];
    const a = simulateSlip(seed, '7', slip);
    const b = simulateSlip(seed, '7', slip);
    expect(a).toEqual(b);
  });

  it('changes outcome when the nonce changes (different draws)', () => {
    const seed = generateServerSeed();
    const slip = [sel('e1', 'home', 1.5)];
    const outcomes = new Set<boolean>();
    for (let i = 0; i < 50; i++) outcomes.add(simulateSlip(seed, String(i), slip).won);
    // With p≈0.63 over 50 draws we expect BOTH wins and losses to appear.
    expect(outcomes.has(true)).toBe(true);
    expect(outcomes.has(false)).toBe(true);
  });

  it('legUniform stays within [0,1)', () => {
    const seed = generateServerSeed();
    for (let i = 0; i < 100; i++) {
      const u = legUniform(seed, String(i), 0, sel('e1', 'home', 2));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// RTP convergence — the core guarantee
// ---------------------------------------------------------------------------

describe('simulateSlip — RTP', () => {
  const ROUNDS = 40_000;

  it('single-leg slip returns ≈ RTP for a range of odds', () => {
    const config = { ...DEFAULT_SIMULATE_CONFIG, rtp: 0.95 };
    for (const odds of [1.2, 1.96, 3.5, 10]) {
      const rtp = measureRtp([sel('e1', 'home', odds)], ROUNDS, config);
      expect(rtp).toBeGreaterThan(0.90);
      expect(rtp).toBeLessThan(1.00);
    }
  });

  it('two-leg accumulator returns ≈ RTP', () => {
    const config = { ...DEFAULT_SIMULATE_CONFIG, rtp: 0.95 };
    const rtp = measureRtp([sel('e1', 'home', 1.96), sel('e2', 'away', 2.4)], ROUNDS, config);
    expect(rtp).toBeGreaterThan(0.88);
    expect(rtp).toBeLessThan(1.02);
  });

  it('three-leg accumulator returns ≈ RTP', () => {
    const config = { ...DEFAULT_SIMULATE_CONFIG, rtp: 0.95 };
    const rtp = measureRtp(
      [sel('e1', 'home', 1.8), sel('e2', 'draw', 3.4), sel('e3', 'away', 2.1)],
      ROUNDS,
      config,
    );
    expect(rtp).toBeGreaterThan(0.85);
    expect(rtp).toBeLessThan(1.05);
  });

  it('honours a different configured RTP (0.85)', () => {
    const config = { ...DEFAULT_SIMULATE_CONFIG, rtp: 0.85 };
    const rtp = measureRtp([sel('e1', 'home', 2.0)], ROUNDS, config);
    expect(rtp).toBeGreaterThan(0.80);
    expect(rtp).toBeLessThan(0.90);
  });
});

// ---------------------------------------------------------------------------
// Combined odds & payout
// ---------------------------------------------------------------------------

describe('combinedOdds & payout', () => {
  it('multiplies leg odds', () => {
    expect(combinedOdds([sel('e1', 'home', 2), sel('e2', 'away', 3)])).toBeCloseTo(6);
  });

  it('caps at maxCombinedOdds', () => {
    const config = { ...DEFAULT_SIMULATE_CONFIG, maxCombinedOdds: 10 };
    expect(combinedOdds([sel('e1', 'home', 5), sel('e2', 'away', 5)], config)).toBe(10);
  });

  it('payoutMultiplier is 0 on a loss, combinedOdds on a win', () => {
    const seed = generateServerSeed();
    const slip = [sel('e1', 'home', 2), sel('e2', 'away', 3)];
    for (let i = 0; i < 30; i++) {
      const r = simulateSlip(seed, String(i), slip);
      if (r.won) expect(r.payoutMultiplier).toBeCloseTo(6);
      else expect(r.payoutMultiplier).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe('verifySlip', () => {
  it('verifies a legitimately reported slip', () => {
    const seed = generateServerSeed();
    const slip = [sel('e1', 'home', 1.9), sel('e2', 'draw', 3.2)];
    const result = simulateSlip(seed, '42', slip);
    expect(verifySlip(seed, result, slip).ok).toBe(true);
  });

  it('rejects a tampered seed', () => {
    const seed = generateServerSeed();
    const slip = [sel('e1', 'home', 1.9)];
    const result = simulateSlip(seed, '42', slip);
    const v = verifySlip(generateServerSeed(), result, slip);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/committed hash/);
  });

  it('rejects a forged win', () => {
    const seed = generateServerSeed();
    const slip = [sel('e1', 'home', 1.9)];
    const result = simulateSlip(seed, '42', slip);
    const forged = { ...result, won: !result.won, payoutMultiplier: result.won ? 0 : result.combinedOdds };
    expect(verifySlip(seed, forged, slip).ok).toBe(false);
  });

  it('commit matches sha256(seed)', () => {
    const seed = generateServerSeed();
    const result = simulateSlip(seed, '1', [sel('e1', 'home', 2)]);
    expect(result.commit).toBe(commitSeed(seed));
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('assertValidSlip', () => {
  it('rejects an empty slip', () => {
    expect(() => assertValidSlip([])).toThrow(InvalidSlipError);
  });

  it('rejects odds <= 1', () => {
    expect(() => assertValidSlip([sel('e1', 'home', 1)])).toThrow(/odds must be/);
  });

  it('rejects duplicate events on one slip', () => {
    expect(() => assertValidSlip([sel('e1', 'home', 2), sel('e1', 'away', 2)])).toThrow(/duplicate event/);
  });

  it('rejects too many legs', () => {
    const cfg = { ...DEFAULT_SIMULATE_CONFIG, maxLegs: 2 };
    expect(() => assertValidSlip([sel('a', 'h', 2), sel('b', 'h', 2), sel('c', 'h', 2)], cfg)).toThrow(/legs/);
  });

  it('rejects an out-of-range rtp', () => {
    const cfg = { ...DEFAULT_SIMULATE_CONFIG, rtp: 1.5 };
    expect(() => assertValidSlip([sel('a', 'h', 2)], cfg)).toThrow(/rtp/);
  });
});
