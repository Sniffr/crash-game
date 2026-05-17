import { describe, it, expect } from "vitest";
import {
  crashPointFor,
  generateServerSeed,
  commitSeed,
  verifyCommit,
  buildCommit,
  buildReveal,
  verifyRound,
  DEFAULT_CONFIG,
  type RngConfig,
} from "../src/rng";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Measure RTP empirically.
 *
 * RTP is NOT the mean of the crash point — that quantity has infinite mean
 * for a pure 1/u tail and is dominated by extreme outliers under truncation.
 *
 * RTP is the expected payout per unit staked under a FIXED cashout strategy:
 * a player who always cashes out at target multiplier m receives m if the
 * round survives to m, and 0 otherwise. So:
 *
 *     RTP(m) = m * P(crashPoint >= m)
 *
 * For a correctly-built distribution this is independent of m (for m > 1)
 * and equals the configured rtp.
 *
 * We average across several cashout targets to reduce sampling noise.
 */
function simulateRtp(
  rounds: number,
  config: RngConfig,
  seed = "0000000000000000000000000000000000000000000000000000000000000000",
): number {
  const targets = [1.5, 2.0, 3.0, 5.0];
  let totalPayout = 0;
  let totalStaked = 0;
  for (let i = 0; i < rounds; i++) {
    const cp = crashPointFor(seed, i, config);
    for (const m of targets) {
      totalStaked += 1;
      if (cp >= m) totalPayout += m;
    }
  }
  return totalPayout / totalStaked;
}

/** Fraction of rounds whose crash point meets the predicate. */
function fractionWhere(
  rounds: number,
  predicate: (cp: number) => boolean,
  config: RngConfig,
  seed = "1111111111111111111111111111111111111111111111111111111111111111",
): number {
  let hits = 0;
  for (let i = 0; i < rounds; i++) {
    if (predicate(crashPointFor(seed, i, config))) hits++;
  }
  return hits / rounds;
}

// ---------------------------------------------------------------------------
// 1. Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same seed + round = same crash point, every call", () => {
    const seed = generateServerSeed();
    const a = crashPointFor(seed, 42);
    const b = crashPointFor(seed, 42);
    const c = crashPointFor(seed, 42);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("different rounds produce diverse crash points", () => {
    const seed = generateServerSeed();
    const values = new Set<number>();
    for (let i = 0; i < 1000; i++) values.add(crashPointFor(seed, i));
    // ~4% of rounds are 1.00x and many cluster in 1.01–1.99, so we expect
    // hundreds of distinct values but not 1000. Anything above 300 confirms
    // the seed is actually driving variation.
    expect(values.size).toBeGreaterThan(300);
  });

  it("different seeds produce different sequences", () => {
    const s1 = generateServerSeed();
    const s2 = generateServerSeed();
    expect(s1).not.toBe(s2);
    expect(crashPointFor(s1, 0)).not.toBe(crashPointFor(s2, 0));
  });
});

// ---------------------------------------------------------------------------
// 2. Distribution / RTP correctness — the most important tests
// ---------------------------------------------------------------------------

describe("RTP — the configurable knob", () => {
  // RTP is measured as E[payout] / E[stake] under a fixed-cashout strategy.
  // See simulateRtp() for why.

  it("rtp = 0.97 → measured RTP ≈ 0.97 (±0.01)", () => {
    const measured = simulateRtp(250_000, {
      rtp: 0.97,
      maxMultiplier: 10_000,
    });
    expect(measured).toBeGreaterThan(0.96);
    expect(measured).toBeLessThan(0.98);
  });

  it("rtp = 0.90 → measured RTP ≈ 0.90 (±0.01)", () => {
    const measured = simulateRtp(250_000, {
      rtp: 0.9,
      maxMultiplier: 10_000,
    });
    expect(measured).toBeGreaterThan(0.89);
    expect(measured).toBeLessThan(0.91);
  });

  it("rtp = 0.99 → measured RTP ≈ 0.99 (±0.01)", () => {
    const measured = simulateRtp(250_000, {
      rtp: 0.99,
      maxMultiplier: 10_000,
    });
    expect(measured).toBeGreaterThan(0.98);
    expect(measured).toBeLessThan(1.0);
  });

  it("changing rtp changes the measured RTP monotonically", () => {
    const low = simulateRtp(100_000, { rtp: 0.85, maxMultiplier: 10_000 });
    const high = simulateRtp(100_000, { rtp: 0.99, maxMultiplier: 10_000 });
    expect(high).toBeGreaterThan(low);
    // And the gap should be roughly the rtp gap (proves it's the knob, not noise)
    expect(high - low).toBeGreaterThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// 3. Tail behavior — sanity check on the shape of the distribution
// ---------------------------------------------------------------------------

describe("distribution shape", () => {
  const config: RngConfig = { rtp: 0.97, maxMultiplier: 10_000 };

  it("P(crash = 1.00x) ≈ 1 - rtp/1.01 (the house edge, ±15%)", () => {
    // Quantization makes any round with raw < 2.00 collapse to 1.00x.
    // raw = 100r/(1-u) < 2.00 ⇔ u < 1 - 50r. For r=0.97: ≈ 0.0396.
    const p = fractionWhere(500_000, (cp) => cp === 1.0, config);
    const expected = 1 - config.rtp / 1.01;
    expect(p).toBeGreaterThan(expected * 0.9);
    expect(p).toBeLessThan(expected * 1.1);
  });

  it("P(crash ≥ m) ≈ rtp/m for every target m (the RTP property)", () => {
    for (const m of [1.5, 2, 3, 5, 10, 50]) {
      const p = fractionWhere(300_000, (cp) => cp >= m, config);
      const expected = config.rtp / m;
      // Tighter band for common targets, looser for the rare tail.
      const tolerance = m >= 10 ? 0.2 : 0.08;
      expect(p).toBeGreaterThan(expected * (1 - tolerance));
      expect(p).toBeLessThan(expected * (1 + tolerance));
    }
  });

  it("crash points are always ≥ 1.00 and ≤ maxMultiplier", () => {
    const seed = generateServerSeed();
    for (let i = 0; i < 10_000; i++) {
      const cp = crashPointFor(seed, i, config);
      expect(cp).toBeGreaterThanOrEqual(1.0);
      expect(cp).toBeLessThanOrEqual(config.maxMultiplier);
    }
  });

  it("crash points are quantized to 0.01", () => {
    const seed = generateServerSeed();
    for (let i = 0; i < 1000; i++) {
      const cp = crashPointFor(seed, i);
      // Avoid floating-point grief: multiply by 100 and check integer-ness.
      expect(Math.round(cp * 100)).toBeCloseTo(cp * 100, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Provably-fair commit / reveal cycle
// ---------------------------------------------------------------------------

describe("provably-fair scheme", () => {
  it("commit hashes the seed with SHA-256", () => {
    const seed = generateServerSeed();
    const commit = commitSeed(seed);
    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCommit(seed, commit)).toBe(true);
  });

  it("verifyCommit rejects wrong seeds", () => {
    const seed = generateServerSeed();
    const commit = commitSeed(seed);
    const other = generateServerSeed();
    expect(verifyCommit(other, commit)).toBe(false);
  });

  it("commit/reveal round-trips for many rounds", () => {
    const seed = generateServerSeed();
    for (let n = 0; n < 100; n++) {
      const commit = buildCommit(seed, n);
      const reveal = buildReveal(seed, n);
      const result = verifyRound(commit, reveal);
      expect(result.ok).toBe(true);
    }
  });

  it("verifyRound catches tampered crash points", () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 1);
    const reveal = buildReveal(seed, 1);
    reveal.crashPoint = 999.99; // operator tries to cheat
    const result = verifyRound(commit, reveal);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/crash point/);
  });

  it("verifyRound catches mismatched seeds", () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 1);
    const wrongReveal = buildReveal(generateServerSeed(), 1);
    wrongReveal.roundNumber = 1; // align round number; only seed differs
    const result = verifyRound(commit, wrongReveal);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("rejects rtp ≤ 0 or > 1", () => {
    expect(() =>
      crashPointFor("a".repeat(64), 0, { rtp: 0, maxMultiplier: 100 }),
    ).toThrow();
    expect(() =>
      crashPointFor("a".repeat(64), 0, { rtp: -0.1, maxMultiplier: 100 }),
    ).toThrow();
    expect(() =>
      crashPointFor("a".repeat(64), 0, { rtp: 1.5, maxMultiplier: 100 }),
    ).toThrow();
  });

  it("uses DEFAULT_CONFIG when none supplied", () => {
    const cp = crashPointFor("a".repeat(64), 0);
    expect(cp).toBeGreaterThanOrEqual(1.0);
    expect(cp).toBeLessThanOrEqual(DEFAULT_CONFIG.maxMultiplier);
  });
});
