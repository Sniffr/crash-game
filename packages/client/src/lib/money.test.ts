import { describe, it, expect } from 'vitest';
import { formatBalance, toMinor, fromMinor } from './money';

describe('formatBalance', () => {
  it('lobby real-money session (balanceMinor, no operatorId) renders dollars, not raw minor', () => {
    // Deposit $50 → balanceMinor 5000 → MUST show $50.00 (regression: showed $5000)
    const lobby = { lobbyPlayerId: 'p1', balanceMinor: 5000, currency: 'USD' };
    expect(formatBalance(5000, lobby)).toBe('$50.00');
  });
  it('operator session renders via minor units', () => {
    expect(formatBalance(9000, { operatorId: 'op', balanceMinor: 9000, currency: 'EUR' })).toBe('€90.00');
  });
  it('legacy demo session (no balanceMinor) renders the decimal balance in the default currency', () => {
    expect(formatBalance(1000, { })).toBe('KSh 1000.00');
  });
});

describe('minor-unit round trip', () => {
  it('$1 = 100 minor, $50 = 5000 minor', () => {
    expect(toMinor(1, 'USD')).toBe(100);
    expect(toMinor(50, 'USD')).toBe(5000);
    expect(fromMinor(100, 'USD')).toBe('$1.00');
    expect(fromMinor(4900, 'USD')).toBe('$49.00');
  });
});
