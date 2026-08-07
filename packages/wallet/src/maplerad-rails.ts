export type Rail = {
  currency: string; country: string; decimals: number;
  payIn: { method: 'momo' | 'bank' | 'virtual'; institutionCode?: string };
  // scheme 'MOBILEMONEY' → POST /transfers meta.scheme for a mobile-money payout.
  payOut: { type: 'MOMO' | 'NUBAN' | 'CBK' | 'BOG' | 'WALLET'; institutionCode?: string; scheme?: 'MOBILEMONEY' };
  contact: 'phone' | 'email';
};
// KES pay-in active. Pay-OUT institution codes come from live GET /institutions
// (?country=KE&type=MOMO) — until KES payOut.institutionCode is filled,
// isPayoutable() is false and withdrawals return WITHDRAW_UNAVAILABLE.
// ZMW/ZAR/NGN likewise stay gated until their codes are populated.
export const RAILS: Record<string, Rail> = {
  // LIVE M-PESA institution code = 1271 for both pay-in (verified against a real
  // collection in the commsBackend reference) and pay-out (MOMO). Note:
  // /institutions?type=MOMOCOLLECTION also lists MPESA=1291 — kept 1271 as it is
  // the only value proven to work. (Sandbox payout uses 187.)
  KES: { currency: 'KES', country: 'KE', decimals: 2, payIn: { method: 'momo', institutionCode: '1271' }, payOut: { type: 'MOMO', institutionCode: '1271', scheme: 'MOBILEMONEY' }, contact: 'phone' },
  ZMW: { currency: 'ZMW', country: 'ZM', decimals: 2, payIn: { method: 'momo' }, payOut: { type: 'MOMO', scheme: 'MOBILEMONEY' }, contact: 'phone' },
  ZAR: { currency: 'ZAR', country: 'ZA', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'WALLET' }, contact: 'email' },
  NGN: { currency: 'NGN', country: 'NG', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'NUBAN' }, contact: 'email' },
};
export const SUPPORTED_CURRENCIES = Object.keys(RAILS);
export function railFor(currency: string): Rail | undefined { return RAILS[currency]; }
export function isDepositable(currency: string): boolean {
  const r = RAILS[currency];
  return !!r && (r.payIn.method !== 'momo' ? false : !!r.payIn.institutionCode);
}
// Payout is currently mobile-money only (POST /transfers, scheme MOBILEMONEY):
// requires a phone contact + a populated payOut institution code.
export function isPayoutable(currency: string): boolean {
  const r = RAILS[currency];
  return !!r && r.payOut.scheme === 'MOBILEMONEY' && r.contact === 'phone' && !!r.payOut.institutionCode;
}
