/**
 * Provably-fair crash-point generator for an Aviator-style game.
 *
 * The crash multiplier for each round is determined by:
 *   1. A server seed (kept secret, hash committed before the round).
 *   2. A round number / nonce (public).
 *
 * HMAC-SHA256(serverSeed, roundNumber) → take the first 13 hex chars →
 * convert to a uniform float u in [0, 1) → apply the inverse-CDF formula
 * below to get a heavy-tailed crash distribution whose long-run mean
 * payout equals the configured RTP.
 *
 * The house edge is concentrated entirely in the (1 - RTP) probability
 * of an instant 1.00x crash. Conditional on surviving past 1.00x, the
 * distribution is a memoryless 1/u tail.
 */

import { createHmac, createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RngConfig {
  /** Return-to-player as a fraction in (0, 1]. 0.97 = 97% RTP. */
  rtp: number;
  /** Hard ceiling on the crash multiplier (for UI/display safety). */
  maxMultiplier: number;
}

export const DEFAULT_CONFIG: RngConfig = {
  rtp: 0.97,
  maxMultiplier: 10_000,
};

// ---------------------------------------------------------------------------
// Seed management (provably-fair commit/reveal)
// ---------------------------------------------------------------------------

/** Generate a fresh 32-byte server seed (hex-encoded). */
export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

/** The hash that is published *before* the round opens. */
export function commitSeed(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

/** Anyone can call this after the seed is revealed to verify the commit. */
export function verifyCommit(serverSeed: string, commit: string): boolean {
  return commitSeed(serverSeed) === commit;
}

// ---------------------------------------------------------------------------
// Crash point
// ---------------------------------------------------------------------------

/**
 * Deterministic crash multiplier for (serverSeed, roundNumber).
 *
 * Same inputs ALWAYS yield the same output — this is the property that makes
 * the game provably fair: after the seed is revealed, players can recompute
 * every round and confirm the operator didn't cheat.
 */
export function crashPointFor(
  serverSeed: string,
  roundNumber: number,
  config: RngConfig = DEFAULT_CONFIG,
): number {
  return crashPointForMessage(serverSeed, String(roundNumber), config);
}

/**
 * Message-based crash point — the general form used for multi-game rounds.
 *
 * `message` is the HMAC nonce. For the default single game it is `String(roundNumber)`
 * (see {@link crashPointFor}); for a catalogue game it is `\`${roundNumber}:${gameId}\``,
 * which domain-separates the draw so each game gets an INDEPENDENT crash point on
 * the same (serverSeed, roundNumber). A provably-fair verifier recomputes the same
 * message. Everything below the message is identical to the legacy path.
 */
export function crashPointForMessage(
  serverSeed: string,
  message: string,
  config: RngConfig = DEFAULT_CONFIG,
): number {
  if (config.rtp <= 0 || config.rtp > 1) {
    throw new Error(`rtp must be in (0, 1], got ${config.rtp}`);
  }

  const hmac = createHmac('sha256', serverSeed)
    .update(message)
    .digest('hex');

  // Take the first 13 hex chars = 52 bits of entropy, then map to [0, 1).
  // 52 bits matches the mantissa of an IEEE-754 double, so we get the
  // maximum uniform precision a JS number can represent.
  const intVal = parseInt(hmac.slice(0, 13), 16);
  const u = intVal / 2 ** 52;

  // Inverse-CDF of an RTP-r crash distribution.
  //
  // Derivation: we want P(crashPoint >= m) = r/m for every target m > 1,
  // because then a player who cashes out at m has expected payout
  // m * (r/m) = r, which IS the definition of RTP.
  //
  // This is satisfied by crashPoint = (100 * r) / (1 - u), quantized down
  // to 0.01 to match how real crash games display multipliers. The
  // quantization automatically produces a P(crashPoint = 1.00x) = 1 - r/1.01
  // (slightly larger than 1 - r) of "instant crash" rounds — which IS the
  // house edge, baked into the same continuous formula. No special-casing
  // needed.
  const raw = (100 * config.rtp) / (1 - u);
  const quantized = Math.floor(raw) / 100;

  return Math.min(Math.max(quantized, 1.0), config.maxMultiplier);
}

// ---------------------------------------------------------------------------
// Multi-game message convention (2026-07-24)
// ---------------------------------------------------------------------------

/** The default game keeps the legacy bare-roundNumber nonce for back-compat. */
export const DEFAULT_GAME_ID = 'galaxy-crash';

/**
 * The HMAC nonce for a (round, game). The default game uses the legacy
 * `String(roundNumber)` so its crash points — and every existing verifier /
 * history row — are unchanged; other games are domain-separated by gameId.
 */
export function crashMessage(roundNumber: number, gameId: string): string {
  return gameId === DEFAULT_GAME_ID ? String(roundNumber) : `${roundNumber}:${gameId}`;
}

// ---------------------------------------------------------------------------
// Round payload (what the server commits/reveals)
// ---------------------------------------------------------------------------

export interface RoundCommit {
  roundNumber: number;
  hashCommit: string; // published BEFORE the round
}

export interface RoundReveal {
  roundNumber: number;
  serverSeed: string; // published AFTER the round
  crashPoint: number;
}

// Backwards-compatible aliases (the rest of the codebase imports these names).
export type Commit = RoundCommit;
export type Reveal = RoundReveal;
export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

/** Build the commit a client receives at round start. */
export function buildCommit(
  serverSeed: string,
  roundNumber: number,
): RoundCommit {
  return {
    roundNumber,
    hashCommit: commitSeed(serverSeed),
  };
}

/** Build the reveal a client receives after the round resolves. */
export function buildReveal(
  serverSeed: string,
  roundNumber: number,
  config: RngConfig = DEFAULT_CONFIG,
): RoundReveal {
  return {
    roundNumber,
    serverSeed,
    crashPoint: crashPointFor(serverSeed, roundNumber, config),
  };
}

/**
 * Client-side verification helper. Returns true iff:
 *   - the revealed seed hashes to the original commit, AND
 *   - the recomputed crash point matches what the server said.
 */
export function verifyRound(
  commit: RoundCommit,
  reveal: RoundReveal,
  config: RngConfig = DEFAULT_CONFIG,
): VerificationResult {
  if (commit.roundNumber !== reveal.roundNumber) {
    return { ok: false, reason: 'round number mismatch' };
  }
  if (!verifyCommit(reveal.serverSeed, commit.hashCommit)) {
    return { ok: false, reason: 'seed does not match committed hash' };
  }
  const expected = crashPointFor(
    reveal.serverSeed,
    reveal.roundNumber,
    config,
  );
  if (expected !== reveal.crashPoint) {
    return { ok: false, reason: 'crash point does not match recomputation' };
  }
  return { ok: true };
}
