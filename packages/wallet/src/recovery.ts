// ---------------------------------------------------------------------------
// Crash-recovery worker — Task 1.7
//
// On startup, scans bet_log for non-terminal rows and drives them to terminal
// states via the appropriate wallet calls, per spec §10 + §9.
//
// Order matters:
//   1. PENDING sweep    — transitions rows to ROLLBACK_PENDING
//   2. ROLLBACK_PENDING — issues /rollback → VOIDED
//   3. SETTLING         — re-issues /win → SETTLED | WIN_FAILED
//
// Each row is wrapped in its own try/catch so one bad row never aborts the
// sweep. No Promise.all — serial processing prevents retry stampedes.
// ---------------------------------------------------------------------------

import { type BetRow } from './bet-log.js';
import type { PgBetLog } from './bet-log-pg.js';
import type { OperatorReader } from './operator-registry.js';
import { WalletClient } from './client.js';
import { WalletError } from './errors.js';
import type { Operator } from './types.js';
import { type Alerter, consoleAlerter } from './alerter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecoveryDeps {
  betLog: PgBetLog;
  registry: OperatorReader;
  /** Build (or look up cached) WalletClient for an Operator. Defaults to `new WalletClient(op)`. */
  clientFactory?: (op: Operator) => WalletClient;
  /** Alerter fired when a SETTLING row exhausts /win retries. Defaults to consoleAlerter. */
  alerter?: Alerter;
  /** Structured logger; defaults to console.warn. Receives the message and an extra payload. */
  log?: (msg: string, extra?: unknown) => void;
  /** Cap rows processed per state per run (protective). Default 500. */
  maxPerState?: number;
}

export interface RecoveryReport {
  pending:         { found: number; resolved: number; failed: number; skipped: number };
  rollbackPending: { found: number; resolved: number; failed: number; skipped: number };
  settling:        { found: number; resolved: number; failed: number; skipped: number };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runRecovery(deps: RecoveryDeps): Promise<RecoveryReport> {
  const {
    betLog,
    registry,
    clientFactory = (op: Operator) => new WalletClient(op),
    alerter = consoleAlerter,
    log = (msg: string, extra?: unknown) => console.warn('[recovery]', msg, extra ?? ''),
    maxPerState = 500,
  } = deps;

  const report: RecoveryReport = {
    pending:         { found: 0, resolved: 0, failed: 0, skipped: 0 },
    rollbackPending: { found: 0, resolved: 0, failed: 0, skipped: 0 },
    settling:        { found: 0, resolved: 0, failed: 0, skipped: 0 },
  };

  // Per-operator WalletClient cache
  const clientCache = new Map<string, WalletClient | null>();

  function getClient(operatorId: string): WalletClient | null {
    if (clientCache.has(operatorId)) {
      return clientCache.get(operatorId) ?? null;
    }
    const op = registry.getById(operatorId);
    if (!op) {
      log('[recovery] operator not found — caching null', { operatorId });
      clientCache.set(operatorId, null);
      return null;
    }
    try {
      const client = clientFactory(op);
      clientCache.set(operatorId, client);
      return client;
    } catch (err) {
      log('[recovery] clientFactory threw — caching null for this run', {
        operatorId,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      clientCache.set(operatorId, null);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 1: PENDING sweep
  // Transition each PENDING row to ROLLBACK_PENDING so it is picked up in step 2.
  // We track which betIds we moved so we can attribute their eventual resolution
  // to the `pending` bucket.
  // ---------------------------------------------------------------------------

  const pendingRows = await betLog.listByState('PENDING', maxPerState);
  report.pending.found = pendingRows.length;

  // Set of betIds that we moved from PENDING → ROLLBACK_PENDING in this run.
  // We resolve them inline in step 2 by processing them there, and count the
  // outcome back into `pending.resolved` / `pending.failed` / `pending.skipped`.
  const pendingOriginatedBetIds = new Set<string>();

  for (const row of pendingRows) {
    try {
      await betLog.transition(row.betId, 'rollback_started', {
        errorCode: 'recovery_pending_at_startup',
      });
      pendingOriginatedBetIds.add(row.betId);
    } catch (err) {
      // Programming bug or already-transitioned row — log and count as failed
      log('[recovery] PENDING transition error', { betId: row.betId, err });
      report.pending.failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: ROLLBACK_PENDING sweep
  // Re-list AFTER the PENDING sweep so newly-moved rows are included.
  // ---------------------------------------------------------------------------

  const rollbackPendingRows = await betLog.listByState('ROLLBACK_PENDING', maxPerState);
  report.rollbackPending.found = rollbackPendingRows.length;

  for (const row of rollbackPendingRows) {
    const isPendingOriginated = pendingOriginatedBetIds.has(row.betId);
    const bucket = isPendingOriginated ? report.pending : report.rollbackPending;

    // Deterministic rollback txnId: use existing or derive from betTxnId (spec §9)
    const rollbackTxnId = row.rollbackTxnId ?? `rb-${row.betTxnId}`;

    try {
      const client = getClient(row.operatorId);
      if (!client) {
        log('[recovery] operator not found for ROLLBACK_PENDING row', {
          betId: row.betId,
          operatorId: row.operatorId,
        });
        bucket.skipped++;
        continue;
      }

      await client.rollback({
        playerId: row.playerId,
        betTxnId: row.betTxnId,
        txnId: rollbackTxnId,
        reason: 'round_voided',
      });

      await betLog.transition(row.betId, 'rollback_completed', { rollbackTxnId });
      bucket.resolved++;
    } catch (err) {
      if (err instanceof WalletError) {
        log('[recovery] /rollback WalletError — row left in ROLLBACK_PENDING for next run', {
          betId: row.betId,
          code: err.code,
        });
      } else {
        log('[recovery] /rollback unexpected error', { betId: row.betId, err });
      }
      bucket.failed++;
    }
  }

  // Adjust rollbackPending.found: it should count only rows that were already
  // ROLLBACK_PENDING (not the ones we just moved from PENDING).
  report.rollbackPending.found = rollbackPendingRows.length - pendingOriginatedBetIds.size;

  // ---------------------------------------------------------------------------
  // Step 3: SETTLING sweep
  // Re-issue /win for each SETTLING row. The row must have winTxnId, multiplier,
  // and winAmountMinor (written by Sub-fix A at cashout_requested time).
  // ---------------------------------------------------------------------------

  const settlingRows = await betLog.listByState('SETTLING', maxPerState);
  report.settling.found = settlingRows.length;

  for (const row of settlingRows) {
    // Validate required fields for replay
    if (row.winTxnId == null || row.multiplier == null || row.winAmountMinor == null) {
      log('[recovery] SETTLING row missing replay fields — skipping (data corruption)', {
        betId: row.betId,
        winTxnId: row.winTxnId,
        multiplier: row.multiplier,
        winAmountMinor: row.winAmountMinor,
      });
      report.settling.skipped++;
      continue;
    }

    try {
      const client = getClient(row.operatorId);
      if (!client) {
        log('[recovery] operator not found for SETTLING row', {
          betId: row.betId,
          operatorId: row.operatorId,
        });
        report.settling.skipped++;
        continue;
      }

      const resp = await client.win({
        playerId: row.playerId,
        sessionId: row.sessionId,
        roundId: row.roundId,
        betId: row.betId,
        betTxnId: row.betTxnId,
        txnId: row.winTxnId,
        amountMinor: row.winAmountMinor,
        multiplier: row.multiplier,
        currency: row.currency,
        settledAt: Math.floor(Date.now() / 1000),
      });

      await betLog.transition(row.betId, 'win_settled', {
        winTxnId: row.winTxnId,
        winOpTxnId: resp.operatorTxnId,
        winAmountMinor: row.winAmountMinor,
        multiplier: row.multiplier,
      });
      report.settling.resolved++;
    } catch (err) {
      if (err instanceof WalletError) {
        let failedRow: BetRow;
        try {
          failedRow = await betLog.transition(row.betId, 'win_failed', {
            winTxnId: row.winTxnId,
            errorCode: err.code,
          });
        } catch (transErr) {
          log('[recovery] win_failed transition error', { betId: row.betId, transErr });
          report.settling.failed++;
          continue;
        }

        alerter.emit({
          kind: 'win_failed',
          betRow: failedRow,
          source: 'recovery',
          error: err.code,
        });
        report.settling.failed++;
      } else {
        log('[recovery] SETTLING unexpected error', { betId: row.betId, err });
        report.settling.failed++;
      }
    }
  }

  log('recovery complete', { report });
  return report;
}
