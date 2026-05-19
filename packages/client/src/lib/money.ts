/**
 * Currency formatting helpers for Galaxy Crash client.
 *
 * All amounts from the operator wallet are in integer minor units (e.g. EUR cents,
 * BTC satoshi). These helpers convert between minor units and display strings.
 */

export const DECIMALS_BY_CURRENCY: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  BTC: 8,
  ETH: 18,
  DEMO: 2,
};

export function decimalsFor(currency: string | undefined): number {
  return DECIMALS_BY_CURRENCY[currency ?? 'DEMO'] ?? 2;
}

export function symbolFor(currency: string | undefined): string {
  switch (currency) {
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'BTC': return '₿';
    case 'ETH': return 'Ξ';
    default: return '$';
  }
}

/** Convert an integer minor-unit amount to a display string with the currency symbol. */
export function fromMinor(minor: number, currency: string | undefined): string {
  const decimals = decimalsFor(currency);
  const value = minor / Math.pow(10, decimals);
  return `${symbolFor(currency)}${value.toFixed(Math.min(decimals, 8))}`;
}

/** Convert a decimal major-unit amount to integer minor units. */
export function toMinor(amount: number, currency: string | undefined): number {
  const decimals = decimalsFor(currency);
  return Math.round(amount * Math.pow(10, decimals));
}

/**
 * Format a balance for display.
 *
 * For operator sessions: `balanceMinor` is canonical; convert using the session currency.
 * For legacy demo sessions: `balance` is already in decimal credits.
 */
export function formatBalance(
  balance: number,
  session: { operatorId?: string; balanceMinor?: number; currency?: string } | null,
): string {
  if (session?.operatorId && typeof session.balanceMinor === 'number') {
    return fromMinor(session.balanceMinor, session.currency);
  }
  // Legacy demo: balance is decimal credits already
  return `$${balance.toFixed(2)}`;
}
