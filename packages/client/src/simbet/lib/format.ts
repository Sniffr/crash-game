// Display formatting in the design's conventions: "KES 300,000.73",
// "03/03/2025 08:36", "07/02 Friday".

const DECIMALS: Record<string, number> = { UGX: 0 };

export function decimalsFor(currency: string): number {
  return DECIMALS[currency] ?? 2;
}

/** "KES 1,000.00" — always with decimals, for balances and bet amounts. */
export function money(minor: number, currency = 'KES'): string {
  const d = decimalsFor(currency);
  const value = minor / 10 ** d;
  return `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** "KES 500" — whole amounts without decimals (chips, entry fees). */
export function moneyShort(minor: number, currency = 'KES'): string {
  const d = decimalsFor(currency);
  const value = minor / 10 ** d;
  return `${currency} ${value.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(value) ? 0 : d })}`;
}

/** Major-unit amount → integer minor units, or null if it isn't a usable amount. */
export function toMinor(major: number, currency = 'KES'): number | null {
  if (!Number.isFinite(major) || major <= 0) return null;
  const minor = Math.round(major * 10 ** decimalsFor(currency));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function fromMinor(minor: number, currency = 'KES'): number {
  return minor / 10 ** decimalsFor(currency);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "03/03/2025 08:36" */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "05:50" */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "07/02 Friday" — the day header on the fixtures board. */
export function dayHeader(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${d.toLocaleDateString('en-GB', { weekday: 'long' })}`;
}

/** Local calendar-day key, for grouping. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "22 Jan. 2026 10:23 (EAT)"-style long date for self-exclusion and similar notices. */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/** "+254 712 345 678" from "+254712345678". */
export function prettyPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const m = /^\+254(\d{3})(\d{3})(\d{3})$/.exec(phone);
  return m ? `+254 ${m[1]} ${m[2]} ${m[3]}` : phone;
}
