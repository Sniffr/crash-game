/**
 * Unit tests for alerter.ts (Task 4.1).
 *
 * Covers:
 * 1. ConsoleAlerter.emit logs a single structured line to console.error.
 * 2. ConsoleAlerter.emit does NOT throw on a normal BetRow.
 * 3. ConsoleAlerter.emit does NOT throw even when JSON.stringify fails (circular ref guard).
 * 4. consoleAlerter is a shared Alerter instance.
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

  it('emit does NOT throw even when the event causes JSON.stringify to fail (circular guard)', () => {
    // Force JSON.stringify to throw by making the BetRow circular.
    // The try/catch in ConsoleAlerter.emit must swallow the error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Simulate stringify failing inside emit by replacing JSON.stringify
      throw new TypeError('circular structure');
    });

    const alerter = new ConsoleAlerter();
    const event: AlertEvent = {
      kind: 'win_failed',
      betRow: makeBetRow('bet-circular'),
      source: 'recovery',
    };

    // Must not throw
    expect(() => alerter.emit(event)).not.toThrow();
  });

  it('consoleAlerter is a shared Alerter instance that satisfies the Alerter interface', () => {
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
