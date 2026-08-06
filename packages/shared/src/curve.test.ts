import { describe, it, expect } from 'vitest';
import { multiplierAtMs, timeToMultiplierMs, DEFAULT_GROWTH_RATE, type GrowthSegment } from './curve';

describe('growth curve', () => {
  it('base exponential: m(0)=1 and matches e^(rate t)', () => {
    expect(multiplierAtMs(0, 0.06)).toBeCloseTo(1, 6);
    expect(multiplierAtMs(1000, 0.06)).toBeCloseTo(Math.exp(0.06), 6);
    // falls back to default when rate is invalid
    expect(multiplierAtMs(1000, 0)).toBeCloseTo(Math.exp(DEFAULT_GROWTH_RATE), 6);
  });

  it('multiplierAtMs and timeToMultiplierMs are inverses (base + piecewise)', () => {
    const seg: GrowthSegment[] = [{ from: 1, rate: 0.12 }, { from: 2, rate: 0.05 }, { from: 5, rate: 0.03 }];
    for (const m of [1.3, 2, 3.7, 5, 12]) {
      for (const s of [undefined, seg]) {
        const t = timeToMultiplierMs(m, 0.06, s);
        expect(multiplierAtMs(t, 0.06, s)).toBeCloseTo(m, 4);
      }
    }
  });

  it('piecewise is continuous at breakpoints and uses each band rate', () => {
    const seg: GrowthSegment[] = [{ from: 1, rate: 0.20 }, { from: 2, rate: 0.05 }];
    const tTo2 = timeToMultiplierMs(2, 0.06, seg);
    expect(tTo2).toBeCloseTo((Math.log(2) / 0.20) * 1000, 4); // first band only
    // just past 2× it climbs at the slower 0.05 rate
    const m = multiplierAtMs(tTo2 + 1000, 0.06, seg);
    expect(m).toBeCloseTo(2 * Math.exp(0.05), 4);
  });

  it('unsorted / first-from>1 segments are normalised (anchored at m=1)', () => {
    const a = multiplierAtMs(3000, 0.06, [{ from: 2, rate: 0.05 }, { from: 1, rate: 0.20 }]);
    const b = multiplierAtMs(3000, 0.06, [{ from: 1, rate: 0.20 }, { from: 2, rate: 0.05 }]);
    expect(a).toBeCloseTo(b, 6);
  });
});
