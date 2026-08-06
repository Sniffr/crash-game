export type Rail = {
  currency: string; country: string; decimals: number;
  payIn: { method: 'momo' | 'bank' | 'virtual'; institutionCode?: string };
  payOut: { type: 'MOMO' | 'NUBAN' | 'CBK' | 'BOG' | 'WALLET' };
  contact: 'phone' | 'email';
};
// KES active. ZMW/ZAR/NGN listed for signup but institutionCode filled in later
// (pulled from live GET /institutions) — until then isDepositable() is false.
export const RAILS: Record<string, Rail> = {
  KES: { currency: 'KES', country: 'KE', decimals: 2, payIn: { method: 'momo', institutionCode: '1271' }, payOut: { type: 'CBK' }, contact: 'phone' },
  ZMW: { currency: 'ZMW', country: 'ZM', decimals: 2, payIn: { method: 'momo' }, payOut: { type: 'MOMO' }, contact: 'phone' },
  ZAR: { currency: 'ZAR', country: 'ZA', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'WALLET' }, contact: 'email' },
  NGN: { currency: 'NGN', country: 'NG', decimals: 2, payIn: { method: 'bank' }, payOut: { type: 'NUBAN' }, contact: 'email' },
};
export const SUPPORTED_CURRENCIES = Object.keys(RAILS);
export function railFor(currency: string): Rail | undefined { return RAILS[currency]; }
export function isDepositable(currency: string): boolean {
  const r = RAILS[currency];
  return !!r && (r.payIn.method !== 'momo' ? false : !!r.payIn.institutionCode);
}
