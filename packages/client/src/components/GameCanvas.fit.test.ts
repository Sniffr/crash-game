import { describe, it, expect } from 'vitest';
import { stretchPlaybackRate } from './GameCanvas';

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
