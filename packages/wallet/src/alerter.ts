import type { BetRow } from './bet-log.js';

// ---------------------------------------------------------------------------
// Alert event types
// ---------------------------------------------------------------------------

/** Operational alert kinds — a human needs to look at a stuck bet. */
export type AlertEvent =
  | { kind: 'win_failed'; betRow: BetRow; source: 'cashout' | 'recovery'; error?: string }
  | { kind: 'rollback_failed'; betRow: BetRow; reason: string; error?: string };

// ---------------------------------------------------------------------------
// Alerter interface
// ---------------------------------------------------------------------------

export interface Alerter {
  /** Emit an operational alert. MUST NOT throw — alerting failure must never
   *  break the money path. Implementations swallow their own errors. */
  emit(event: AlertEvent): void;
}

// ---------------------------------------------------------------------------
// Default implementation: structured single-line JSON to stderr
// ---------------------------------------------------------------------------

/** Default: structured single-line JSON to stderr. Phase 8 swaps Sentry/PagerDuty. */
export class ConsoleAlerter implements Alerter {
  emit(event: AlertEvent): void {
    try {
      const { kind } = event;
      // Single structured line so log scrapers / Phase 8 can pick it up.
      // JSON.stringify is inside the try so any serialisation oddity is swallowed.
      console.error(`[alert] ${kind}`, JSON.stringify({ ...event }));
    } catch {
      /* alerter must never throw */
    }
  }
}

/** Shared default instance (Phase 8 replaces the wiring in index.ts/recovery). */
export const consoleAlerter: Alerter = new ConsoleAlerter();
