import { describe, it, expect } from 'vitest';
import { MapleradFx } from './fx';

describe('MapleradFx', () => {
  it('converts to KES via injected rate and caches', async () => {
    let calls = 0;
    const fx = new MapleradFx(async () => { calls++; return 0.5; }); // 1 NGN = 0.5 KES
    expect(await fx.toKesMinor(2000, 'NGN')).toBe(1000);
    await fx.toKesMinor(4000, 'NGN');
    expect(calls).toBe(1); // cached
    expect(await fx.toKesMinor(1234, 'KES')).toBe(1234); // identity, no fetch
  });
});
