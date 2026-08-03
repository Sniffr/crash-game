// ---------------------------------------------------------------------------
// Request / Response types (spec §5 — field names follow the spec exactly)
// ---------------------------------------------------------------------------

// §5.1 POST /authenticate
export interface AuthenticateRequest {
  token: string;
  ip: string;
  userAgent: string;
  gameId: string;
}

export interface AuthenticateResponse {
  playerId: string;
  displayName: string;
  currency: string;
  balance: number;         // minor units
  country: string;
  jurisdiction: string;
  language: string;
  rgLimits: {
    maxBetMinor: number;
    sessionEndsAt: number;
  };
}

// §5.2 POST /balance
export interface BalanceRequest {
  playerId: string;
  sessionId: string;
}

export interface BalanceResponse {
  balance: number;   // minor units
  currency: string;
}

// §5.3 POST /bet
export interface BetRequest {
  playerId: string;
  sessionId: string;
  roundId: string;
  betId: string;
  txnId: string;
  amountMinor: number;
  currency: string;
  gameId: string;
  placedAt: number;  // unix seconds
}

export interface BetResponse {
  operatorTxnId: string;
  balanceMinor: number;
  currency: string;
}

// §5.4 POST /win
export interface WinRequest {
  playerId: string;
  sessionId: string;
  roundId: string;
  betId: string;
  betTxnId: string;
  txnId: string;
  amountMinor: number;
  multiplier: number;
  currency: string;
  settledAt: number;  // unix seconds
}

export interface WinResponse {
  operatorTxnId: string;
  balanceMinor: number;
  currency: string;
}

// §5.5 POST /rollback
export interface RollbackRequest {
  playerId: string;
  betTxnId: string;
  txnId: string;
  reason: 'round_voided' | 'game_error' | 'timeout' | 'manual_void';
}

export interface RollbackResponse {
  operatorTxnId: string;
  balanceMinor: number;
  currency: string;
  status: 'rolled_back' | 'noop';
}

// §5.6 POST /round-end
export interface RoundEndRequest {
  roundId: string;
  playerId: string;
  crashPoint: number;
  serverSeedHash: string;
  serverSeed: string;
  bets: Array<{
    betId: string;
    txnId: string;
    amountMinor: number;
    result: string;
    winTxnId?: string;
    winAmountMinor?: number;
    multiplier?: number;
  }>;
}
