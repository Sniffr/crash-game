/**
 * scheduler.ts — Thin daily reconciliation scheduler (Task 8.1, spec §9).
 *
 * Computes the ms until the next HH:MM UTC, setTimeout()s, then for each active
 * operator runs the Reconciler over the prior 24h half-open window [T-24h, T),
 * and reschedules for the following day.
 *
 * Deliberately minimal — the diff engine (Reconciler) and the on-demand POST
 * endpoint are the tested core; this is glue. It MUST NOT auto-start on import
 * and MUST NOT throw out of the timer: every per-operator run is wrapped in
 * try/catch (and the Reconciler itself resolves with a FAILED run on a bad feed
 * rather than throwing). Call it only from the server bootstrap path.
 */

import type { Reconciler, OperatorReader } from '@crash/wallet';

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;

/**
 * Milliseconds from `now` until the next occurrence of hourUtc:minuteUtc.
 */
export function msUntilNextRun(now: Date, hourUtc: number, minuteUtc: number): number {
  const next = new Date(now.getTime());
  next.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setTime(next.getTime() + DAY_MS);
  }
  return next.getTime() - now.getTime();
}

/**
 * Schedule a daily reconciliation sweep. Returns a stop() handle that clears the
 * pending timer (used by tests / graceful shutdown).
 */
export function scheduleDailyReconciliation(
  reconciler: Reconciler,
  registry: OperatorReader,
  opts: { hourUtc: number; minuteUtc: number },
): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    const delay = msUntilNextRun(new Date(), opts.hourUtc, opts.minuteUtc);
    timer = setTimeout(() => {
      void runSweep();
    }, delay);
    // Do not keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function runSweep(): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowEnd = now;
      const windowStart = now - DAY_SECONDS;
      const operators = registry.list({ status: 'active' });
      for (const op of operators) {
        try {
          await reconciler.run(op.operatorId, windowStart, windowEnd);
        } catch (err) {
          // Reconciler resolves FAILED rather than throwing, but guard anyway —
          // one operator must never abort the sweep.
          console.error(`[reconciliation] sweep failed for operator '${op.operatorId}' (continuing):`, err);
        }
      }
    } catch (err) {
      console.error('[reconciliation] daily sweep error (continuing):', err);
    } finally {
      // Always reschedule for the next day.
      schedule();
    }
  }

  schedule();
  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
