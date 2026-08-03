import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAdapter, registerAdapter, clearAdapters } from './registry.js';
import type { WalletAdapter } from '@crash/wallet';

const stub: WalletAdapter = {
  name: 'stub',
  encodeRequest: () => ({ method: 'POST', url: 'http://x', headers: {}, body: '' }),
  decodeResponse: () => ({}),
};

describe('adapter registry (Task 7.1)', () => {
  // Isolate from the module-scoped singleton: this file imports ./registry.js
  // DIRECTLY (not the package root), so @crash/adapters' import-time
  // auto-registration of softswiss never fires here. clearAdapters() guarantees
  // a clean baseline regardless of import order, keeping the
  // "softswiss undefined BEFORE registration" assertion valid.
  beforeEach(() => clearAdapters());
  afterEach(() => clearAdapters());

  it('returns undefined for native (use WalletClient built-in path)', () => {
    expect(getAdapter('native')).toBeUndefined();
  });

  it('returns undefined for softswiss before it is registered (pre-7.2)', () => {
    expect(getAdapter('softswiss')).toBeUndefined();
  });

  it('returns the registered adapter after registerAdapter', () => {
    registerAdapter('softswiss', stub);
    expect(getAdapter('softswiss')).toBe(stub);
  });
});
