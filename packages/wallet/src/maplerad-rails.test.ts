import { describe, it, expect } from 'vitest';
import { railFor, isDepositable, SUPPORTED_CURRENCIES } from './maplerad-rails.js';

it('KES is a ready momo rail; ZAR is listed but not depositable yet', () => {
  const kes = railFor('KES');
  expect(kes?.payIn).toEqual({ method: 'momo', institutionCode: '1271' });
  expect(kes?.contact).toBe('phone');
  expect(isDepositable('KES')).toBe(true);
  expect(SUPPORTED_CURRENCIES).toContain('ZAR');
  expect(isDepositable('ZAR')).toBe(false); // rail present, code not yet filled
  expect(railFor('EUR')).toBeUndefined();
});
