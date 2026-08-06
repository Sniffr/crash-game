export class MapleradFx {
  private cache = new Map<string, { rate: number; at: number }>();
  constructor(private fetchRate: (from: string, to: string) => Promise<number>, private ttlMs = 5 * 60_000) {}
  async toKesMinor(amountMinor: number, currency: string): Promise<number> {
    if (currency === 'KES') return amountMinor;
    const hit = this.cache.get(currency);
    let rate: number;
    if (hit && Date.now() - hit.at < this.ttlMs) rate = hit.rate;
    else {
      try { rate = await this.fetchRate(currency, 'KES'); this.cache.set(currency, { rate, at: Date.now() }); }
      catch (e) { if (hit) rate = hit.rate; else throw e; }
    }
    return Math.round(amountMinor * rate);
  }
}
