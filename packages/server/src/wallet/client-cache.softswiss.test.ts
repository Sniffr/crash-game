// ---------------------------------------------------------------------------
// Server seam test (Task 7.4-D): WalletClientCache → getAdapter('softswiss') →
// softswissAdapter → SoftSwiss-FORMAT /callback endpoint.
//
// Proves the REAL composition layer routes a `softswiss` operator's outbound
// traffic through the softswiss adapter — end-to-end, hermetic, ephemeral port.
//
// WHY this proves the seam (and a native client would NOT pass):
//   - The cache builds `new WalletClient(op, { adapter: getAdapter(op.adapter) })`.
//     For adapter:'softswiss', getAdapter returns the softswissAdapter that
//     @crash/adapters auto-registers on import (client-cache.ts imports it).
//   - The softswiss adapter POSTs to {walletBaseUrl}/callback with an `action`
//     body and reads an RS_OK/RS_ERROR_* response. The stub here ONLY serves
//     /callback in that dialect.
//   - A NATIVE WalletClient would instead POST /bet (and /authenticate, …) with
//     the spec-§4 X-Signature scheme — the SoftSwiss stub has no /bet route
//     (404) and does not produce the native response signature, so a native
//     client could never return a canonical BetResponse here. Getting a clean
//     BetResponse + observing the debit on the stub therefore proves the
//     softswiss round-trip fired through the cache.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { PgBetLog } from '@crash/wallet';
import type { Operator, OperatorRegistry } from '@crash/wallet';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';

import { WalletClientCache } from './client-cache.js';

// The SoftSwiss-format conformance stub (standalone tool — relative import).
import {
  startServer,
  resetStubState,
  getPlayerBalance,
} from '../../../../tools/wallet-conformance/src/softswiss-stub.js';

// Default 32-byte signing key shared by the stub + operator.
const KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

let server: Server;
let port: number;

beforeAll(async () => {
  resetStubState();
  server = startServer(0);
  await new Promise<void>((res) => server.on('listening', res));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

let testDb: TestDb;

beforeEach(async () => {
  resetStubState();
  testDb = await makeTestDb();
});

afterEach(async () => {
  await testDb.cleanup();
});

/** Build a `softswiss` operator pointed at the in-process stub. */
function softswissOperator(): Operator {
  const now = Math.floor(Date.now() / 1000);
  return {
    operatorId: 'op-ss-seam',
    name: 'seam',
    walletBaseUrl: `http://localhost:${port}`,
    apiKey: 'seam-key',
    signingKey: Buffer.from(KEY_B64, 'base64'),
    adapter: 'softswiss',
    currencies: ['EUR', 'USD', 'BTC'],
    minBetMinor: 10,
    maxBetMinor: 500_000,
    rtpVariant: 97,
    jurisdictions: [],
    status: 'active',
    shareBps: 1500,
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal structural registry exposing only what the cache uses (getById). */
function registryWith(op: Operator): OperatorRegistry {
  return {
    getById: (operatorId: string) => (operatorId === op.operatorId ? op : null),
  } as unknown as OperatorRegistry;
}

describe('WalletClientCache → softswiss adapter seam', () => {
  it('routes a softswiss operator bet through /callback and decodes a canonical BetResponse', async () => {
    const op = softswissOperator();
    const betLog = new PgBetLog(testDb.pool);
    const cache = new WalletClientCache(registryWith(op), betLog);

    const client = cache.get('op-ss-seam');
    expect(client).not.toBeNull();

    const before = getPlayerBalance('pid-1');
    expect(before).toBe(100_000);

    // Drive a bet through the REAL cache-built client. Only succeeds if the
    // request hit /callback (softswiss dialect) and was decoded by the
    // softswiss adapter — a native client would POST /bet and fail here.
    const res = await client!.bet({
      playerId: 'pid-1',
      sessionId: 'sess-seam',
      roundId: 'round-seam',
      betId: 'bet-seam',
      txnId: 'txn-bet-seam',
      amountMinor: 5_000,
      currency: 'EUR',
      gameId: 'galaxy-crash',
      placedAt: 1700000000,
    });

    // Canonical BetResponse shape (the adapter mapped RS_OK → this).
    expect(res.currency).toBe('EUR');
    expect(typeof res.balanceMinor).toBe('number');
    expect(typeof res.operatorTxnId).toBe('string');

    // The stub debited the player — proves the softswiss round-trip ran.
    expect(getPlayerBalance('pid-1')).toBe(95_000);
    expect(res.balanceMinor).toBe(95_000);
  });

  it('the same cache returns the cached client on repeat get()', () => {
    const op = softswissOperator();
    const betLog = new PgBetLog(testDb.pool);
    const cache = new WalletClientCache(registryWith(op), betLog);
    const a = cache.get('op-ss-seam');
    const b = cache.get('op-ss-seam');
    expect(a).toBe(b);
  });
});
