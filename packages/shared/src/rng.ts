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

export const DEFAULT_CONFIG: GameConfig = {
  rtp: 0.97,
  houseEdge: 0.03,
  maxMultiplier: 10000,
  minMultiplier: 1.0,
  bettingPhaseMs: 5000,
  resultPhaseMs: 3000,
};

export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function commitSeed(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

function uniformFromHMAC(serverSeed: string, roundNumber: number): number {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(String(roundNumber))
    .digest('hex');
  const hex13 = hmac.slice(0, 13);
  const max = parseInt('fffffffffffff', 16);
  return parseInt(hex13, 16) / max;
}

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

export function buildCommit(serverSeed: string, roundNumber: number): Commit {
  return {
    roundNumber,
    hashCommit: commitSeed(serverSeed),
  };
}

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

export function verifyRound(
  commit: Commit,
  reveal: Reveal,
  config: GameConfig = DEFAULT_CONFIG
): VerificationResult {
  const computedHash = commitSeed(reveal.serverSeed);
  if (computedHash !== commit.hashCommit) {
    return { ok: false, reason: 'Hash mismatch: revealed seed does not match committed hash' };
  }
  if (commit.roundNumber !== reveal.roundNumber) {
    return { ok: false, reason: 'Round number mismatch' };
  }
  const computedCrash = crashPointFor(reveal.serverSeed, reveal.roundNumber, config);
  if (computedCrash !== reveal.crashPoint) {
    return {
      ok: false,
      reason: `Crash point mismatch: computed ${computedCrash}, revealed ${reveal.crashPoint}`,
    };
  }
  return { ok: true };
}
