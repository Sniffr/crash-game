import { randomUUID } from 'node:crypto';
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
  TERMINAL_STATES,
  type Alerter,
  consoleAlerter,
} from '@crash/wallet';
import { getOperatorWiringDeps } from './operator-deps';

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

/**
 * Discriminating cashout: if the bet is operator-backed (has operatorId+betId),
 * routes through cashOutOperatorBet; otherwise calls the legacy cashOutBet.
 *
 * Always mutates the Bet object (sets cashedOut, cashoutMultiplier, profit) so the
 * crash/loss loop and broadcast keep working uniformly.
 *
 * On operator WalletError: marks the bet cashedOut to prevent retry and emits a
 * session-scoped cashout_pending frame with code "WIN_PENDING"
 * (Task 4.2 force-credit recovers it).
 *
 * NOTE: profit semantics are currency-dependent for operator bets —
 * for operator bets, profit is set to winAmountMinor (integer minor units),
 * not a decimal credit amount.
 */
export async function tryCashoutBet(
  bet: Bet,
  atMultiplier: number,
  source: 'manual' | 'auto',
): Promise<void> {
  if (bet.cashedOut) return;

  // Bots always use the legacy path
  if (bet.isBot) {
    return cashOutBet(bet, atMultiplier, source);
  }

  // Operator-backed path
  if (bet.operatorId && bet.betId && bet.currency && typeof bet.amountMinor === 'number') {
    const deps = getOperatorWiringDeps();
    if (!deps) {
      // Should never happen post-bootstrap — this would silently corrupt balances
      // with minor-unit math if we fell through to legacy cashOutBet.
      throw new Error('[tryCashoutBet] OperatorWiringDeps not initialized — bootstrap defect');
    }

    const client = deps.walletClientCache.get(bet.operatorId);
    if (!client) {
      // Operator paused or unknown — drive betLog through SETTLING → WIN_FAILED so
      // Task 4.2 force-credit can recover when the operator is resumed.
      const winTxnId = randomUUID();
      const winAmountMinor = Math.round(bet.amountMinor * atMultiplier);
      try {
        deps.betLog.transition(bet.betId, 'cashout_requested', { winTxnId, multiplier: atMultiplier, winAmountMinor });
        deps.betLog.transition(bet.betId, 'win_failed', { winTxnId, errorCode: 'OPERATOR_PAUSED_AT_CASHOUT' });
      } catch (transitionErr) {
        // Already terminal (e.g. already SETTLED/LOST/VOIDED) — log and continue
        console.error('[tryCashoutBet] OPERATOR_PAUSED betLog transition failed (likely already-terminal row):', transitionErr);
      }

      bet.cashedOut = true;
      bet.cashoutMultiplier = atMultiplier;
      bet.winTxnId = winTxnId;

      // Emit win_failed alert — this IS a WIN_FAILED situation (operator paused)
      const failedRow = deps.betLog.getById(bet.betId);
      if (failedRow) {
        (deps.alerter ?? consoleAlerter).emit({
          kind: 'win_failed',
          betRow: failedRow,
          source: 'cashout',
          error: 'OPERATOR_PAUSED_AT_CASHOUT',
        });
      }

      // Intentionally NO balanceMinor here: the /win call never happened so the
      // operator hasn't credited the player yet. The client should keep showing
      // the last-known balance (post-debit from /bet). Adding a stale balance
      // would be incorrect — the win credit will arrive via Task 4.2 force-credit.
      sendToSession(bet.playerId, {
        type: 'cashout_pending',
        data: {
          message: 'Win pending — operator unavailable; will be credited automatically.',
          code: 'WIN_PENDING',
          winTxnId,
        },
      });
      broadcast({
        type: 'cashout',
        data: {
          playerId: bet.playerId,
          multiplier: atMultiplier,
          profit: winAmountMinor,
          isBot: false,
          displayName: bet.displayName,
          source,
          isOperator: true,
        },
      });
      return;
    }

    const winTxnId = randomUUID();
    const multiplier = atMultiplier;
    const winAmountMinor = Math.round(bet.amountMinor * multiplier);

    try {
      const cashoutResult = await cashOutOperatorBet(
        { walletClient: client, betLog: deps.betLog, alerter: deps.alerter },
        {
          betId: bet.betId,
          winTxnId,
          multiplier,
          winAmountMinor,
          settledAt: Math.floor(Date.now() / 1000),
        },
      );

      // Success — mutate the bet object so the round loop sees it as cashed out
      bet.cashedOut = true;
      bet.cashoutMultiplier = multiplier;
      // profit carries winAmountMinor (minor units) for operator bets
      bet.profit = winAmountMinor;
      bet.winTxnId = winTxnId;

      broadcast({
        type: 'cashout',
        data: {
          playerId: bet.playerId,
          multiplier,
          profit: winAmountMinor,
          isBot: false,
          displayName: bet.displayName,
          source,
          isOperator: true,
        },
      });

      // Include post-credit balanceMinor so the iframe header updates live
      sendToSession(bet.playerId, {
        type: 'cashout_success',
        data: {
          multiplier,
          winAmountMinor,
          currency: cashoutResult.currency,
          source,
          balanceMinor: cashoutResult.balanceMinor,
        },
      });
    } catch (err) {
      // WalletError (after retries exhausted) or other error
      // Mark cashed out to prevent retry; recovery (Task 4.2) will force-credit.
      bet.cashedOut = true;
      bet.cashoutMultiplier = multiplier;
      bet.winTxnId = winTxnId;

      const walletErr = err instanceof WalletError ? err : null;
      // Debug log only — cashOutOperatorBet already emitted the alert via the Alerter.
      // Do NOT emit again here — that would fire two alerts per WIN_FAILED (single-alert invariant).
      console.error('[tryCashoutBet] WIN_FAILED for bet', bet.betId, err);

      // Intentionally NO balanceMinor here: the /win call failed so the operator
      // has NOT credited the player. Keep showing the post-debit balance from /bet.
      // Task 4.2 force-credit will eventually resolve this and can send a fresh balance.
      sendToSession(bet.playerId, {
        type: 'cashout_pending',
        data: {
          message: 'Win pending — contact support',
          code: 'WIN_PENDING',
          winTxnId,
          ...(walletErr ? { httpStatus: walletErr.httpStatus } : {}),
        },
      });

      // Still broadcast so the UI doesn't show the bet as alive
      broadcast({
        type: 'cashout',
        data: {
          playerId: bet.playerId,
          multiplier,
          profit: winAmountMinor,
          isBot: false,
          displayName: bet.displayName,
          source,
          isOperator: true,
        },
      });
    }
    return;
  }

  // Legacy demo path
  return cashOutBet(bet, atMultiplier, source);
}

// =============================================================================
// OPERATOR-BACKED BET ENGINE
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
   * Alerter emitted when a /win call fails after the client exhausted its retries,
   * or when the OPERATOR_PAUSED path drives a WIN_FAILED. Defaults to consoleAlerter.
   */
  alerter?: Alerter;
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

/** Return type for placeOperatorBet — surfaces the post-debit balance for the WS frame. */
export interface PlaceOperatorBetResult {
  row: BetRow;
  balanceMinor: number;
  currency: string;
}

/**
 * Place an operator-backed bet.
 *
 * 1. betLog.create({...}) → row state PENDING
 * 2. walletClient.bet({...}) — the client handles its own retry/backoff per spec §8
 * 3a. success → betLog.transition(betId,'bet_accepted',{betOpTxnId: resp.operatorTxnId}) → ARMED; return the ARMED BetRow + post-debit balanceMinor + currency
 * 3b. WalletError/WalletNetworkError → betLog.transition(betId,'bet_rejected',{errorCode: err.code}) → VOIDED; rethrow the WalletError
 *
 * No operator balance is ever mutated locally.
 * If betLog.create throws DuplicateBetIdError/DuplicateBetTxnIdError, it propagates (caller's bug).
 */
export async function placeOperatorBet(
  deps: OperatorBetDeps,
  input: PlaceOperatorBetInput,
): Promise<PlaceOperatorBetResult> {
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

    // Step 3a: success → ARMED; surface post-debit balance for the WS frame
    const row = betLog.transition(input.betId, 'bet_accepted', {
      betOpTxnId: resp.operatorTxnId,
    });
    return { row, balanceMinor: resp.balanceMinor, currency: resp.currency };
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

/** Return type for cashOutOperatorBet — surfaces the post-credit balance for the WS frame. */
export interface CashOutOperatorBetResult {
  row: BetRow;
  balanceMinor: number;
  currency: string;
}

/**
 * Cash out an operator-backed bet.
 *
 * Pre: bet is ARMED or FLYING (the round started). Transition path:
 *   betLog.transition(betId,'cashout_requested') → SETTLING
 *   walletClient.win({...})  (client retries internally per §8)
 *   success → transition(betId,'win_settled',{...}) → SETTLED; return SETTLED BetRow + post-credit balanceMinor + currency
 *   WalletError after client exhausted retries → transition(betId,'win_failed',{...}) → WIN_FAILED;
 *      emit via deps.alerter (or consoleAlerter fallback); rethrow the WalletError.
 *      DO NOT credit the player locally. DO NOT loop forever.
 *
 * If the bet is not in a cashable state, betLog.transition throws InvalidTransitionError — propagates.
 */
export async function cashOutOperatorBet(
  deps: OperatorBetDeps,
  input: CashOutOperatorBetInput,
): Promise<CashOutOperatorBetResult> {
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

    // Success → SETTLED; surface post-credit balance for the WS frame
    const row = betLog.transition(input.betId, 'win_settled', {
      winTxnId: input.winTxnId,
      winOpTxnId: resp.operatorTxnId,
      winAmountMinor: input.winAmountMinor,
      multiplier: input.multiplier,
    });
    return { row, balanceMinor: resp.balanceMinor, currency: resp.currency };
  } catch (err) {
    // Client exhausted its retries — transition to WIN_FAILED
    if (err instanceof WalletError) {
      const failedRow = betLog.transition(input.betId, 'win_failed', {
        winTxnId: input.winTxnId,
        errorCode: err.code,
      });

      (deps.alerter ?? consoleAlerter).emit({
        kind: 'win_failed',
        betRow: failedRow,
        source: 'cashout',
        error: err.code,
      });

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

    (deps.alerter ?? consoleAlerter).emit({
      kind: 'win_failed',
      betRow: failedRow,
      source: 'cashout',
      error: wrapped.code,
    });

    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// voidOperatorBet
// ---------------------------------------------------------------------------

/**
 * Void a single operator-backed bet: betLog ARMED|FLYING|PENDING -> ROLLBACK_PENDING
 * -> (walletClient.rollback) -> VOIDED. Idempotent-safe: if the row is already
 * terminal, it's a no-op. Used by operator-initiated session terminate (Task 3.3)
 * and the Phase 6 backoffice.
 *
 * Best-effort: returns 'skipped' on already-terminal / missing client / rollback
 * WalletError (left ROLLBACK_PENDING for the Phase 1.7 recovery worker).
 * Throws only on a bootstrap defect (deps not wired) or an unexpected BetLog
 * error (e.g. SQLite failure) — callers that must not fail (operator terminate)
 * wrap this in try/catch.
 *
 * Rollback txnId derivation mirrors recovery.ts: use existing row.rollbackTxnId
 * if present (from a prior attempt), else derive `rb-<betTxnId>` (deterministic,
 * dedupes via spec §9 on later retry).
 *
 * @returns 'voided' | 'skipped' (already terminal / not found / rollback failed)
 */
export async function voidOperatorBet(
  betId: string,
  reason: 'manual_void' | 'game_error',
): Promise<'voided' | 'skipped'> {
  const deps = getOperatorWiringDeps();
  if (!deps) {
    throw new Error('[voidOperatorBet] OperatorWiringDeps not initialized — bootstrap defect');
  }

  const row = deps.betLog.getById(betId);
  if (!row) return 'skipped';

  // Already terminal — nothing to do
  if (TERMINAL_STATES.has(row.state)) return 'skipped';

  // Get the wallet client — if operator vanished/paused, drive to ROLLBACK_PENDING
  // and leave it for the recovery worker; terminate must not fail on this.
  const client = deps.walletClientCache.get(row.operatorId);
  if (!client) {
    try {
      deps.betLog.transition(betId, 'rollback_started', { errorCode: reason });
    } catch (err) {
      // InvalidTransitionError: row already moved (race); skip silently
      if (!(err instanceof InvalidTransitionError)) {
        console.error('[voidOperatorBet] unexpected error driving ROLLBACK_PENDING (no client):', err);
      }
    }
    console.error('[voidOperatorBet] operator client not available — left ROLLBACK_PENDING for recovery:', {
      betId,
      operatorId: row.operatorId,
      reason,
    });
    return 'skipped';
  }

  // Transition to ROLLBACK_PENDING, persisting reason as errorCode
  try {
    deps.betLog.transition(betId, 'rollback_started', { errorCode: reason });
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      // Row already moved — skip silently (idempotent)
      return 'skipped';
    }
    throw err;
  }

  // Deterministic rollback txnId — mirrors recovery.ts line 134:
  //   const rollbackTxnId = row.rollbackTxnId ?? `rb-${row.betTxnId}`;
  // This ensures a later recovery pass dedupes via spec §9 instead of double-refunding.
  const freshRow = deps.betLog.getById(betId);
  const rollbackTxnId = freshRow?.rollbackTxnId ?? `rb-${row.betTxnId}`;

  try {
    await client.rollback({
      playerId: row.playerId,
      betTxnId: row.betTxnId,
      txnId: rollbackTxnId,
      reason,
    });

    deps.betLog.transition(betId, 'rollback_completed', { rollbackTxnId });
    return 'voided';
  } catch (err) {
    // Leave in ROLLBACK_PENDING for the Phase 1.7 recovery worker to re-drive.
    const rollbackErr = err instanceof WalletError ? err : null;
    const errorStr = rollbackErr ? rollbackErr.code : (err instanceof Error ? err.message : String(err));
    (deps.alerter ?? consoleAlerter).emit({
      kind: 'rollback_failed',
      betRow: row,
      reason,
      error: errorStr,
    });
    return 'skipped';
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
 *
 * NOTE: walletClient is intentionally not required here — no HTTP call is
 * needed on crash. The function only needs betLog.
 */
export async function expireOperatorBetsOnCrash(
  deps: { betLog: BetLog },
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
