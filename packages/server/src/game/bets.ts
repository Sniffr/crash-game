import { type Bet, type HistoryEntry } from '@crash/shared/types';
import {
  adjustBalance,
  appendHistory,
  recordWin,
  StoreOfflineError,
  getStats,
} from '../store';
import { broadcast, sendToSession } from '../ws/hub';
import {
  type WalletClient,
  type BetLog,
  type BetRow,
  WalletError,
  WalletNetworkError,
  ResponseSignatureError,
  InvalidTransitionError,
} from '@crash/wallet';

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

// =============================================================================
// OPERATOR-BACKED BET ENGINE
// TODO(Task 3.1): wire placeOperatorBet into the WS place_bet handler once launch creates operator-backed sessions
// TODO(Task 3.1): wire cashOutOperatorBet into the WS cashout handler once launch creates operator-backed sessions
// TODO(Task 3.1): wire expireOperatorBetsOnCrash into the crash handler once launch creates operator-backed sessions
// =============================================================================

// ---------------------------------------------------------------------------
// Dependency injection container
// ---------------------------------------------------------------------------

export interface OperatorBetDeps {
  /** WalletClient from @crash/wallet, already constructed for the operator */
  walletClient: WalletClient;
  /** BetLog from @crash/wallet, shared instance */
  betLog: BetLog;
  /**
   * Called when a /win call fails after the client exhausted its retries.
   * TODO(Task 4.1): replace with Alerter.
   */
  onWinFailed?: (betRow: BetRow) => void;
}

// ---------------------------------------------------------------------------
// placeOperatorBet
// ---------------------------------------------------------------------------

export interface PlaceOperatorBetInput {
  operatorId: string;
  playerId: string;
  sessionId: string;
  roundId: string;
  currency: string;
  amountMinor: number;
  betId: string;       // caller-generated stable id
  betTxnId: string;    // caller-generated idempotency key for /bet
  gameId: string;      // e.g. 'galaxy-crash'
  autoCashout?: number;
}

/**
 * Place an operator-backed bet.
 *
 * 1. betLog.create({...}) → row state PENDING
 * 2. walletClient.bet({...}) — the client handles its own retry/backoff per spec §8
 * 3a. success → betLog.transition(betId,'bet_accepted',{betOpTxnId: resp.operatorTxnId}) → ARMED; return the ARMED BetRow
 * 3b. WalletError/WalletNetworkError → betLog.transition(betId,'bet_rejected',{errorCode: err.code}) → VOIDED; rethrow the WalletError
 *
 * No operator balance is ever mutated locally.
 * If betLog.create throws DuplicateBetIdError/DuplicateBetTxnIdError, it propagates (caller's bug).
 */
export async function placeOperatorBet(
  deps: OperatorBetDeps,
  input: PlaceOperatorBetInput,
): Promise<BetRow> {
  const { walletClient, betLog } = deps;

  // Step 1: create PENDING log entry
  betLog.create({
    betId: input.betId,
    operatorId: input.operatorId,
    playerId: input.playerId,
    sessionId: input.sessionId,
    roundId: input.roundId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    betTxnId: input.betTxnId,
  });

  // Step 2: call the operator wallet
  try {
    const resp = await walletClient.bet({
      playerId: input.playerId,
      sessionId: input.sessionId,
      roundId: input.roundId,
      betId: input.betId,
      txnId: input.betTxnId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      gameId: input.gameId,
      placedAt: Math.floor(Date.now() / 1000),
    });

    // Step 3a: success → ARMED
    return betLog.transition(input.betId, 'bet_accepted', {
      betOpTxnId: resp.operatorTxnId,
    });
  } catch (err) {
    // Step 3b: discriminate confirmed-rejection vs ambiguous failure.
    //
    // "Confirmed not debited" = signed 4xx business rejection:
    //   WalletError (not Network, not signature) with httpStatus 400–499.
    // Everything else is ambiguous: the operator MAY have debited the player.
    const walletErr = err instanceof WalletError
      ? err
      : new WalletNetworkError(err instanceof Error ? err.message : String(err));

    const isConfirmedRejection =
      walletErr instanceof WalletError
      && !(walletErr instanceof WalletNetworkError)
      && !(walletErr instanceof ResponseSignatureError)
      && walletErr.httpStatus >= 400 && walletErr.httpStatus < 500;

    if (isConfirmedRejection) {
      // Signed 4xx: operator definitively says "no debit happened" → VOIDED
      betLog.transition(input.betId, 'bet_rejected', { errorCode: walletErr.code });
    } else {
      // Ambiguous /bet failure — operator may have debited. Task 1.7 issues
      // /rollback (spec §5.5: unknown txnId => 200 noop).
      betLog.transition(input.betId, 'rollback_started', { errorCode: walletErr.code });
    }

    throw walletErr;
  }
}

// ---------------------------------------------------------------------------
// cashOutOperatorBet
// ---------------------------------------------------------------------------

export interface CashOutOperatorBetInput {
  betId: string;
  winTxnId: string;       // caller-generated idempotency key for /win
  multiplier: number;
  winAmountMinor: number; // computed by caller (stake * multiplier in minor units)
  settledAt: number;      // unix seconds
}

/**
 * Cash out an operator-backed bet.
 *
 * Pre: bet is ARMED or FLYING (the round started). Transition path:
 *   betLog.transition(betId,'cashout_requested') → SETTLING
 *   walletClient.win({...})  (client retries internally per §8)
 *   success → transition(betId,'win_settled',{...}) → SETTLED; return SETTLED BetRow
 *   WalletError after client exhausted retries → transition(betId,'win_failed',{...}) → WIN_FAILED;
 *      call deps.onWinFailed?.(row) (else console.error); rethrow the WalletError.
 *      DO NOT credit the player locally. DO NOT loop forever.
 *
 * If the bet is not in a cashable state, betLog.transition throws InvalidTransitionError — propagates.
 */
export async function cashOutOperatorBet(
  deps: OperatorBetDeps,
  input: CashOutOperatorBetInput,
): Promise<BetRow> {
  const { walletClient, betLog } = deps;

  // Transition to SETTLING, persisting winTxnId as the idempotency key BEFORE
  // the /win HTTP call. If the process dies after the operator credits but
  // before win_settled commits, Task 1.7 can read winTxnId from the SETTLING
  // row and safely retry /win without double-credit risk (spec §9).
  const settlingRow = betLog.transition(input.betId, 'cashout_requested', { winTxnId: input.winTxnId, multiplier: input.multiplier, winAmountMinor: input.winAmountMinor });

  // Call the operator /win endpoint
  try {
    const resp = await walletClient.win({
      playerId: settlingRow.playerId,
      sessionId: settlingRow.sessionId,
      roundId: settlingRow.roundId,
      betId: input.betId,
      betTxnId: settlingRow.betTxnId,
      txnId: input.winTxnId,
      amountMinor: input.winAmountMinor,
      multiplier: input.multiplier,
      currency: settlingRow.currency,
      settledAt: input.settledAt,
    });

    // Success → SETTLED
    return betLog.transition(input.betId, 'win_settled', {
      winTxnId: input.winTxnId,
      winOpTxnId: resp.operatorTxnId,
      winAmountMinor: input.winAmountMinor,
      multiplier: input.multiplier,
    });
  } catch (err) {
    // Client exhausted its retries — transition to WIN_FAILED
    if (err instanceof WalletError) {
      const failedRow = betLog.transition(input.betId, 'win_failed', {
        winTxnId: input.winTxnId,
        errorCode: err.code,
      });

      if (deps.onWinFailed) {
        deps.onWinFailed(failedRow);
      } else {
        // TODO(Task 4.1): replace with Alerter
        console.error('[bets] WIN_FAILED', failedRow);
      }

      throw err;
    }

    // Unexpected non-WalletError (guard defensively)
    const wrapped = new WalletNetworkError(
      err instanceof Error ? err.message : String(err),
    );
    const failedRow = betLog.transition(input.betId, 'win_failed', {
      winTxnId: input.winTxnId,
      errorCode: wrapped.code,
    });

    if (deps.onWinFailed) {
      deps.onWinFailed(failedRow);
    } else {
      // TODO(Task 4.1): replace with Alerter
      console.error('[bets] WIN_FAILED', failedRow);
    }

    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// expireOperatorBetsOnCrash
// ---------------------------------------------------------------------------

/**
 * For a crash: every still-ARMED/FLYING operator bet for the round loses.
 * betLog.transition(betId,'round_crashed') → LOST.
 * NO operator call — operator already debited at /bet.
 *
 * Returns the count of bets transitioned. Never throws for an already-terminal
 * bet — skips those silently.
 */
export async function expireOperatorBetsOnCrash(
  deps: OperatorBetDeps,
  roundId: string,
): Promise<number> {
  const { betLog } = deps;
  const rows = betLog.listByRound(roundId);
  let count = 0;

  for (const row of rows) {
    if (row.state !== 'ARMED' && row.state !== 'FLYING') {
      // Terminal or other state — skip silently
      continue;
    }
    try {
      betLog.transition(row.betId, 'round_crashed');
      count++;
    } catch (e) {
      if (!(e instanceof InvalidTransitionError)) throw e;
      // Row left ARMED/FLYING window or already terminal — skip silently.
    }
  }

  return count;
}
