/**
 * Kenyan mobile numbers → canonical E.164 (`+2547XXXXXXXX` / `+2541XXXXXXXX`).
 * Accepts the shapes players actually type: 07…, 01…, 7…, 1…, 2547…, +254 7…,
 * with spaces, dashes or brackets. Returns null for anything else.
 */
export function normalizeKePhone(input: string): string | null {
  const digits = String(input ?? '').replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  let local: string;
  if (digits.startsWith('254')) local = digits.slice(3);
  else if (digits.startsWith('0')) local = digits.slice(1);
  else local = digits;
  if (!/^[17]\d{8}$/.test(local)) return null;
  return `+254${local}`;
}

/** `+254712345678` → `+254 712 345 678`. */
export function formatKePhone(e164: string): string {
  const m = /^\+254(\d{3})(\d{3})(\d{3})$/.exec(e164);
  return m ? `+254 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
