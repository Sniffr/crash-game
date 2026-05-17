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
  playerId: string;
  amount: number;
  autoCashout?: number;
  cashoutMultiplier?: number;
  cashedOut: boolean;
  profit?: number;
  isBot: boolean;
  botName?: string;
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
