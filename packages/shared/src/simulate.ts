/**
 * Provably-fair resolver for the "Simulate" game — a casino-style sports bet
 * slip whose outcome is drawn from an RNG (not from the real match result).
 *
 * A player builds a slip of one or more selections, each carrying the decimal
 * odds harvested from a real bookmaker (via OddsHarvester → S3). Instead of
 * placing a real wager, the slip is *simulated*: the server draws an outcome
 * whose long-run RTP equals the configured value, exactly like the crash RNG.
 *
 * ── The maths (why RTP is exact) ──────────────────────────────────────────
 * A slip of `n` legs pays `stake × ∏ oddsᵢ` (the combined/accumulator odds)
 * IFF every leg wins, and 0 otherwise. We want:
 *
 *     E[payout] / stake = RTP
 *
 * Draw each leg independently: leg `i` wins with probability `pᵢ`. Then
 * `P(slip wins) = ∏ pᵢ` and
 *
 *     E[payout]/stake = (∏ oddsᵢ) · (∏ pᵢ) = ∏ (oddsᵢ · pᵢ).
 *
 * Choosing `pᵢ = RTP^(1/n) / oddsᵢ` makes every factor `oddsᵢ·pᵢ = RTP^(1/n)`,
 * so the product is `RTP` for ANY set of odds and ANY number of legs. For a
 * single leg this reduces to `p = RTP / odds` — the same identity the crash
 * game uses (`P(crash ≥ m) = RTP/m`). House edge = `1 − RTP`, spread evenly.
 *
 * ── Provable fairness ─────────────────────────────────────────────────────
 * Each leg's uniform `u ∈ [0,1)` comes from
 *   HMAC-SHA256(serverSeed, `${nonce}:${index}:${eventId}:${pick}`)
 * → first 13 hex chars → `u`. The server commits `sha256(serverSeed)` BEFORE
 * the slip is played and reveals `serverSeed` after, so anyone can recompute
 * every leg and confirm the outcome was not tampered with. Domain-separating
 * by `index:eventId:pick` gives each leg an independent draw under one seed.
 */

import { createHmac } from 'crypto';
import { commitSeed, generateServerSeed } from './rng';

// Re-export the seed helpers so callers can `import { ... } from '@crash/shared/simulate'`.
export { commitSeed, generateServerSeed, verifyCommit } from './rng';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SimulateConfig {
  /** Return-to-player as a fraction in (0, 1]. 0.95 = 95% RTP. */
  rtp: number;
  /** Hard ceiling on the combined odds a single slip may pay (safety cap). */
  maxCombinedOdds: number;
  /** Max legs allowed on one slip. */
  maxLegs: number;
}

export const DEFAULT_SIMULATE_CONFIG: SimulateConfig = {
  rtp: 0.95,
  maxCombinedOdds: 100_000,
  maxLegs: 20,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One pick on the bet slip. `odds` is decimal (e.g. 1.96), `> 1`. */
export interface Selection {
  /** Stable id of the fixture this pick is for (from the harvested feed). */
  eventId: string;
  /** Market token, e.g. '1x2', 'over_under_2_5'. */
  market: string;
  /** The chosen outcome within the market, e.g. 'home' | 'draw' | 'away'. */
  pick: string;
  /** Decimal odds for this outcome. */
  odds: number;
  /** Optional human labels, carried through untouched for display/audit. */
  label?: string;
}

/** Per-leg simulation outcome. */
export interface LegResult {
  eventId: string;
  market: string;
  pick: string;
  odds: number;
  /** The provably-fair uniform draw for this leg. */
  u: number;
  /** Probability this leg was set to win (RTP^(1/n) / odds, clamped to [0,1]). */
  winProbability: number;
  /** True iff `u < winProbability`. */
  won: boolean;
}

/** Full slip resolution. */
export interface SlipResult {
  /** True iff every leg won. */
  won: boolean;
  /** ∏ oddsᵢ, the multiplier applied to the stake on a win. */
  combinedOdds: number;
  /** `combinedOdds` on a win, else 0. */
  payoutMultiplier: number;
  legs: LegResult[];
  /** The nonce used (echoed for the reveal). */
  nonce: string;
  /** sha256(serverSeed), published before the slip is played. */
  commit: string;
}

// ---------------------------------------------------------------------------
// Uniform draw (mirrors rng.ts: first 13 hex chars = 52 bits → [0,1))
// ---------------------------------------------------------------------------

/** Deterministic uniform in [0,1) for a leg of a slip. */
export function legUniform(serverSeed: string, nonce: string, index: number, sel: Selection): number {
  const message = `${nonce}:${index}:${sel.eventId}:${sel.pick}`;
  const hmac = createHmac('sha256', serverSeed).update(message).digest('hex');
  const intVal = parseInt(hmac.slice(0, 13), 16);
  return intVal / 2 ** 52;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class InvalidSlipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSlipError';
  }
}

/** Throws {@link InvalidSlipError} if the slip can't be simulated. */
export function assertValidSlip(
  selections: Selection[],
  config: SimulateConfig = DEFAULT_SIMULATE_CONFIG,
): void {
  if (config.rtp <= 0 || config.rtp > 1) {
    throw new InvalidSlipError(`rtp must be in (0, 1], got ${config.rtp}`);
  }
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new InvalidSlipError('slip must have at least one selection');
  }
  if (selections.length > config.maxLegs) {
    throw new InvalidSlipError(`slip may not exceed ${config.maxLegs} legs`);
  }
  for (const s of selections) {
    if (!s || typeof s.eventId !== 'string' || !s.eventId) {
      throw new InvalidSlipError('each selection needs a non-empty eventId');
    }
    if (typeof s.pick !== 'string' || !s.pick) {
      throw new InvalidSlipError('each selection needs a non-empty pick');
    }
    if (typeof s.odds !== 'number' || !Number.isFinite(s.odds) || s.odds <= 1) {
      throw new InvalidSlipError(`odds must be a finite number > 1, got ${s.odds} for ${s.eventId}`);
    }
  }
  // A slip may not contain two picks on the SAME event (would let a player
  // hedge both sides into a guaranteed edge and breaks leg independence).
  const seen = new Set<string>();
  for (const s of selections) {
    if (seen.has(s.eventId)) {
      throw new InvalidSlipError(`duplicate event on slip: ${s.eventId}`);
    }
    seen.add(s.eventId);
  }
}

// ---------------------------------------------------------------------------
// Combined odds
// ---------------------------------------------------------------------------

/** ∏ oddsᵢ, capped at `maxCombinedOdds`. */
export function combinedOdds(
  selections: Selection[],
  config: SimulateConfig = DEFAULT_SIMULATE_CONFIG,
): number {
  const raw = selections.reduce((acc, s) => acc * s.odds, 1);
  return Math.min(raw, config.maxCombinedOdds);
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Simulate a bet slip. Deterministic in (serverSeed, nonce, selections):
 * same inputs ⇒ same outcome, which is what makes it provably fair.
 */
export function simulateSlip(
  serverSeed: string,
  nonce: string,
  selections: Selection[],
  config: SimulateConfig = DEFAULT_SIMULATE_CONFIG,
): SlipResult {
  assertValidSlip(selections, config);

  const n = selections.length;
  // Per-leg target win probability. RTP^(1/n) is the geometric split of the
  // house edge across legs so E[payout]/stake === rtp for any odds.
  const perLegHold = Math.pow(config.rtp, 1 / n);

  const legs: LegResult[] = selections.map((sel, i) => {
    const u = legUniform(serverSeed, nonce, i, sel);
    const winProbability = Math.min(1, Math.max(0, perLegHold / sel.odds));
    return {
      eventId: sel.eventId,
      market: sel.market,
      pick: sel.pick,
      odds: sel.odds,
      u,
      winProbability,
      won: u < winProbability,
    };
  });

  const won = legs.every((l) => l.won);
  const combo = combinedOdds(selections, config);

  return {
    won,
    combinedOdds: combo,
    payoutMultiplier: won ? combo : 0,
    legs,
    nonce,
    commit: commitSeed(serverSeed),
  };
}

// ---------------------------------------------------------------------------
// Verify (client-side recomputation from the revealed seed)
// ---------------------------------------------------------------------------

export interface SlipVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Recompute a slip from the revealed seed and confirm it matches what the
 * server reported. Returns `{ ok: false, reason }` on any mismatch.
 */
export function verifySlip(
  serverSeed: string,
  reported: SlipResult,
  selections: Selection[],
  config: SimulateConfig = DEFAULT_SIMULATE_CONFIG,
): SlipVerification {
  if (commitSeed(serverSeed) !== reported.commit) {
    return { ok: false, reason: 'seed does not match committed hash' };
  }
  let recomputed: SlipResult;
  try {
    recomputed = simulateSlip(serverSeed, reported.nonce, selections, config);
  } catch (err) {
    return { ok: false, reason: `recomputation failed: ${(err as Error).message}` };
  }
  if (recomputed.won !== reported.won) {
    return { ok: false, reason: 'win/loss does not match recomputation' };
  }
  if (recomputed.payoutMultiplier !== reported.payoutMultiplier) {
    return { ok: false, reason: 'payout multiplier does not match recomputation' };
  }
  for (let i = 0; i < recomputed.legs.length; i++) {
    if (recomputed.legs[i]!.won !== reported.legs[i]?.won) {
      return { ok: false, reason: `leg ${i} outcome does not match recomputation` };
    }
  }
  return { ok: true };
}
