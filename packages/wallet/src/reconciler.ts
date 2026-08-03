/**
 * reconciler.ts — Reconciliation store + diff engine (Task 8.1, spec §9).
 *
 * Owns the `reconciliation_runs` and `reconciliation_mismatches` tables in the
 * shared SQLite DB. A run diffs OUR recorded transactions (txn_idempotency, via
 * BetLog.listIdempotencyFiltered) against an operator's ledger (an injected
 * OperatorLedgerSource) over a half-open window [windowStart, windowEnd).
 *
 * Mirrors the class-owns-table / _ensureSchema() / lazy-prepared-statement /
 * keyset-listFiltered structure of AdminAudit and OperatorAudit.
 *
 * Run status lifecycle:
 *   RUNNING (transient — only persisted while in-flight) →
 *     OK         (no mismatches),
 *     MISMATCHES (≥1 mismatch), or
 *     FAILED     (the operator-ledger source threw).
 *
 * On source failure we DELIBERATELY resolve with a persisted FAILED run rather
 * than rethrowing — a single bad operator feed must not crash the daily
 * scheduler that iterates every operator. The POST endpoint surfaces FAILED to
 * the caller (202 with status:'FAILED'); callers can inspect/retry.
 */

export type ReconKind =
  | 'missing_on_operator'
  | 'missing_on_game'
  | 'amount_mismatch'
  | 'status_mismatch';

export type ReconStatus = 'OK' | 'MISMATCHES' | 'FAILED';

/** Status of a single transaction as derived/reported on either side. */
export type ReconTxnStatus = 'OK' | 'FAILED';

/** One transaction as the OPERATOR reports it, for the window. */
export interface OperatorLedgerTxn {
  txnId: string;
  amountMinor: number;
  status: ReconTxnStatus;
}

/**
 * Injected source: fetch the operator's ledger for the half-open window
 * [windowStart, windowEnd). The real per-operator reconciliation feed is wired
 * here (Phase-future); absent a feed the default source returns [].
 */
export type OperatorLedgerSource = (
  operatorId: string,
  windowStart: number,
  windowEnd: number,
) => Promise<OperatorLedgerTxn[]>;

export interface ReconRun {
  id: number;
  operatorId: string;
  windowStart: number;
  windowEnd: number;
  checkedCount: number;
  mismatchCount: number;
  status: ReconStatus;
  startedAt: number;
  finishedAt: number | null;
}

export interface ReconMismatch {
  txnId: string;
  kind: ReconKind;
  details: Record<string, unknown>;
}

export function deriveTxnAmountMinor(r: {
  kind: 'bet' | 'win' | 'rollback';
  amountMinor: number | null;
  winAmountMinor: number | null;
}): number {
  const v = r.kind === 'win' ? r.winAmountMinor : r.amountMinor;
  return v ?? 0;
}

/**
 * Status of OUR stored txn, derived from response_json: ok===false → FAILED,
 * otherwise OK. Mirrors admin.ts /transactions and operator.ts /operator-tx.
 */
export function deriveTxnStatus(responseJson: string): ReconTxnStatus {
  try {
    const resp = JSON.parse(responseJson) as Record<string, unknown>;
    if (resp['ok'] === false) return 'FAILED';
  } catch {
    // unparseable → treat as OK (it was stored, so it succeeded at store time)
  }
  return 'OK';
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------
