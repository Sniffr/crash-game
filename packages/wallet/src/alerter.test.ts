/**
 * Unit tests for alerter.ts (Task 4.1).
 *
 * Covers:
 * 1. ConsoleAlerter.emit logs a single structured line to console.error.
 * 2. ConsoleAlerter.emit does NOT throw on a normal BetRow.
 * 3. ConsoleAlerter.emit does NOT throw even when console.error itself throws.
 * 4. ConsoleAlerter.emit does NOT throw when JSON.stringify throws and emits a
 *    partial-signal fallback line ("[alert] <kind> (serialization failed) <betId>").
 * 5. consoleAlerter is a shared Alerter instance.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConsoleAlerter, consoleAlerter, type AlertEvent, type Alerter } from './alerter.js';
import type { BetRow } from './bet-log.js';

// ---------------------------------------------------------------------------
// Minimal BetRow fixture
// ---------------------------------------------------------------------------

function makeBetRow(betId = 'bet-test-1'): BetRow {
  return {
    betId,
    operatorId: 'op-test',
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId: 'rnd-1',
    currency: 'EUR',
    amountMinor: 10_000,
    state: 'WIN_FAILED',
    betTxnId: 'btxn-1',
    winTxnId: 'wtxn-1',
    rollbackTxnId: null,
    betOpTxnId: null,
    winOpTxnId: null,
    winAmountMinor: 20_000,
    multiplier: 2.0,
    errorCode: 'WALLET_ERROR',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_001,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsoleAlerter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emit logs a structured [alert] line to console.error for win_failed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const alerter = new ConsoleAlerter();
    const event: AlertEvent = {
      kind: 'win_failed',
      betRow: makeBetRow('bet-123'),
      source: 'cashout',
      error: 'WALLET_ERROR',
    };

    alerter.emit(event);

    expect(spy).toHaveBeenCalledOnce();
    const [prefix, jsonStr] = spy.mock.calls[0];
    expect(prefix).toBe('[alert] win_failed');
    expect(typeof jsonStr).toBe('string');
    const parsed = JSON.parse(jsonStr as string);
    expect(parsed.kind).toBe('win_failed');
    expect(parsed.source).toBe('cashout');
    expect(parsed.betRow.betId).toBe('bet-123');
    expect(parsed.error).toBe('WALLET_ERROR');
  });

  it('emit logs a structured [alert] line to console.error for rollback_failed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const alerter = new ConsoleAlerter();
    const event: AlertEvent = {
      kind: 'rollback_failed',
      betRow: makeBetRow('bet-456'),
      reason: 'manual_void',
      error: 'NETWORK_ERROR',
    };

    alerter.emit(event);

    expect(spy).toHaveBeenCalledOnce();
    const [prefix, jsonStr] = spy.mock.calls[0];
    expect(prefix).toBe('[alert] rollback_failed');
    const parsed = JSON.parse(jsonStr as string);
    expect(parsed.kind).toBe('rollback_failed');
    expect(parsed.reason).toBe('manual_void');
    expect(parsed.betRow.betId).toBe('bet-456');
  });

  it('emit never throws even if console.error itself throws', () => {
    // Exercises the outer try/catch: console.error throws (not JSON.stringify).
    // The event is JSON-safe, so stringify succeeds; it is console.error that blows up.
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new TypeError('console is broken');
    });

    const alerter = new ConsoleAlerter();
    const event: AlertEvent = {
      kind: 'win_failed',
      betRow: makeBetRow('bet-console-throws'),
      source: 'recovery',
    };

    // Must not throw regardless of console.error blowing up
    expect(() => alerter.emit(event)).not.toThrow();
  });

  it('emit does NOT throw when JSON.stringify throws and emits a partial-signal fallback line', () => {
    // Genuinely forces JSON.stringify to throw (not console.error).
    // Asserts: (a) emit does not throw, (b) the partial-signal fallback line is
    // written to console.error with "[alert] <kind> (serialization failed)" + betId.
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('boom — simulated BigInt/circular serialization failure');
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const alerter = new ConsoleAlerter();
    const betId = 'bet-stringify-throws';
    const event: AlertEvent = {
      kind: 'win_failed',
      betRow: makeBetRow(betId),
      source: 'cashout',
    };

    // Must not throw
    expect(() => alerter.emit(event)).not.toThrow();

    // The fallback line must have been emitted via the inner catch
    expect(consoleSpy).toHaveBeenCalledOnce();
    const [prefix, idStr] = consoleSpy.mock.calls[0];
    expect(prefix).toBe('[alert] win_failed (serialization failed)');
    expect(String(idStr)).toBe(betId);

    stringifySpy.mockRestore();
  });

  it('consoleAlerter (shared instance) satisfies the Alerter interface and emits normally', () => {
    // Type check: consoleAlerter implements Alerter
    const alerter: Alerter = consoleAlerter;

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    alerter.emit({
      kind: 'win_failed',
      betRow: makeBetRow('bet-shared'),
      source: 'recovery',
    });

    expect(spy).toHaveBeenCalledOnce();
  });
});
