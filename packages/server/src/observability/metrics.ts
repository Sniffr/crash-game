/**
 * Metrics registry — Task 8.2 (Phase 8).
 *
 * Focused prom-client Registry holding the three wallet-call metrics that
 * power the §10.1 health summary and the §10.2 Prometheus exposition.
 *
 * Deliberately NO `collectDefaultMetrics(registry)` — we don't want Node
 * runtime metrics polluting this registry. Keeps test scrapes deterministic
 * and avoids label-cardinality noise.
 *
 * Label cardinality is BOUNDED on purpose:
 *   - `operator`  : operator id (cardinality = number of operators)
 *   - `endpoint`  : fixed enum {authenticate,balance,bet,win,rollback,roundEnd}
 *   - `outcome`   : fixed enum {ok, error}
 *   - `code`      : WalletError.code (bounded by spec §7 / adapter codes)
 *
 * Never include unbounded values (player ids, IPs, txn ids, request bodies)
 * as labels — that would blow up Prometheus storage.
 */

import { Registry, Counter, Histogram } from 'prom-client';
import { WalletError } from '@crash/wallet';

// ---------------------------------------------------------------------------
// Registry — a dedicated, non-default registry
// ---------------------------------------------------------------------------

export const registry = new Registry();

// ---------------------------------------------------------------------------
// Endpoint enum — the only legal `endpoint` label values
// ---------------------------------------------------------------------------

export type WalletEndpoint =
  | 'authenticate'
  | 'balance'
  | 'bet'
  | 'win'
  | 'rollback'
  | 'roundEnd';

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

/**
 * Total wallet calls broken down by operator + endpoint + outcome.
 * outcome ∈ {ok, error}. errorRate = sum(outcome='error') / sum(*) per operator.
 */
export const walletCallsTotal = new Counter({
  name: 'wallet_calls_total',
  help: 'Total wallet calls per operator/endpoint/outcome (ok|error).',
  labelNames: ['operator', 'endpoint', 'outcome'] as const,
  registers: [registry],
});

/**
 * Per-error-code counter — incremented IN ADDITION to walletCallsTotal{outcome:'error'}
 * when the thrown error is a WalletError, so per-code rates are scrapeable.
 */
export const walletErrorsTotal = new Counter({
  name: 'wallet_errors_total',
  help: 'Wallet call errors per operator/endpoint/code (WalletError.code).',
  labelNames: ['operator', 'endpoint', 'code'] as const,
  registers: [registry],
});

/**
 * Wallet call latency in MILLISECONDS, bucketed for p50/p95/p99 visibility.
 * Buckets cover the realistic operator round-trip range (5 ms .. 5 s).
 */
export const walletLatencyMs = new Histogram({
  name: 'wallet_latency_ms',
  help: 'Wallet call latency in milliseconds, per operator/endpoint.',
  labelNames: ['operator', 'endpoint'] as const,
  buckets: [5, 10, 25, 50, 100, 200, 500, 1000, 2500, 5000],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// observeWalletCall — transparent wrapper for outbound wallet calls
// ---------------------------------------------------------------------------

export interface ObserveWalletCallOpts {
  operator: string;
  endpoint: WalletEndpoint;
}

/**
 * Wrap a wallet call. Records latency + outcome; rethrows the original error
 * UNCHANGED so caller-side error mapping (WalletError discrimination, retry
 * classification, etc.) keeps working bit-for-bit.
 *
 * Pre/post observable behavior MUST match the un-wrapped call — the only
 * effect is metric mutation on the dedicated registry.
 */
export async function observeWalletCall<T>(
  opts: ObserveWalletCallOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const { operator, endpoint } = opts;
  // Hi-res monotonic timer — NOT wall clock; immune to system clock jumps.
  const startNs = process.hrtime.bigint();

  try {
    const result = await fn();
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    walletLatencyMs.labels({ operator, endpoint }).observe(elapsedMs);
    walletCallsTotal.labels({ operator, endpoint, outcome: 'ok' }).inc();
    return result;
  } catch (err) {
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    walletLatencyMs.labels({ operator, endpoint }).observe(elapsedMs);
    walletCallsTotal.labels({ operator, endpoint, outcome: 'error' }).inc();
    if (err instanceof WalletError) {
      walletErrorsTotal.labels({ operator, endpoint, code: err.code }).inc();
    }
    // Rethrow the ORIGINAL error — never wrap, never swallow.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Prometheus exposition + test helpers
// ---------------------------------------------------------------------------

/** Render the registry as Prometheus text-exposition v0.0.4. */
export function getMetricsText(): Promise<string> {
  return registry.metrics();
}

/** Reset all metric VALUES in the registry (preserves definitions). Tests only. */
export function resetMetrics(): void {
  registry.resetMetrics();
}
