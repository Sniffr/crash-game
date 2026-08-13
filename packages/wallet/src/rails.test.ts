import { it, expect } from 'vitest';
import { railFor, decimalsFor, SUPPORTED_CURRENCIES } from './rails.js';

it('exposes the KES momo rail and 0dp UGX; unknown currencies have no rail', () => {
  const kes = railFor('KES');
  expect(kes?.payIn).toEqual({ method: 'momo', institutionCode: '1271' });
  expect(kes?.contact).toBe('phone');
  expect(railFor('ZAR')?.contact).toBe('email');
  expect(railFor('EUR')).toBeUndefined();

  expect(decimalsFor('UGX')).toBe(0);
  expect(decimalsFor('KES')).toBe(2);
});

it('only lists Eastern/Southern African currencies', () => {
  expect(SUPPORTED_CURRENCIES).toEqual(['KES', 'UGX', 'TZS', 'ZMW', 'ZAR']);
});
