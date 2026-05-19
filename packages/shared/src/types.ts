// Round state machine phases
export type RoundPhase = 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';

export interface GameConfig {
  rtp: number;
  houseEdge: number;
  maxMultiplier: number;
  minMultiplier: number;
  bettingPhaseMs: number;
  resultPhaseMs: number;
}

export interface Bet {
  playerId: string;            // sessionId for real players, "bot-X-Y" for bots
  /** @deprecated Legacy decimal-credit stake. Use {@link Bet.amountMinor} + {@link Bet.currency}. Removed once all bets flow through the operator wallet (Task 3.x). */
  amount: number;
  autoCashout?: number;
  cashoutMultiplier?: number;
  cashedOut: boolean;
  profit?: number;
  isBot: boolean;
  botName?: string;
  displayName?: string;        // friendly name from the session (real players only)

  /** Operator that owns this bet's player. Set for real-player B2B bets (Task 1.6+); absent for bots/legacy. */
  operatorId?: string;
  /** Stable per-bet id used across wallet calls (Task 1.6+). */
  betId?: string;
  /** Idempotency key for the operator /bet debit (Task 1.6+). */
  betTxnId?: string;
  /** Idempotency key for the operator /win credit (Task 1.6+). */
  winTxnId?: string;
  /** ISO-4217 / asset code for the stake (Task 1.6+). Absent for legacy/bot bets. */
  currency?: string;
  /** Stake in integer minor units (Task 1.6+). Canonical going forward; replaces {@link Bet.amount}. */
  amountMinor?: number;
}

export interface RoundState {
  roundNumber: number;
  phase: RoundPhase;
  crashPoint: number;
  currentMultiplier: number;
  startTime: number;
  crashTime?: number;
  bets: Bet[];
  serverSeedHash?: string;
  serverSeed?: string;
}

/** Per-round operator context threaded through bet/cashout handlers (Task 1.6+). */
export interface RoundContext {
  roundId: string;
  operatorId: string;
}

// WebSocket message types
export interface ServerMessage {
  type: string;
  data: any;
}

export interface ClientMessage {
  type: string;
  data: any;
}

export type RoundHistoryEntry = {
  roundNumber: number;
  crashPoint: number;
};

export type PlayerStats = {
  totalBets: number;
  totalWins: number;
  totalLosses: number;
  totalProfit: number;
  bestCashout: number;
  balance: number;
};

// ─── Session (Dragonfly-backed) ─────────────────────────────────────────────

export interface Session {
  /** Public session id — appears in the URL. */
  sessionId: string;
  /** Friendly name shown in the player list (e.g. "Lucky Falcon"). */
  displayName: string;
  /** @deprecated Legacy decimal-credit balance. Use {@link Session.balanceMinor} + {@link Session.currency}. Becomes operator-sourced in Task 3.1. */
  balance: number;
  /** Unix millis. */
  createdAt: number;
  /** Unix millis. */
  expiresAt: number;

  /** Operator that owns this player (Task 3.1+). */
  operatorId?: string;
  /** Operator-scoped player id (Task 3.1+). */
  playerId?: string;
  /** Session currency (Task 3.1+). */
  currency?: string;
  /** Balance in integer minor units (Task 3.1+). Canonical going forward; replaces {@link Session.balance}. */
  balanceMinor?: number;
  /** Per-operator responsible-gambling limits, populated for operator sessions (Task 3.2+). */
  rgLimits?: { maxBetMinor?: number; sessionEndsAt?: number };
}

/** Per-session lifetime stats. All counters are non-negative. */
export interface SessionStats {
  bets: number;
  wins: number;
  losses: number;
  totalWagered: number;
  totalWon: number;
  netProfit: number;
  biggestCashout: number;   // largest cashout multiplier reached
  biggestWin: number;       // largest single payout
  currentStreak: number;    // positive = consecutive wins, negative = consecutive losses
  bestStreak: number;       // longest run of consecutive wins
}

export const ZERO_STATS: SessionStats = {
  bets: 0, wins: 0, losses: 0,
  totalWagered: 0, totalWon: 0, netProfit: 0,
  biggestCashout: 0, biggestWin: 0,
  currentStreak: 0, bestStreak: 0,
};

/** A single historical event for the session's audit log. */
export type HistoryEntry =
  | { kind: 'bet'; roundNumber: number; amount: number; autoCashout?: number; at: number }
  | { kind: 'cashout'; roundNumber: number; amount: number; multiplier: number; payout: number; auto: boolean; at: number }
  | { kind: 'crashed'; roundNumber: number; amount: number; crashPoint: number; serverSeed?: string; at: number };
