import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { type Bet, type HistoryEntry } from '@crash/shared/types';
import { MAX_STAKE, DEFAULT_CURRENCY } from '@crash/shared/config';
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
import type { Session } from '@crash/shared/types';
import { safeSend, broadcast } from './hub';
import { DEFAULT_GAME_ID } from '@crash/shared/rng';
import { getRoundForGame, findBetForSession } from '../game/round';
import { cashOutBet, tryCashoutBet, placeOperatorBet } from '../game/bets';
import { getOperatorWiringDeps } from '../game/operator-deps';
import { getLobbyWiringDeps } from '../game/lobby-deps';
import { WalletError } from '@crash/wallet';
import { InsufficientFundsError } from '@crash/wallet/wallet-ledger';

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
      if (!sessionId) { safeSend(ws, { type: 'error', data: { message: 'No session' } }); return; }

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

        // This session's own game engine — its round is independent of every
        // other game's phase.
        const currentRound = getRoundForGame(session.gameId ?? DEFAULT_GAME_ID);
        if (!currentRound || currentRound.phase !== 'BETTING') {
          safeSend(ws, { type: 'error', data: { message: 'Betting is closed for this round' } });
          return;
        }

        // Dual-bet: one bet per (session, slot) per round. slot 0 = first panel,
        // 1 = second panel. Defaults to 0 for legacy single-bet clients.
        const slot = data.slot === 1 ? 1 : 0;
        if (currentRound.bets.some((b) => b.playerId === sessionId && (b.slot ?? 0) === slot)) {
          safeSend(ws, { type: 'error', data: { message: 'You already have a bet in this slot' } }); return;
        }

        // Discriminate: lobby real-money vs operator-backed vs legacy demo session
        if (session.lobbyPlayerId) {
          return handlePlaceLobbyBet(ws, sessionId, session, data, attachSession);
        }
        const isOperatorSession =
          !!session.operatorId && !!session.playerId && !!session.currency &&
          typeof session.balanceMinor === 'number';

        if (isOperatorSession) {
          return handlePlaceOperatorBet(ws, sessionId, session, data, attachSession);
        }

        // Legacy demo path (byte-unchanged below this comment)
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
          gameId: session.gameId ?? DEFAULT_GAME_ID,
          slot,
        };
        currentRound.bets.push(bet);

        safeSend(ws, { type: 'bet_placed', data: { bet, balance: newBalance, stats } });
        broadcast({
          type: 'new_bet',
          data: {
            gameId: bet.gameId,
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
      if (!sessionId) return;
      const slot = data.slot === 1 ? 1 : 0;
      // Find the bet across engines (a session may play any game). Its own game's
      // round must still be FLYING — sibling games' phases are irrelevant.
      const hit = findBetForSession(sessionId, slot);
      if (!hit) return;
      const { round, bet } = hit;
      if (round.phase !== 'FLYING' || bet.cashedOut) return;
      await tryCashoutBet(bet, round.currentMultiplier, 'manual');
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

/**
 * @internal Exported for unit testing only — call handleMessage('place_bet', ...) in production.
 *
 * Handle place_bet for an operator-backed session.
 * Routes through placeOperatorBet → walletClient.bet → betLog ARMED.
 * On WalletError (e.g. INSUFFICIENT_FUNDS): sends error frame, does NOT push bet.
 */
export async function handlePlaceOperatorBet(
  ws: WebSocket,
  sessionId: string,
  session: Session,
  data: Record<string, unknown>,
  attachSession: (sessionId: string) => void,
): Promise<void> {
  const currentRound = getRoundForGame(session.gameId ?? DEFAULT_GAME_ID);
  if (!currentRound || currentRound.phase !== 'BETTING') {
    safeSend(ws, { type: 'error', data: { message: 'Betting is closed for this round' } });
    return;
  }

  // Parse amountMinor — operator clients send integer minor units
  const amountMinorRaw = data.amountMinor;
  const amountMinor = typeof amountMinorRaw === 'number' ? amountMinorRaw : Number(amountMinorRaw);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    safeSend(ws, { type: 'error', data: { message: 'amountMinor required (positive integer)' } });
    return;
  }

  // Parse optional autoCashout (same as legacy)
  const autoCashoutRaw = data.autoCashout == null ? undefined : Number(data.autoCashout);
  const autoCashout =
    autoCashoutRaw != null && Number.isFinite(autoCashoutRaw) && autoCashoutRaw > 1
      ? Math.round(autoCashoutRaw * 100) / 100
      : undefined;

  const deps = getOperatorWiringDeps();
  if (!deps) {
    console.error('[handlePlaceOperatorBet] OperatorWiringDeps not initialized');
    safeSend(ws, { type: 'error', data: { message: 'Server configuration error' } });
    return;
  }

  const client = deps.walletClientCache.get(session.operatorId!);
  if (!client) {
    safeSend(ws, { type: 'error', data: { message: 'Operator unavailable', code: 'OPERATOR_PAUSED' } });
    return;
  }

  // Generate stable bet IDs (slot-scoped so the two dual-bet slots don't collide)
  const slot = data.slot === 1 ? 1 : 0;
  const betId = `bet-${sessionId}-${currentRound.roundNumber}-s${slot}`;
  const betTxnId = randomUUID();
  const roundId = `rnd-${currentRound.roundNumber}`;
  const gameId = session.gameId ?? DEFAULT_GAME_ID;

  try {
    const placeResult = await placeOperatorBet(
      { walletClient: client, betLog: deps.betLog },
      {
        operatorId: session.operatorId!,
        playerId: session.playerId!,
        sessionId,
        roundId,
        currency: session.currency!,
        amountMinor,
        betId,
        betTxnId,
        gameId,
        autoCashout,
      },
    );

    // Build the Bet object and push to the round
    // NOTE: amount carries amountMinor here (legacy field); canonical stake is amountMinor.
    const bet: Bet = {
      playerId: sessionId,
      amount: amountMinor,
      autoCashout,
      cashedOut: false,
      isBot: false,
      displayName: session.displayName,
      operatorId: session.operatorId,
      betId,
      betTxnId,
      currency: session.currency,
      amountMinor,
      gameId,
      slot,
    };
    currentRound.bets.push(bet);

    attachSession(sessionId);
    sessionMeta.set(sessionId, { displayName: session.displayName });

    // Include post-debit balanceMinor so the iframe header updates live
    safeSend(ws, {
      type: 'bet_placed',
      data: { bet, isOperator: true, balanceMinor: placeResult.balanceMinor, currency: placeResult.currency },
    });
    broadcast({
      type: 'new_bet',
      data: {
        gameId,
        playerId: sessionId,
        amount: amountMinor,
        amountMinor,
        currency: session.currency,
        operatorId: session.operatorId,
        autoCashout,
        isBot: false,
        displayName: session.displayName,
        roundNumber: currentRound.roundNumber,
        isOperator: true,
      },
    });
  } catch (err) {
    if (err instanceof WalletError) {
      safeSend(ws, {
        type: 'error',
        data: {
          message: err.message,
          code: err.code,
          httpStatus: err.httpStatus,
          ...('balanceMinor' in err ? { balanceMinor: (err as WalletError & { balanceMinor?: number }).balanceMinor } : {}),
        },
      });
    } else {
      console.error('[handlePlaceOperatorBet] unexpected error:', err);
      safeSend(ws, { type: 'error', data: { message: 'Bet failed' } });
    }
  }
}

/**
 * Place a bet for a personal-lobby REAL-money session. Debits the Postgres
 * wallet_ledger atomically; the win (if any) is credited at cashout in
 * bets.ts:tryCashoutBet. On crash the stake is already gone (debited here), so
 * the round loop skips lobby bets in its loss handling.
 */
export async function handlePlaceLobbyBet(
  ws: WebSocket,
  sessionId: string,
  session: Session,
  data: Record<string, unknown>,
  attachSession: (sessionId: string) => void,
): Promise<void> {
  const currentRound = getRoundForGame(session.gameId ?? DEFAULT_GAME_ID);
  if (!currentRound || currentRound.phase !== 'BETTING') {
    safeSend(ws, { type: 'error', data: { message: 'Betting is closed for this round' } });
    return;
  }
  const amountMinorRaw = data.amountMinor ?? Math.round(Number(data.amount) * 100);
  const amountMinor = typeof amountMinorRaw === 'number' ? amountMinorRaw : Number(amountMinorRaw);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    safeSend(ws, { type: 'error', data: { message: 'amountMinor required (positive integer)' } });
    return;
  }
  const autoCashoutRaw = data.autoCashout == null ? undefined : Number(data.autoCashout);
  const autoCashout =
    autoCashoutRaw != null && Number.isFinite(autoCashoutRaw) && autoCashoutRaw > 1
      ? Math.round(autoCashoutRaw * 100) / 100
      : undefined;

  const deps = getLobbyWiringDeps();
  if (!deps) {
    safeSend(ws, { type: 'error', data: { message: 'Server configuration error' } });
    return;
  }

  if (deps.fx) {
    const kesMinor = await deps.fx.toKesMinor(amountMinor, session.currency ?? DEFAULT_CURRENCY);
    if (kesMinor > MAX_STAKE * 100) {
      safeSend(ws, { type: 'error', data: { message: `Max stake is KSh ${MAX_STAKE}` } });
      return;
    }
  }

  const slot = data.slot === 1 ? 1 : 0;
  const ref = `rnd-${currentRound.roundNumber}-s${slot}`;
  try {
    const balanceMinor = await deps.wallet.bet(session.lobbyPlayerId!, amountMinor, ref, session.currency ?? DEFAULT_CURRENCY);
    const bet: Bet = {
      playerId: sessionId,
      amount: amountMinor,
      autoCashout,
      cashedOut: false,
      isBot: false,
      displayName: session.displayName,
      currency: session.currency,
      amountMinor,
      gameId: session.gameId ?? DEFAULT_GAME_ID,
      lobbyPlayerId: session.lobbyPlayerId,
      slot,
    };
    currentRound.bets.push(bet);
    attachSession(sessionId);

    safeSend(ws, { type: 'bet_placed', data: { bet, isOperator: true, balanceMinor, currency: session.currency ?? DEFAULT_CURRENCY } });
    broadcast({
      type: 'new_bet',
      data: {
        gameId: bet.gameId, playerId: sessionId, amount: amountMinor, amountMinor, currency: session.currency,
        autoCashout, isBot: false, displayName: session.displayName,
        roundNumber: currentRound.roundNumber, isOperator: true,
      },
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      safeSend(ws, { type: 'error', data: { message: 'Insufficient balance', code: 'INSUFFICIENT_FUNDS' } });
    } else {
      console.error('[handlePlaceLobbyBet] unexpected error:', err);
      safeSend(ws, { type: 'error', data: { message: 'Bet failed' } });
    }
  }
}
