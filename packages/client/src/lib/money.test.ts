import { describe, it, expect } from 'vitest';
import { formatBalance, formatCredits, toMinor, fromMinor } from './money';

describe('formatCredits', () => {
  it('renders demo-path decimal credits in the default currency', () => {
    expect(formatCredits(1000)).toBe('KSh 1000.00');
    expect(formatCredits(0)).toBe('KSh 0.00');
    expect(formatCredits(-12.5)).toBe('KSh -12.50');
  });

  it('is the same formatter formatBalance uses for a demo session', () => {
    // SessionStats are produced only by the server's demo path (recordBet /
    // recordWin) and are decimal credits — the same units as the demo balance.
    // If these ever diverge, the stats panel is showing the wrong scale.
    expect(formatCredits(1000)).toBe(formatBalance(1000, {}));
  });

  it('is NOT interchangeable with fromMinor — the units differ by 100x', () => {
    // Guards the bug this replaced: stats formatted as if they were minor units
    // (or a money balance formatted as credits) is a 100x display error.
    expect(formatCredits(50)).toBe('KSh 50.00');
    expect(fromMinor(50, 'KES')).toBe('KSh 0.50');
  });
});

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

describe('ZMW and ZAR', () => {
  it('formats ZMW and ZAR', () => {
    expect(fromMinor(150000, 'ZMW')).toBe('K1500.00');
    expect(fromMinor(150000, 'ZAR')).toBe('R1500.00');
  });
});
