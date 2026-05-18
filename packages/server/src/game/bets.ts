import { type Bet, type HistoryEntry } from '@crash/shared/types';
import {
  adjustBalance,
  appendHistory,
  recordWin,
  StoreOfflineError,
  getStats,
} from '../store';
import { broadcast, sendToSession } from '../ws/hub';

/** Reference to the current round — set by game/round.ts at runtime. */
let currentRoundRef: { roundNumber: number; crashPoint: number } | null = null;

export function setCurrentRoundRef(round: { roundNumber: number; crashPoint: number } | null) {
  currentRoundRef = round;
}

export async function cashOutBet(bet: Bet, atMultiplier: number, source: 'manual' | 'auto') {
  if (bet.cashedOut) return;
  bet.cashedOut = true;
  bet.cashoutMultiplier = atMultiplier;
  bet.profit = Math.round(bet.amount * atMultiplier * 100) / 100;

  if (!bet.isBot && currentRoundRef) {
    const sessionId = bet.playerId;
    try {
      const newBal = await adjustBalance(sessionId, bet.profit);
      const stats = await recordWin(sessionId, bet.amount, bet.profit, atMultiplier);
      await appendHistory(sessionId, {
        kind: 'cashout',
        roundNumber: currentRoundRef.roundNumber,
        amount: bet.amount,
        multiplier: atMultiplier,
        payout: bet.profit,
        auto: source === 'auto',
        at: Date.now(),
      } satisfies HistoryEntry);
      sendToSession(sessionId, {
        type: 'cashout_success',
        data: { multiplier: atMultiplier, profit: bet.profit, balance: newBal, source, stats },
      });
    } catch (err) {
      if (err instanceof StoreOfflineError) {
        sendToSession(sessionId, { type: 'error', data: { message: 'Session store offline — balance not updated' } });
      } else {
        console.error('[cashout] error:', err);
      }
    }
  }

  broadcast({
    type: 'cashout',
    data: {
      playerId: bet.playerId,
      multiplier: atMultiplier,
      profit: bet.profit,
      isBot: bet.isBot,
      botName: bet.botName,
      displayName: bet.displayName,
      source,
    },
  });
}
