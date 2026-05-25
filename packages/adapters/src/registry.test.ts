import { describe, it, expect } from 'vitest';
import { getAdapter, registerAdapter } from './registry.js';
import type { WalletAdapter } from '@crash/wallet';

const stub: WalletAdapter = {
  name: 'stub',
  encodeRequest: () => ({ method: 'POST', url: 'http://x', headers: {}, body: '' }),
  decodeResponse: () => ({}),
};

describe('adapter registry (Task 7.1)', () => {
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
