/**
 * Opaque keyset cursor for the admin read API (Task 5.3).
 *
 * Pagination convention: ORDER BY created_at DESC, <pk> DESC.
 * A page's nextCursor encodes the LAST item's (created_at, pk).
 * The subsequent page query adds:
 *   WHERE (created_at < cursor.ts) OR (created_at = cursor.ts AND pk < cursor.id)
 * nextCursor is null when the page returned fewer than `limit` rows.
 *
 * Cursors are base64url-encoded JSON — opaque to clients, stable across
 * page-size changes within the same filter query.
 */

export interface Cursor {
  /** unix seconds — the created_at (or equivalent ordering field) of the last item */
  ts: number;
  /** primary-key string of the last item */
  id: string;
}

/**
 * Encode a cursor to an opaque base64url string.
 */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/**
 * Decode an opaque cursor string. Returns null if the string is malformed
 * (caller should return 400 INVALID_CURSOR).
 */
export function decodeCursor(s: string): Cursor | null {
  try {
    const raw = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['ts'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['id'] === 'string'
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse and clamp a raw limit value.
 * - Non-integer / missing / NaN → returns `def`.
 * - Clamped to [1, max].
 */
export function parseLimit(raw: unknown, def = 50, max = 200): number {
  if (raw === undefined || raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || Number.isNaN(n)) return def;
  return Math.min(Math.max(1, n), max);
}
