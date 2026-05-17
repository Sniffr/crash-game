import { describe, test, expect } from 'vitest';
import {
  generateServerSeed,
  commitSeed,
  crashPointFor,
  buildCommit,
  buildReveal,
  verifyRound,
  DEFAULT_CONFIG,
  type Commit,
  type Reveal,
} from './rng';
import type { GameConfig } from './types';

// ─── Determinism ───────────────────────────────────────────────────────────────

describe('determinism', () => {
  test('same seed + round number → same crash multiplier', () => {
    const seed = generateServerSeed();
    for (let round = 1; round <= 100; round++) {
      const a = crashPointFor(seed, round);
      const b = crashPointFor(seed, round);
      expect(a).toBe(b);
    }
  });

  test('different seeds → different crash multipliers (for same round)', () => {
    const seed1 = generateServerSeed();
    const seed2 = generateServerSeed();
    const crash1 = crashPointFor(seed1, 42);
    const crash2 = crashPointFor(seed2, 42);
    expect(crash1).not.toBe(crash2);
  });

  test('different round numbers → different crash multipliers (for same seed)', () => {
    const seed = generateServerSeed();
    const crash1 = crashPointFor(seed, 1);
    const crash2 = crashPointFor(seed, 2);
    expect(crash1).not.toBe(crash2);
  });
});

// ─── RTP knob ──────────────────────────────────────────────────────────────────

describe('RTP knob', () => {
  /**
   * Simulate N rounds with a fixed cashout strategy.
   * For each round, if crashPoint >= target, the player wins (target * stake).
   * Otherwise they lose (stake). RTP = totalPayouts / totalStakes.
   */
  function simulateRTP(
    rtp: number,
    rounds: number,
    cashoutTarget: number,
    stake: number = 1
  ): number {
    const config: GameConfig = { ...DEFAULT_CONFIG, rtp };
    let totalPayouts = 0;
    for (let i = 1; i <= rounds; i++) {
      const seed = generateServerSeed();
      const crash = crashPointFor(seed, i, config);
      if (crash >= cashoutTarget) {
        totalPayouts += cashoutTarget * stake;
      } else {
        totalPayouts += 0;
      }
    }
    return totalPayouts / (rounds * stake);
  }

  test('rtp=0.90 produces RTP within ±0.01 at m=1.5, 2, 5', () => {
    const rounds = 250_000;
    const targets = [1.5, 2, 5];
    for (const m of targets) {
      const measured = simulateRTP(0.90, rounds, m);
      expect(measured).toBeGreaterThan(0.89);
      expect(measured).toBeLessThan(0.91);
    }
  }, 60_000);

  test('rtp=0.97 produces RTP within ±0.01 at m=1.5, 2, 5, 10', () => {
    const rounds = 250_000;
    const targets = [1.5, 2, 5, 10];
    for (const m of targets) {
      const measured = simulateRTP(0.97, rounds, m);
      expect(measured).toBeGreaterThan(0.96);
      expect(measured).toBeLessThan(0.98);
    }
  }, 60_000);

  test('rtp=0.99 produces RTP within ±0.01 at m=1.5, 2, 5', () => {
    const rounds = 250_000;
    const targets = [1.5, 2, 5];
    for (const m of targets) {
      const measured = simulateRTP(0.99, rounds, m);
      expect(measured).toBeGreaterThan(0.98);
      expect(measured).toBeLessThan(0.999);
    }
  }, 60_000);
});

// ─── Distribution shape ────────────────────────────────────────────────────────

describe('distribution shape', () => {
  /**
   * Measure P(crashPoint >= m) across N rounds.
   * Theory: P(crashPoint >= m) = rtp / m
   */
  function measureSurvival(
    rtp: number,
    rounds: number,
    target: number
  ): number {
    const config: GameConfig = { ...DEFAULT_CONFIG, rtp };
    let count = 0;
    for (let i = 1; i <= rounds; i++) {
      const seed = generateServerSeed();
      if (crashPointFor(seed, i, config) >= target) {
        count++;
      }
    }
    return count / rounds;
  }

  test('P(crash >= m) ≈ rtp/m for m=1.5, 2, 3, 5 at rtp=0.97', () => {
    const rounds = 100_000;
    const rtp = 0.97;
    const targets = [1.5, 2, 3, 5];
    for (const m of targets) {
      const expected = rtp / m;
      const observed = measureSurvival(rtp, rounds, m);
      // ±8% tolerance for common values
      const margin = 0.08;
      expect(observed).toBeGreaterThan(expected * (1 - margin));
      expect(observed).toBeLessThan(expected * (1 + margin));
    }
  }, 60_000);

  test('P(crash >= m) ≈ rtp/m for m=10, 50 at rtp=0.97 (wider tolerance)', () => {
    const rounds = 100_000;
    const rtp = 0.97;
    // Rare tail — wider tolerance
    const targets = [10, 50];
    for (const m of targets) {
      const expected = rtp / m;
      const observed = measureSurvival(rtp, rounds, m);
      const margin = 0.20;
      expect(observed).toBeGreaterThan(expected * (1 - margin));
      expect(observed).toBeLessThan(expected * (1 + margin));
    }
  }, 60_000);
});

// ─── Provably-fair ─────────────────────────────────────────────────────────────

describe('provably-fair', () => {
  test('commit/reveal round-trips', () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 1);
    const reveal = buildReveal(seed, 1);
    const result = verifyRound(commit, reveal);
    expect(result.ok).toBe(true);
  });

  test('tampered crash point is detected', () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 1);
    const reveal: Reveal = {
      roundNumber: 1,
      serverSeed: seed,
      crashPoint: 999.99, // wrong
    };
    const result = verifyRound(commit, reveal);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Crash point mismatch');
  });

  test('tampered seed is detected', () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 1);
    const reveal: Reveal = {
      roundNumber: 1,
      serverSeed: generateServerSeed(), // wrong seed
      crashPoint: 0,
    };
    const result = verifyRound(commit, reveal);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Hash mismatch');
  });

  test('round number mismatch is detected', () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 1);
    const reveal: Reveal = {
      roundNumber: 999,
      serverSeed: seed,
      crashPoint: 0,
    };
    const result = verifyRound(commit, reveal);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Round number mismatch');
  });

  test('100 consecutive rounds all verify', () => {
    const seed = generateServerSeed();
    for (let i = 1; i <= 100; i++) {
      const commit = buildCommit(seed, i);
      const reveal = buildReveal(seed, i);
      const result = verifyRound(commit, reveal);
      expect(result.ok).toBe(true);
    }
  });
});

// ─── Bounds ────────────────────────────────────────────────────────────────────

describe('bounds', () => {
  test('every crash point is in [1.00, maxMultiplier]', () => {
    const config: GameConfig = {
      ...DEFAULT_CONFIG,
      maxMultiplier: 10000,
      minMultiplier: 1.0,
    };
    for (let i = 1; i <= 10000; i++) {
      const seed = generateServerSeed();
      const crash = crashPointFor(seed, i, config);
      expect(crash).toBeGreaterThanOrEqual(1.0);
      expect(crash).toBeLessThanOrEqual(10000);
    }
  });

  test('crash points are quantized to 0.01', () => {
    const config: GameConfig = { ...DEFAULT_CONFIG };
    for (let i = 1; i <= 10000; i++) {
      const seed = generateServerSeed();
      const crash = crashPointFor(seed, i, config);
      const quantized = Math.round(crash * 100) / 100;
      expect(crash).toBe(quantized);
    }
  });

  test('many rounds produce crash points of 1.00x (floor quantization)', () => {
    const config: GameConfig = { ...DEFAULT_CONFIG, rtp: 0.97 };
    let crash100 = 0;
    const rounds = 10000;
    for (let i = 1; i <= rounds; i++) {
      const seed = generateServerSeed();
      if (crashPointFor(seed, i, config) === 1.0) {
        crash100++;
      }
    }
    // ~3% of rounds should crash at 1.00x
    const pct = crash100 / rounds;
    expect(pct).toBeGreaterThan(0.01);
    expect(pct).toBeLessThan(0.06);
  });
});

// ─── Utility functions ─────────────────────────────────────────────────────────

describe('utilities', () => {
  test('generateServerSeed returns 64-char hex string', () => {
    const seed = generateServerSeed();
    expect(seed).toHaveLength(64);
    expect(seed).toMatch(/^[0-9a-f]+$/);
  });

  test('commitSeed returns 64-char hex SHA256', () => {
    const seed = generateServerSeed();
    const hash = commitSeed(seed);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test('buildCommit returns correct structure', () => {
    const seed = generateServerSeed();
    const commit = buildCommit(seed, 42);
    expect(commit.roundNumber).toBe(42);
    expect(commit.hashCommit).toBe(commitSeed(seed));
  });
});
