// Pay-in / pay-out rails, keyed by currency: Eastern & Southern African, plus
// NGN (Fincra is Nigeria-based and NGN is the best-proven corridor on the
// account).
//
// `payIn.institutionCode` is Maplerad's momo institution code (from live
// GET /institutions) — a momo rail without one cannot be collected on
// Maplerad. Fincra collects through hosted Checkout, which is gated by
// currency rather than by rail, so it has no per-rail config here (see
// FINCRA_CURRENCIES).
export type Rail = {
  currency: string; country: string; decimals: number;
  payIn: { method: 'momo' | 'bank' | 'virtual'; institutionCode?: string };
  payOut: { type: 'MOMO' | 'NUBAN' | 'CBK' | 'BOG' | 'WALLET' };
  contact: 'phone' | 'email';
};

export const RAILS: Record<string, Rail> = {
  KES: { currency: 'KES', country: 'KE', decimals: 2, payIn: { method: 'momo', institutionCode: '1271' }, payOut: { type: 'CBK' }, contact: 'phone' },
  // UG/TZ codes came from Maplerad GET /institutions?type=momo. One code per
  // currency means one operator per market — MTN for Uganda, Airtel for
  // Tanzania, the larger of the two each place.
  // ponytail: route by MSISDN prefix if the other operator's share matters.
  UGX: { currency: 'UGX', country: 'UG', decimals: 0, payIn: { method: 'momo', institutionCode: '919' }, payOut: { type: 'MOMO' }, contact: 'phone' },
  TZS: { currency: 'TZS', country: 'TZ', decimals: 2, payIn: { method: 'momo', institutionCode: '214' }, payOut: { type: 'MOMO' }, contact: 'phone' },
  // Maplerad lists ZERO institutions for ZM and ZA, so it cannot collect these
  // at all — Fincra is the only pay-in route for them (card/EFT for ZAR,
  // mobile money + card for ZMW).
  ZMW: { currency: 'ZMW', country: 'ZM', decimals: 2, payIn: { method: 'momo' }, payOut: { type: 'MOMO' }, contact: 'phone' },
  ZAR: { currency: 'ZAR', country: 'ZA', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'WALLET' }, contact: 'email' },
  NGN: { currency: 'NGN', country: 'NG', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'NUBAN' }, contact: 'email' },
};

export const SUPPORTED_CURRENCIES = Object.keys(RAILS);
export function railFor(currency: string): Rail | undefined { return RAILS[currency]; }
/** Minor-unit exponent for a supported currency (UGX is 0dp). */
export function decimalsFor(currency: string): number { return RAILS[currency]?.decimals ?? 2; }
