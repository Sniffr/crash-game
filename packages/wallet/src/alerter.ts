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
      // Single structured line so log scrapers / Phase 8 can pick it up.
      // JSON.stringify is inside the try so any serialisation oddity is caught below.
      console.error(`[alert] ${event.kind}`, JSON.stringify({ ...event }));
    } catch {
      // JSON.stringify (or console.error) threw — degrade to a minimal partial-signal
      // line that still names the kind and bet id so on-call can grep it.
      // Uses only primitives so this inner path cannot throw.
      try {
        const betId = (event as { betRow?: { betId?: unknown } })?.betRow?.betId;
        console.error(`[alert] ${event?.kind ?? 'unknown'} (serialization failed)`, String(betId ?? '?'));
      } catch { /* truly nothing more we can do */ }
    }
  }
}

/** Shared default instance (Phase 8 replaces the wiring in index.ts/recovery). */
export const consoleAlerter: Alerter = new ConsoleAlerter();
