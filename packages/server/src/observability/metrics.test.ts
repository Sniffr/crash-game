/**
 * Unit tests for observeWalletCall (Task 8.2).
 *
 * Verifies the wrapper is TRANSPARENT (rethrows the original error unchanged)
 * and that it increments the correct counters + records latency.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  observeWalletCall,
  walletCallsTotal,
  walletErrorsTotal,
  walletLatencyMs,
  resetMetrics,
} from './metrics.js';
import { WalletError } from '@crash/wallet';

beforeEach(() => {
  resetMetrics();
});

describe('observeWalletCall', () => {
  it('on success: increments walletCallsTotal{outcome:ok} and records latency', async () => {
    const result = await observeWalletCall(
      { operator: 'op-success', endpoint: 'bet' },
      async () => 'ok-value',
    );
    expect(result).toBe('ok-value');

    const calls = await walletCallsTotal.get();
    const okEntry = calls.values.find((v) => {
      const l = v.labels as Record<string, string>;
      return l['operator'] === 'op-success' && l['endpoint'] === 'bet' && l['outcome'] === 'ok';
    });
    expect(okEntry?.value).toBe(1);

    // No error counter should be incremented on success
    const errorEntry = calls.values.find((v) => {
      const l = v.labels as Record<string, string>;
      return l['operator'] === 'op-success' && l['outcome'] === 'error';
    });
    expect(errorEntry).toBeUndefined();

    // Latency histogram recorded a sample (count >= 1 for this operator/endpoint)
    const lat = await walletLatencyMs.get();
    const countEntry = lat.values.find((v) => {
      const l = v.labels as Record<string, string>;
      const name = (v as { metricName?: string }).metricName;
      return name === 'wallet_latency_ms_count' && l['operator'] === 'op-success' && l['endpoint'] === 'bet';
    });
    expect(countEntry?.value).toBe(1);
  });

  it('on WalletError: increments walletCallsTotal{outcome:error} AND walletErrorsTotal{code}, rethrows unchanged', async () => {
    const sourceError = new WalletError({
      code: 'UPSTREAM_ERROR',
      message: 'operator 502',
      httpStatus: 502,
      retryable: true,
    });

    let caught: unknown;
    try {
      await observeWalletCall(
        { operator: 'op-err', endpoint: 'win' },
        async () => { throw sourceError; },
      );
    } catch (err) {
      caught = err;
    }

    // Identity check — exact same reference rethrown
    expect(caught).toBe(sourceError);
    expect(caught).toBeInstanceOf(WalletError);

    const calls = await walletCallsTotal.get();
    const errCallEntry = calls.values.find((v) => {
      const l = v.labels as Record<string, string>;
      return l['operator'] === 'op-err' && l['endpoint'] === 'win' && l['outcome'] === 'error';
    });
    expect(errCallEntry?.value).toBe(1);

    const errs = await walletErrorsTotal.get();
    const codeEntry = errs.values.find((v) => {
      const l = v.labels as Record<string, string>;
      return l['operator'] === 'op-err' && l['endpoint'] === 'win' && l['code'] === 'UPSTREAM_ERROR';
    });
    expect(codeEntry?.value).toBe(1);

    // Latency still recorded on the error path
    const lat = await walletLatencyMs.get();
    const countEntry = lat.values.find((v) => {
      const l = v.labels as Record<string, string>;
      const name = (v as { metricName?: string }).metricName;
      return name === 'wallet_latency_ms_count' && l['operator'] === 'op-err' && l['endpoint'] === 'win';
    });
    expect(countEntry?.value).toBe(1);
  });

  it('on non-WalletError throw: increments outcome:error but NOT walletErrorsTotal; rethrows original', async () => {
    const sourceError = new Error('boom (not a WalletError)');

    await expect(
      observeWalletCall(
        { operator: 'op-other', endpoint: 'rollback' },
        async () => { throw sourceError; },
      ),
    ).rejects.toBe(sourceError);

    const calls = await walletCallsTotal.get();
    const errCallEntry = calls.values.find((v) => {
      const l = v.labels as Record<string, string>;
      return l['operator'] === 'op-other' && l['endpoint'] === 'rollback' && l['outcome'] === 'error';
    });
    expect(errCallEntry?.value).toBe(1);

    const errs = await walletErrorsTotal.get();
    const codeEntry = errs.values.find((v) => {
      const l = v.labels as Record<string, string>;
      return l['operator'] === 'op-other';
    });
    // No code label populated for non-WalletError
    expect(codeEntry).toBeUndefined();
  });
});
