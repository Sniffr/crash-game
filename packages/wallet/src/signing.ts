import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared input types
// ---------------------------------------------------------------------------

export interface SignInput {
  method: string;    // 'POST' | 'GET' (uppercase)
  path: string;      // e.g. '/bet' (leading slash, no query string)
  timestamp: number; // unix seconds
  nonce: string;     // uuid v4
  body: Buffer;      // raw body bytes; empty Buffer for GET / no-body
}

export interface VerifyInput extends SignInput {
  signature: string; // hex
}

export interface SignResponseInput {
  status: number;
  timestamp: number;
  body: Buffer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex of a buffer. */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------

/** Build the canonical signing string per spec §4.2. */
export function buildSigningString(input: SignInput): string {
  return `${input.method}\n${input.path}\n${input.timestamp}\n${input.nonce}\n${sha256Hex(input.body)}`;
}

/** HMAC-SHA256 over the canonical string. Returns hex (lowercase). */
export function sign(input: SignInput, key: Buffer): string {
  return createHmac('sha256', key).update(buildSigningString(input)).digest('hex');
}

/** Constant-time verify. Returns true iff signature matches. */
export function verify(input: VerifyInput, key: Buffer): boolean {
  const expected = Buffer.from(sign(input, key));
  const provided = Buffer.from(input.signature);
  // Must be same length before calling timingSafeEqual
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// Response signing (spec §4.3)
// ---------------------------------------------------------------------------

/** Build the canonical RESPONSE signing string per spec §4.3:
 *   STATUS + "\n" + TIMESTAMP + "\n" + SHA256(body-bytes hex)
 */
function buildResponseSigningString(input: SignResponseInput): string {
  return `${input.status}\n${input.timestamp}\n${sha256Hex(input.body)}`;
}

export function signResponse(input: SignResponseInput, key: Buffer): string {
  return createHmac('sha256', key).update(buildResponseSigningString(input)).digest('hex');
}

export function verifyResponse(
  input: SignResponseInput & { signature: string },
  key: Buffer,
): boolean {
  const expected = Buffer.from(signResponse(input, key));
  const provided = Buffer.from(input.signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// NonceCache — replay protection with 10-minute TTL (spec §4.2 #2)
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class NonceCache {
  private readonly ttlMs: number;
  private readonly clock: () => number;
  // key: `${operatorId}|${nonce}`, value: expiry unix ms
  private readonly cache: Map<string, number> = new Map();

  constructor(opts?: { ttlMs?: number; clock?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts?.clock ?? (() => Date.now());
  }

  /**
   * Returns false if the nonce was already seen within ttl, true otherwise
   * (and records it). Prunes expired entries lazily on every call.
   */
  recordIfFresh(operatorId: string, nonce: string): boolean {
    this.prune();
    const key = `${operatorId}|${nonce}`;
    const now = this.clock();
    const expiry = this.cache.get(key);
    if (expiry !== undefined && expiry > now) {
      return false; // replay detected
    }
    this.cache.set(key, now + this.ttlMs);
    return true;
  }

  /** Returns current number of cached entries (for tests). */
  size(): number {
    return this.cache.size;
  }

  /** Evict all entries where expiry <= now. */
  prune(): void {
    const now = this.clock();
    for (const [key, expiry] of this.cache) {
      if (expiry <= now) {
        this.cache.delete(key);
      }
    }
  }
}
