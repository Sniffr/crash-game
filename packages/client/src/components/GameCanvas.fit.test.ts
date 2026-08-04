import { describe, it, expect } from 'vitest';
import { stretchPlaybackRate, liveMultiplier } from './GameCanvas';

describe('stretchPlaybackRate (launch clip fills the betting window)', () => {
  it('slows a short clip to fill a longer window (2.8s over 5s → plays once)', () => {
    expect(stretchPlaybackRate(2.8, 5000)).toBeCloseTo(0.56, 5);
  });

  it('speeds a long clip to fit a shorter remaining window', () => {
    expect(stretchPlaybackRate(6, 3000)).toBeCloseTo(2, 5);
  });

  it('clamps to the browser-supported range at the extremes', () => {
    expect(stretchPlaybackRate(100, 100)).toBe(16); // would be 1000×
    expect(stretchPlaybackRate(0.1, 60000)).toBe(0.0625); // would be ~0.0017×
  });

  it('guards a near-zero remaining time (no divide-by-zero blowup)', () => {
    expect(Number.isFinite(stretchPlaybackRate(2.8, 0))).toBe(true);
  });
});

describe('liveMultiplier (smooth local interpolation for GIF mode)', () => {
  it('returns the server value when the flight has not started', () => {
    expect(liveMultiplier(null, 0, 1.0)).toBe(1.0);
    expect(liveMultiplier(null, 0, 3.42)).toBe(3.42);
  });

  it('interpolates above the server floor once flying (~1s in ≈ 1.06×)', () => {
    const m = liveMultiplier(Date.now() - 1000, 0, 1.0);
    expect(m).toBeGreaterThan(1.0);
    expect(m).toBeLessThan(1.1); // exp(0.06*1) ≈ 1.0618
  });

  it('never drops below the server floor (server is authoritative low bound)', () => {
    // Local interp would be ~1.06× but the server already confirmed 5× → show 5×.
    expect(liveMultiplier(Date.now() - 1000, 0, 5.0)).toBe(5.0);
  });

  it('caps at the crash point', () => {
    expect(liveMultiplier(Date.now() - 100000, 0, 1.0, 2.5)).toBe(2.5);
  });
});
