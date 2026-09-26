import { describe, it, expect } from 'vitest';
import { formatKePhone, normalizeKePhone } from './phone';

describe('normalizeKePhone', () => {
  it.each([
    ['0712345678', '+254712345678'],
    ['712345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['+254 712 345 678', '+254712345678'],
    ['+254-712-345-678', '+254712345678'],
    ['0112345678', '+254112345678'],
    ['(0712) 345678', '+254712345678'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeKePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '0612345678', '07123456', '07123456789', '+255712345678', '2547123456'])('rejects %s', (input) => {
    expect(normalizeKePhone(input)).toBeNull();
  });
});

describe('formatKePhone', () => {
  it('groups the digits for display', () => {
    expect(formatKePhone('+254712345678')).toBe('+254 712 345 678');
  });
});
