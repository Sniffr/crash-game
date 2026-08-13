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
  KES: 2,
  UGX: 0,
  TZS: 2,
  ZMW: 2,
  ZAR: 2,
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
    case 'KES': return 'KSh ';
    case 'UGX': return 'USh ';
    case 'TZS': return 'TSh ';
    case 'ZMW': return 'K';
    case 'ZAR': return 'R';
    case 'BTC': return '₿';
    case 'ETH': return 'Ξ';
    default: return 'KSh ';
  }
}

/** Symbol for the app's default settlement currency (demo balance / stats). */
export const DEFAULT_SYMBOL = symbolFor('KES');

/** Convert an integer minor-unit amount to a display string with the currency symbol. */
export function fromMinor(minor: number, currency: string | undefined): string {
  const decimals = decimalsFor(currency);
  const value = minor / Math.pow(10, decimals);
  return `${symbolFor(currency)}${value.toFixed(Math.min(decimals, 8))}`;
}

/** Convert a decimal major-unit amount to integer minor units. */
export function toMinor(amount: number, currency: string | undefined): number {
  const decimals = decimalsFor(currency);
  const minor = Math.round(amount * Math.pow(10, decimals));
  // Fail loud rather than silently corrupt: high-decimal currencies (e.g. ETH 18dp) need BigInt — not supported yet.
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`toMinor: ${amount} ${currency ?? 'DEMO'} (${decimals}dp) exceeds safe integer range`);
  }
  return minor;
}

/**
 * Format a legacy demo-session amount (decimal credits in the default currency).
 *
 * Only for values the server produces on the demo path — the demo balance and
 * SessionStats. A money session's amounts are integer minor units and must go
 * through `fromMinor` with that session's currency instead.
 */
export function formatCredits(amount: number): string {
  return `${DEFAULT_SYMBOL}${amount.toFixed(2)}`;
}

/**
 * Format a balance for display.
 *
 * For operator sessions: `balanceMinor` is canonical; convert using the session currency.
 * For legacy demo sessions: `balance` is already in decimal credits.
 */
export function formatBalance(
  balance: number,
  session: { operatorId?: string; lobbyPlayerId?: string; balanceMinor?: number; currency?: string } | null,
): string {
  // Any money session (operator OR personal-lobby real-money) is canonical in
  // integer minor units — render via the session currency. Only the legacy
  // anonymous demo session (no balanceMinor) uses decimal credits.
  if (typeof session?.balanceMinor === 'number') {
    return fromMinor(session.balanceMinor, session.currency);
  }
  return formatCredits(balance);
}
