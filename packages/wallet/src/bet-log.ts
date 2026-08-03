import { type BetState, type BetEvent, nextState, InvalidTransitionError } from './state-machine.js';
import { type Cursor, encodeCursor, decodeCursor as _decodeCursor } from './cursor.js';
export type { Cursor } from './cursor.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class BetNotFoundError extends Error {
  readonly betId: string;
  constructor(betId: string) {
    super(`Bet '${betId}' not found`);
    this.name = 'BetNotFoundError';
    this.betId = betId;
  }
}

export class DuplicateBetIdError extends Error {
  readonly betId: string;
  constructor(betId: string) {
    super(`A bet with id '${betId}' already exists`);
    this.name = 'DuplicateBetIdError';
    this.betId = betId;
  }
}

export class DuplicateBetTxnIdError extends Error {
  readonly betTxnId: string;
  constructor(betTxnId: string) {
    super(`A bet with bet_txn_id '${betTxnId}' already exists`);
    this.name = 'DuplicateBetTxnIdError';
    this.betTxnId = betTxnId;
  }
}

export class IdempotencyMismatchError extends Error {
  readonly txnId: string;
  constructor(txnId: string) {
    super(`Idempotency mismatch for txn_id '${txnId}': same txn_id, different request_hash`);
    this.name = 'IdempotencyMismatchError';
    this.txnId = txnId;
  }
}

// ---------------------------------------------------------------------------
// Derive Statement type without importing the namespace type
// ---------------------------------------------------------------------------

export interface BetRow {
  betId: string;
  operatorId: string;
  playerId: string;
  sessionId: string;
  roundId: string;
  currency: string;
  amountMinor: number;
  state: BetState;
  betTxnId: string;
  winTxnId: string | null;
  rollbackTxnId: string | null;
  betOpTxnId: string | null;
  winOpTxnId: string | null;
  winAmountMinor: number | null;
  multiplier: number | null;
  errorCode: string | null;
  /** Catalogue game this bet belongs to (multi-game, 2026-07-24). */
  gameId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * RoundSummary: derived by GROUP BY round_id over bet_log rows.
 * There is NO rounds table — rounds exist only as groups of bet_log rows.
 * Fields unavailable from bet_log (server seeds, crash point from RNG, roundNumber)
 * are omitted — the live round loop's RNG seeds are NOT persisted (Phase-future gap).
 */
export interface RoundSummary {
  roundId: string;
  /** All distinct operator ids that have bets in this round */
  operatorIds: string[];
  betCount: number;
  distinctPlayers: number;
  /** Total amount wagered, per currency */
  totalAmountMinorByCurrency: Record<string, number>;
  /** Max multiplier seen across settled bets in this round (null if no settled bets) */
  maxMultiplier: number | null;
  firstAt: number;   // unix seconds
  lastAt: number;    // unix seconds
}

/**
 * A txn_idempotency row joined with bet_log fields for the §7.1 transactions API.
 */
export interface IdempotencyWithBet {
  txnId: string;
  operatorId: string;
  kind: TxnKind;
  requestHash: string;
  responseJson: string;
  createdAt: number;
  // Joined from bet_log:
  playerId: string | null;
  betId: string | null;
  // Derived per-kind from bet_log:
  operatorTxnId: string | null;
  amountMinor: number | null;
  currency: string | null;
  winAmountMinor: number | null;
}

// ---------------------------------------------------------------------------
// Financial report types (Task 5.4 — spec §8.1 / §8.2)
// ---------------------------------------------------------------------------

/**
 * A single row in a financial GGR/NGR report.
 *
 * Stake/win definitions (mirrored in SQL below):
 *   STAKE = sum(amount_minor) for SETTLED, LOST, WIN_FAILED rows.
 *     - SETTLED: debit happened, credit happened — fully closed.
 *     - LOST: debit happened, no credit (multiplier < cashout) — fully closed.
 *     - WIN_FAILED: debit happened, credit PENDING (operator hasn't responded) —
 *       the debit is real so we count the stake. We do NOT count the win because
 *       the operator has not confirmed credit. When force-credit later transitions
 *       WIN_FAILED → SETTLED, future reports will include the win.
 *     - VOIDED: full rollback — stake was refunded; exclude from stake.
 *     - Mid-flight (PENDING/ARMED/FLYING/SETTLING/ROLLBACK_PENDING): not financially
 *       closed; exclude entirely.
 *   WIN = sum(win_amount_minor) for SETTLED rows only.
 *   GGR = STAKE − WIN.
 *   NGR = GGR − bonuses; bonuses = 0 in v1 (field reserved for future use).
 *
 * NEVER mix currencies in a single row. All sums are per (operatorId, currency).
 */
export interface FinancialRow {
  /** null when 'operator' is not in the groupBy axes (cross-operator aggregate). */
  operatorId: string | null;
  /** null when 'currency' is not in the groupBy axes (cross-currency aggregate). */
  currency: string | null;
  /** null when 'day' is not in the groupBy axes (cross-day aggregate). */
  day: string | null;
  /** Count of financially-closed bets (SETTLED | LOST | WIN_FAILED). */
  betCount: number;
  stakeMinor: number;
  winMinor: number;
  /** stakeMinor − winMinor */
  ggrMinor: number;
  /** GGR − bonuses; bonuses = 0 in v1 */
  ngrMinor: number;
}

/**
 * A single player session, derived by GROUP BY session_id over bet_log rows
 * (operator-backoffice spec §6.1). There is NO sessions table in bet_log —
 * sessions exist here only as groups of bet rows.
 *
 * Phase-future gaps:
 *   - endedAt is the LAST-bet timestamp (MAX(created_at)) used as a proxy; there
 *     is no persisted session-end timestamp in bet_log.
 *   - currency is a deterministic pick (MIN(currency)); a session is normally
 *     single-currency, but bet_log does not enforce that, so we pick one stably.
 */
export interface PlayerSessionSummary {
  sessionId: string;
  /** MIN(created_at) — first bet in the session (unix seconds). */
  startedAt: number;
  /** MAX(created_at) — last-bet timestamp; Phase-future proxy for session end (unix seconds). */
  endedAt: number;
  /** Deterministic pick: MIN(currency) across the session's bets. */
  currency: string;
  betCount: number;
  /** SUM(amount_minor) across the session's bets. */
  stakeMinor: number;
  /** SUM(win_amount_minor) for SETTLED bets only. */
  winMinor: number;
}

export interface FinancialFilter {
  operatorId?: string;
  currency?: string;
  /** Unix seconds inclusive lower bound on bet created_at */
  from?: number;
  /** Unix seconds exclusive upper bound on bet created_at */
  to?: number;
  /**
   * At least one required. Controls GROUP BY granularity.
   * Unknown values throw (caller should 400).
   */
  groupBy: ReadonlyArray<'operator' | 'currency' | 'day'>;
}

export interface CreateBetInput {
  betId: string;
  operatorId: string;
  playerId: string;
  sessionId: string;
  roundId: string;
  currency: string;
  amountMinor: number;
  betTxnId: string;
  /** Catalogue game (multi-game, 2026-07-24). Defaults to 'galaxy-crash'. */
  gameId?: string;
}

export type TxnKind = 'bet' | 'win' | 'rollback';

export interface IdempotencyEntry {
  txnId: string;
  operatorId: string;
  kind: TxnKind;
  requestHash: string;
  responseJson: string;
  createdAt: number;
}
