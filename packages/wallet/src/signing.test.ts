import { describe, it, expect } from 'vitest';
import {
  sign,
  verify,
  signResponse,
  verifyResponse,
  sha256Hex,
  NonceCache,
} from './signing.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const KEY = Buffer.from('test-signing-key-32bytes-padding!');
const OTHER_KEY = Buffer.from('other-signing-key-32bytes-paddin!');

const FIXED_INPUT = {
  method: 'POST',
  path: '/bet',
  timestamp: 1716000000,
  nonce: '9f3e1c2a-0000-4000-8000-000000000001',
  body: Buffer.from(JSON.stringify({ amountMinor: 10000 })),
};

// Pre-computed via Node REPL from the exact same algorithm:
//   SHA256(body) → 42c99937908a1b9f78733231145212b65ac6e785eabe47cbcd71e2623f068686
//   signingString → "POST\n/bet\n1716000000\n9f3e1c2a-0000-4000-8000-000000000001\n42c99..."
//   HMAC-SHA256(KEY, signingString) → 19310157717d361640f3c142040fa35be66694e092dbab9d7ae7738eabd19a62
const EXPECTED_SIG = '19310157717d361640f3c142040fa35be66694e092dbab9d7ae7738eabd19a62';

// ---------------------------------------------------------------------------
// Test 1 — happy path: known input produces known digest
// ---------------------------------------------------------------------------

describe('sign()', () => {
  it('produces a known hex digest for a fixed input + key', () => {
    const sig = sign(FIXED_INPUT, KEY);
    expect(sig).toBe(EXPECTED_SIG);
    // Should be lowercase hex, 64 chars
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — wrong key → different signature; verify returns false
// ---------------------------------------------------------------------------

describe('verify()', () => {
  it('returns false when the wrong key is used', () => {
    const sig = sign(FIXED_INPUT, KEY);
    const result = verify({ ...FIXED_INPUT, signature: sig }, OTHER_KEY);
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — body tamper → verify returns false
  // -------------------------------------------------------------------------
  it('returns false when the body has been tampered', () => {
    const sig = sign(FIXED_INPUT, KEY);
    const tamperedBody = Buffer.from(JSON.stringify({ amountMinor: 99999 }));
    const result = verify({ ...FIXED_INPUT, body: tamperedBody, signature: sig }, KEY);
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4 — verify does NOT check timestamp freshness
  // -------------------------------------------------------------------------
  it('returns true for an ancient timestamp (timestamp-window check is NOT in this layer)', () => {
    // timestamp is 0 (Unix epoch) — absurdly stale, but verify should still pass
    // because freshness enforcement belongs in the middleware, not here.
    const staleInput = { ...FIXED_INPUT, timestamp: 0 };
    const sig = sign(staleInput, KEY);
    expect(verify({ ...staleInput, signature: sig }, KEY)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8 — constant-time guard: length mismatch and single-byte diff
  // -------------------------------------------------------------------------
  it('returns false on wrong-length signature without throwing', () => {
    // Provide a hex signature that is too short — timingSafeEqual must NOT be called
    // (buffers of different length would throw). We assert no throw and false return.
    const shortSig = EXPECTED_SIG.slice(0, 60); // 30 hex chars instead of 64
    expect(() => verify({ ...FIXED_INPUT, signature: shortSig }, KEY)).not.toThrow();
    expect(verify({ ...FIXED_INPUT, signature: shortSig }, KEY)).toBe(false);
  });

  it('returns false when signature has correct length but one byte differs', () => {
    // Flip the last hex char (0 → 1 or f → e etc.)
    const lastChar = EXPECTED_SIG[EXPECTED_SIG.length - 1];
    const flipped = lastChar === 'f' ? 'e' : 'f';
    const badSig = EXPECTED_SIG.slice(0, -1) + flipped;
    expect(badSig.length).toBe(EXPECTED_SIG.length); // same byte-length
    expect(verify({ ...FIXED_INPUT, signature: badSig }, KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — NonceCache: fresh/replay/operator isolation
// ---------------------------------------------------------------------------

describe('NonceCache', () => {
  it('fresh nonce returns true; same nonce returns false; different operator returns true', () => {
    const cache = new NonceCache();
    const nonce = 'unique-nonce-abc';

    expect(cache.recordIfFresh('op-1', nonce)).toBe(true);  // fresh
    expect(cache.recordIfFresh('op-1', nonce)).toBe(false); // replay

    // Different operator — same nonce should be independent
    expect(cache.recordIfFresh('op-2', nonce)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 6 — NonceCache prune: TTL eviction allows reuse
  // -------------------------------------------------------------------------
  it('after TTL expiry, prune() removes the entry and recordIfFresh returns true again', () => {
    let fakeNow = 1_000_000;
    const clock = () => fakeNow;
    const ttlMs = 5_000; // 5 seconds for test convenience

    const cache = new NonceCache({ ttlMs, clock });
    const nonce = 'eviction-test-nonce';

    // Record nonce — should be fresh
    expect(cache.recordIfFresh('op-1', nonce)).toBe(true);
    expect(cache.size()).toBe(1);

    // Advance clock past TTL
    fakeNow += ttlMs + 1;

    // Explicit prune
    cache.prune();
    expect(cache.size()).toBe(0);

    // After eviction the nonce is treated as fresh again
    expect(cache.recordIfFresh('op-1', nonce)).toBe(true);
  });

  it('lazy prune on recordIfFresh also evicts expired entries', () => {
    let fakeNow = 2_000_000;
    const clock = () => fakeNow;
    const ttlMs = 3_000;

    const cache = new NonceCache({ ttlMs, clock });

    cache.recordIfFresh('op-1', 'nonce-a');
    cache.recordIfFresh('op-1', 'nonce-b');
    expect(cache.size()).toBe(2);

    // Advance past TTL
    fakeNow += ttlMs + 1;

    // Trigger lazy prune via recordIfFresh for a new nonce
    cache.recordIfFresh('op-1', 'nonce-c');

    // nonce-a and nonce-b should have been evicted; only nonce-c remains
    expect(cache.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — signResponse round-trip
// ---------------------------------------------------------------------------

describe('signResponse() / verifyResponse()', () => {
  const resInput: Parameters<typeof signResponse>[0] = {
    status: 200,
    timestamp: 1716000000,
    body: Buffer.from(JSON.stringify({ ok: true })),
  };

  it('happy path: sign then verify returns true', () => {
    const sig = signResponse(resInput, KEY);
    // Pre-computed expected value:
    expect(sig).toBe('562826306d18a6015ccca4c3eba86d7edd5a3f10ff7cfd714dd232bd2f540caf');
    expect(verifyResponse({ ...resInput, signature: sig }, KEY)).toBe(true);
  });

  it('returns false when response body is tampered', () => {
    const sig = signResponse(resInput, KEY);
    const tampered = { ...resInput, body: Buffer.from(JSON.stringify({ ok: false })), signature: sig };
    expect(verifyResponse(tampered, KEY)).toBe(false);
  });

  it('returns false when response status is tampered', () => {
    const sig = signResponse(resInput, KEY);
    expect(verifyResponse({ ...resInput, status: 201, signature: sig }, KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sha256Hex sanity check
// ---------------------------------------------------------------------------

describe('sha256Hex()', () => {
  it('returns known hash for empty buffer', () => {
    // SHA256('') is a well-known constant
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
