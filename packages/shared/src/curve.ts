/**
 * The multiplier growth curve — the single source of truth shared by the server
 * (crash detection + broadcast) and the client (smooth interpolation). They MUST
 * agree, so both import from here.
 *
 * Base curve: m(t) = e^(rate · t_seconds), starting at m=1 when t=0.
 *
 * Optional PIECEWISE growth: give each multiplier band its own rate. Segments are
 * `{ from, rate }` breakpoints — a segment's rate applies from its `from` up to
 * the next segment's `from` (the last extends to infinity). e.g.
 *   [{from:1, rate:0.10}, {from:2, rate:0.05}, {from:5, rate:0.03}]
 * climbs fast to 2×, slower to 5×, slowest above. Only PACING changes — the crash
 * point comes from the provably-fair RNG, so RTP/fairness are unaffected.
 */

export interface GrowthSegment {
  /** Multiplier at which this segment's rate takes over (≥ 1). */
  from: number;
  /** Growth rate for this band (per second, > 0). */
  rate: number;
}

export const DEFAULT_GROWTH_RATE = 0.06;

/** Sort, drop invalid, and anchor the first segment at m=1. Returns null if none usable. */
function normalize(segments?: GrowthSegment[]): GrowthSegment[] | null {
  if (!segments || segments.length === 0) return null;
  const s = segments
    .filter((x) => x && Number.isFinite(x.from) && Number.isFinite(x.rate) && x.rate > 0)
    .sort((a, b) => a.from - b.from);
  if (s.length === 0) return null;
  // The curve always begins at m=1, so the first band must start there.
  s[0] = { from: 1, rate: s[0].rate };
  return s;
}

/** Multiplier at `elapsedMs` into flight, under a base rate + optional piecewise bands. */
export function multiplierAtMs(elapsedMs: number, baseRate: number, segments?: GrowthSegment[]): number {
  const t = Math.max(0, elapsedMs) / 1000;
  const rate = baseRate > 0 ? baseRate : DEFAULT_GROWTH_RATE;
  const s = normalize(segments);
  if (!s) return Math.exp(rate * t);

  let remaining = t;
  let cur = 1;
  for (let i = 0; i < s.length; i++) {
    const k = s[i].rate;
    const next = i + 1 < s.length ? s[i + 1].from : Infinity;
    if (!(next > cur)) continue; // skip zero/negative-width bands
    if (next === Infinity) return cur * Math.exp(k * remaining);
    const dt = Math.log(next / cur) / k; // seconds to climb cur → next at rate k
    if (remaining <= dt) return cur * Math.exp(k * remaining);
    remaining -= dt;
    cur = next;
  }
  return cur;
}

/** Inverse: milliseconds of flight to reach multiplier `m` (m ≤ 1 → 0). */
export function timeToMultiplierMs(m: number, baseRate: number, segments?: GrowthSegment[]): number {
  if (!(m > 1)) return 0;
  const rate = baseRate > 0 ? baseRate : DEFAULT_GROWTH_RATE;
  const s = normalize(segments);
  if (!s) return (Math.log(m) / rate) * 1000;

  let t = 0;
  let cur = 1;
  for (let i = 0; i < s.length; i++) {
    const k = s[i].rate;
    const next = i + 1 < s.length ? s[i + 1].from : Infinity;
    const top = Math.min(m, next);
    if (top > cur) t += Math.log(top / cur) / k;
    if (m <= next) break;
    cur = next;
  }
  return t * 1000;
}
