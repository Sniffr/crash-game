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

it('Maplerad can collect the momo currencies it has institutions for, and no others', () => {
  // Verified against Maplerad GET /institutions: KE/UG/TZ have momo
  // institutions, ZM and ZA return none, NGN is a bank rail.
  expect(railFor('UGX')?.payIn.institutionCode).toBe('919'); // MTN Uganda
  expect(railFor('TZS')?.payIn.institutionCode).toBe('214'); // Airtel Tanzania
  expect(railFor('ZMW')?.payIn.institutionCode).toBeUndefined();
  expect(railFor('ZAR')?.payIn.method).toBe('bank');
  expect(railFor('NGN')?.payIn.method).toBe('bank');
});

it('lists the Eastern/Southern African currencies plus NGN', () => {
  expect(SUPPORTED_CURRENCIES).toEqual(['KES', 'UGX', 'TZS', 'ZMW', 'ZAR', 'NGN']);
  expect(railFor('NGN')?.contact).toBe('email'); // bank rail — no phone collected
});
