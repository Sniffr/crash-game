import { WebSocket } from 'ws';
import { type Bet, type HistoryEntry } from '@crash/shared/types';
import { MAX_STAKE } from '@crash/shared/config';
import {
  getSession,
  getStats,
  checkRateLimit,
  adjustBalance,
  recordBet,
  appendHistory,
  setBalance,
  StoreOfflineError,
  DEFAULT_DEMO_BALANCE,
} from '../store';
import { safeSend, broadcast } from './hub';
import { currentRound } from '../game/round';
import { cashOutBet } from '../game/bets';

/** Per-session metadata for real-player bets (display name lookup). */
const sessionMeta = new Map<string, { displayName: string }>();

export async function handleMessage(
  ws: WebSocket,
  message: Record<string, unknown>,
  attachSession: (sessionId: string) => void,
) {
  const type = message.type as string;
  const data = (message.data as Record<string, unknown>) ?? {};
  const sessionId = String(data.sessionId ?? data.playerId ?? '');

  switch (type) {
    case 'hello': {
      if (!sessionId) {
        safeSend(ws, { type: 'session_invalid', data: { reason: 'sessionId required' } });
        return;
      }
      try {
        const session = await getSession(sessionId);
        if (!session) {
          safeSend(ws, { type: 'session_invalid', data: { sessionId, reason: 'not found' } });
          return;
        }
        attachSession(sessionId);
        sessionMeta.set(sessionId, { displayName: session.displayName });
        const stats = await getStats(sessionId);
        safeSend(ws, {
          type: 'session_hello',
          data: { session, stats },
        });
      } catch (err) {
        if (err instanceof StoreOfflineError) {
          safeSend(ws, { type: 'error', data: { message: 'Session store offline. Start Dragonfly: docker compose up -d dragonfly' } });
        } else {
          console.error('[hello] error:', err);
        }
      }
      return;
    }

    case 'place_bet': {
      if (!currentRound || currentRound.phase !== 'BETTING') {
        safeSend(ws, { type: 'error', data: { message: 'Betting is closed for this round' } });
        return;
      }
      if (!sessionId) { safeSend(ws, { type: 'error', data: { message: 'No session' } }); return; }

      const amountRaw = Number(data.amount);
      const amount = Math.round(amountRaw * 100) / 100;
      const autoCashoutRaw = data.autoCashout == null ? undefined : Number(data.autoCashout);
      const autoCashout =
        autoCashoutRaw != null && Number.isFinite(autoCashoutRaw) && autoCashoutRaw > 1
          ? Math.round(autoCashoutRaw * 100) / 100
          : undefined;

      if (!Number.isFinite(amount) || amount <= 0) {
        safeSend(ws, { type: 'error', data: { message: 'Invalid bet amount' } }); return;
      }
      if (amount > MAX_STAKE) {
        safeSend(ws, { type: 'error', data: { message: `Max stake is $${MAX_STAKE}` } }); return;
      }
      if (currentRound.bets.some((b) => b.playerId === sessionId)) {
        safeSend(ws, { type: 'error', data: { message: 'You already have a bet this round' } }); return;
      }

      try {
        const okRate = await checkRateLimit(sessionId);
        if (!okRate) {
          safeSend(ws, { type: 'error', data: { message: 'Slow down — too many bets per minute' } });
          return;
        }
        const session = await getSession(sessionId);
        if (!session) {
          safeSend(ws, { type: 'session_invalid', data: { sessionId, reason: 'expired or missing' } });
          return;
        }
        if (amount > session.balance) {
          safeSend(ws, { type: 'error', data: { message: 'Insufficient balance' } });
          return;
        }

        const newBalance = await adjustBalance(sessionId, -amount);
        const stats = await recordBet(sessionId, amount);
        await appendHistory(sessionId, {
          kind: 'bet', roundNumber: currentRound.roundNumber, amount, autoCashout, at: Date.now(),
        } satisfies HistoryEntry);

        attachSession(sessionId);
        sessionMeta.set(sessionId, { displayName: session.displayName });

        const bet: Bet = {
          playerId: sessionId,
          amount,
          autoCashout,
          cashedOut: false,
          isBot: false,
          displayName: session.displayName,
        };
        currentRound.bets.push(bet);

        safeSend(ws, { type: 'bet_placed', data: { bet, balance: newBalance, stats } });
        broadcast({
          type: 'new_bet',
          data: {
            playerId: sessionId,
            amount,
            autoCashout,
            isBot: false,
            displayName: session.displayName,
            roundNumber: currentRound.roundNumber,
          },
        });
      } catch (err) {
        if (err instanceof StoreOfflineError) {
          safeSend(ws, { type: 'error', data: { message: 'Session store offline — bet rejected' } });
        } else {
          console.error('[place_bet] error:', err);
          safeSend(ws, { type: 'error', data: { message: 'Bet failed' } });
        }
      }
      return;
    }

    case 'cashout': {
      if (!currentRound || currentRound.phase !== 'FLYING') return;
      if (!sessionId) return;
      const bet = currentRound.bets.find((b) => b.playerId === sessionId);
      if (!bet || bet.cashedOut) return;
      const at = currentRound.currentMultiplier;
      await cashOutBet(bet, at, 'manual');
      return;
    }

    case 'reset_balance': {
      if (!sessionId) return;
      try {
        await setBalance(sessionId, DEFAULT_DEMO_BALANCE);
        safeSend(ws, { type: 'balance', data: { sessionId, balance: DEFAULT_DEMO_BALANCE } });
      } catch (err) {
        if (err instanceof StoreOfflineError) {
          safeSend(ws, { type: 'error', data: { message: 'Session store offline — reset failed' } });
        }
      }
      return;
    }
  }
}
