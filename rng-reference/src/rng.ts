import * as crypto from 'crypto';

export interface Commit {
  roundNumber: number;
  hashCommit: string;
}

export interface Reveal {
  roundNumber: number;
  serverSeed: string;
  crashPoint: number;
}

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

export interface GameConfig {
  rtp: number;
  houseEdge: number;
  maxMultiplier: number;
  minMultiplier: number;
  bettingPhaseMs: number;
  resultPhaseMs: number;
}

const DEFAULT_CONFIG: GameConfig = {
  rtp: 0.97,
  houseEdge: 0.03,
  maxMultiplier: 10000,
  minMultiplier: 1.00,
  bettingPhaseMs: 5000,
  resultPhaseMs: 3000,
};

/**
 * Generate a random 32-byte server seed (hex encoded = 64 chars)
 */
export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Commit: SHA256 hash of the server seed — publish BEFORE the round
 */
export function commitSeed(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Derive a uniform float in [0, 1) from HMAC-SHA256(serverSeed, roundNumber)
 * Takes first 13 hex chars → converts to float
 */
function uniformFromHMAC(serverSeed: string, roundNumber: number): number {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(String(roundNumber))
    .digest('hex');
  const hex13 = hmac.slice(0, 13);
  const max = parseInt('fffffffffffff', 16); // 2^52 - 1 ≈ 13 hex chars
  return parseInt(hex13, 16) / max;
}

/**
 * Compute the crash multiplier for a given seed and round number.
 *
 * Formula:
 *   u = uniform float in [0, 1) from HMAC-SHA256(serverSeed, roundNumber)
 *   raw = (100 * rtp) / (1 - u)
 *   crashPoint = max(1.0, floor(raw) / 100), clamped to maxMultiplier
 *
 * This yields P(crashPoint >= m) = rtp / m for every m > 1.
 */
export function crashPointFor(
  serverSeed: string,
  roundNumber: number,
  config: GameConfig = DEFAULT_CONFIG
): number {
  const u = uniformFromHMAC(serverSeed, roundNumber);
  const raw = (100 * config.rtp) / (1 - u);
  const crashPoint = Math.max(config.minMultiplier, Math.floor(raw) / 100);
  return Math.min(crashPoint, config.maxMultiplier);
}

/**
 * Build a commit object to broadcast at round start
 */
export function buildCommit(serverSeed: string, roundNumber: number): Commit {
  return {
    roundNumber,
    hashCommit: commitSeed(serverSeed),
  };
}

/**
 * Build a reveal object to broadcast after the round
 */
export function buildReveal(
  serverSeed: string,
  roundNumber: number,
  config: GameConfig = DEFAULT_CONFIG
): Reveal {
  return {
    roundNumber,
    serverSeed,
    crashPoint: crashPointFor(serverSeed, roundNumber, config),
  };
}

/**
 * Client-side verification: given a commit and reveal, verify the round.
 * Returns { ok: true } or { ok: false, reason }
 */
export function verifyRound(
  commit: Commit,
  reveal: Reveal,
  config: GameConfig = DEFAULT_CONFIG
): VerificationResult {
  // 1. Check that the hash matches the revealed seed
  const computedHash = commitSeed(reveal.serverSeed);
  if (computedHash !== commit.hashCommit) {
    return { ok: false, reason: 'Hash mismatch: revealed seed does not match committed hash' };
  }

  // 2. Check round numbers match
  if (commit.roundNumber !== reveal.roundNumber) {
    return { ok: false, reason: 'Round number mismatch' };
  }

  // 3. Recompute the crash point and verify it matches
  const computedCrash = crashPointFor(reveal.serverSeed, reveal.roundNumber, config);
  if (computedCrash !== reveal.crashPoint) {
    return {
      ok: false,
      reason: `Crash point mismatch: computed ${computedCrash}, revealed ${reveal.crashPoint}`,
    };
  }

  return { ok: true };
}
