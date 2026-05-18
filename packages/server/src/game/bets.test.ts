/**
 * Integration test for the operator-backed bet engine (Task 1.6).
 *
 * TRUE end-to-end: real WalletClient → real HTTP → real operator-stub →
 * real BetLog (:memory: sqlite). NOT mocked.
 *
 * The operator stub is started on an ephemeral port (startServer(0)) and torn
 * down in afterAll. Player balances are reset between tests via resetStubState().
 */

// Mock the store module to prevent RocksDB from being opened when bets.ts is
// imported. The legacy cashOutBet code (which we do NOT change) imports store,
// but operator-backed functions (the new code under test) never use it.
import { vi } from 'vitest';
vi.mock('../store.js', () => ({
  adjustBalance: vi.fn(),
  appendHistory: vi.fn(),
  recordWin: vi.fn(),
  StoreOfflineError: class StoreOfflineError extends Error {},
  getStats: vi.fn(),
}));

// Also mock the WS hub — same reason (bets.ts imports broadcast/sendToSession).
vi.mock('../ws/hub.js', () => ({
  broadcast: vi.fn(),
  sendToSession: vi.fn(),
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WalletClient, BetLog, WalletError, WalletNetworkError } from '@crash/wallet';
import type { Operator } from '@crash/wallet';
import type { BetRow } from '@crash/wallet';
import type { Server } from 'node:http';

// Import the operator stub — startServer returns an http.Server directly.
// The signing key is read at module scope from SIGNING_KEY_B64, which defaults
// to the constant below when STUB_SIGNING_KEY env is not set.
import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import {
  placeOperatorBet,
  cashOutOperatorBet,
  expireOperatorBetsOnCrash,
  type OperatorBetDeps,
} from './bets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default signing key from the stub (read when the module is imported).
// Must match the DEFAULT_KEY_B64 constant in tools/operator-stub/src/index.ts.
const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';
const SIGNING_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let server: Server;
let port: number;
let walletClient: WalletClient;

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Start the operator stub on an ephemeral port.
  // startServer(port) returns an http.Server directly.
  server = startServer(0) as unknown as Server;

  // Wait for the server to be listening.
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!port) throw new Error('Could not determine stub server port');

  // Construct the Operator object matching the Operator type.
  const operator: Operator = {
    operatorId: 'op-test',
    name: 'Test Operator',
    walletBaseUrl: `http://localhost:${port}`,
    apiKey: 'op-test',
    signingKey: SIGNING_KEY,
    adapter: 'native',
    currencies: ['EUR'],
    minBetMinor: 1,
    maxBetMinor: 10_000_000,
    rtpVariant: 97,
    jurisdictions: [],
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };

  // The WalletClient uses a fast no-op sleep for tests so retries are
  // near-instantaneous.
  walletClient = new WalletClient(operator, {
    sleep: (_ms: number) => Promise.resolve(),
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

// Fresh BetLog per test (each gets its own :memory: database).
let betLog: BetLog;
let deps: OperatorBetDeps;

// Track win failures for test 3.
const winFailedRows: BetRow[] = [];

beforeEach(() => {
  resetStubState();
  winFailedRows.length = 0;
  betLog = new BetLog(new Database(':memory:'));
  deps = {
    walletClient,
    betLog,
    onWinFailed: (row) => winFailedRows.push(row),
  };
});

afterEach(() => {
  // Ensure STUB_FAIL_NEXT_WIN is cleared even if a test failed mid-way.
  delete process.env['STUB_FAIL_NEXT_WIN'];
  resetStubState();
});

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

// ---------------------------------------------------------------------------
// Test 1: happy bet → win
// ---------------------------------------------------------------------------

it('happy path: placeOperatorBet → ARMED, cashOutOperatorBet → SETTLED, balance +10000', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const winTxnId = uid('wtxn');
  const roundId = uid('round');
  const sessionId = 'sess-pid-1';
  const operatorId = 'op-test';
  const playerId = 'pid-1';
  const amountMinor = 10_000;
  const winAmountMinor = 20_000;
  const multiplier = 2.0;

  // Step 1: place bet
  const armedRow = await placeOperatorBet(deps, {
    operatorId,
    playerId,
    sessionId,
    roundId,
    currency: 'EUR',
    amountMinor,
    betId,
    betTxnId,
    gameId: 'galaxy-crash',
  });

  expect(armedRow.state).toBe('ARMED');
  expect(armedRow.betId).toBe(betId);
  expect(armedRow.betOpTxnId).toBeTruthy();

  // Step 2: cash out
  const settledRow = await cashOutOperatorBet(deps, {
    betId,
    winTxnId,
    multiplier,
    winAmountMinor,
    settledAt: Math.floor(Date.now() / 1000),
  });

  expect(settledRow.state).toBe('SETTLED');
  expect(settledRow.winOpTxnId).toBeTruthy();
  expect(settledRow.winAmountMinor).toBe(winAmountMinor);
  expect(settledRow.multiplier).toBe(multiplier);

  // Step 3: assert bet log is SETTLED
  const storedRow = betLog.getById(betId);
  expect(storedRow?.state).toBe('SETTLED');

  // Step 4: verify stub balance — started at 100000, -10000 bet, +20000 win = 110000
  const balResp = await walletClient.balance({ playerId, sessionId });
  expect(balResp.balance).toBe(110_000);
  expect(balResp.currency).toBe('EUR');
});

// ---------------------------------------------------------------------------
// Test 2: insufficient funds
// ---------------------------------------------------------------------------

it('insufficient funds: placeOperatorBet rejects with WalletError, row VOIDED, balance unchanged', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const roundId = uid('round');
  const sessionId = 'sess-pid-1';

  // pid-1 starts with EUR 100000; attempt to bet 100001 — exceeds balance
  const amountMinor = 100_001;

  let thrownError: WalletError | undefined;
  try {
    await placeOperatorBet(deps, {
      operatorId: 'op-test',
      playerId: 'pid-1',
      sessionId,
      roundId,
      currency: 'EUR',
      amountMinor,
      betId,
      betTxnId,
      gameId: 'galaxy-crash',
    });
    expect.fail('Should have thrown WalletError');
  } catch (err) {
    expect(err).toBeInstanceOf(WalletError);
    thrownError = err as WalletError;
  }

  expect(thrownError!.code).toBe('INSUFFICIENT_FUNDS');
  expect(thrownError!.retryable).toBe(false);

  // Bet row must be VOIDED with betTxnId recovery key retained
  const row = betLog.getById(betId);
  expect(row?.state).toBe('VOIDED');
  expect(row?.errorCode).toBe('INSUFFICIENT_FUNDS');
  expect(row?.betTxnId).toBe(betTxnId);

  // Balance must be unchanged — still 100000
  const balResp = await walletClient.balance({ playerId: 'pid-1', sessionId });
  expect(balResp.balance).toBe(100_000);
});

// ---------------------------------------------------------------------------
// Test 3: win retry then success (STUB_FAIL_NEXT_WIN)
// ---------------------------------------------------------------------------

it('win retry: single /win 500 is retried by WalletClient and ultimately SETTLES', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const winTxnId = uid('wtxn');
  const roundId = uid('round');
  const sessionId = 'sess-pid-2';

  // Place a bet for pid-2 (USD 100000)
  const armedRow = await placeOperatorBet(deps, {
    operatorId: 'op-test',
    playerId: 'pid-2',
    sessionId,
    roundId,
    currency: 'USD',
    amountMinor: 5_000,
    betId,
    betTxnId,
    gameId: 'galaxy-crash',
  });
  expect(armedRow.state).toBe('ARMED');

  // Arm the one-shot win failure BEFORE calling cashOut.
  // The stub checks this env var lazily inside shouldFailNextWin().
  process.env['STUB_FAIL_NEXT_WIN'] = '1';

  // The WalletClient (win policy: 6 attempts, backoff overridden to 0 via
  // the sleep no-op injected in beforeAll) will retry past the one 500.
  const settledRow = await cashOutOperatorBet(deps, {
    betId,
    winTxnId,
    multiplier: 3.0,
    winAmountMinor: 15_000,
    settledAt: Math.floor(Date.now() / 1000),
  });

  expect(settledRow.state).toBe('SETTLED');
  expect(settledRow.winOpTxnId).toBeTruthy();

  // No win-failure callback should have been called
  expect(winFailedRows).toHaveLength(0);

  // Balance: 100000 - 5000 (bet) + 15000 (win) = 110000
  const balResp = await walletClient.balance({ playerId: 'pid-2', sessionId });
  expect(balResp.balance).toBe(110_000);
});

// ---------------------------------------------------------------------------
// Test 4: crash → LOST, no win call
// ---------------------------------------------------------------------------

it('crash: expireOperatorBetsOnCrash marks ARMED bets as LOST, returns count, idempotent on second call', async () => {
  const roundId = uid('round');
  const sessionId = 'sess-pid-1';
  const amountMinor = 10_000;

  // Place a bet
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  await placeOperatorBet(deps, {
    operatorId: 'op-test',
    playerId: 'pid-1',
    sessionId,
    roundId,
    currency: 'EUR',
    amountMinor,
    betId,
    betTxnId,
    gameId: 'galaxy-crash',
  });

  // Confirm ARMED
  expect(betLog.getById(betId)?.state).toBe('ARMED');

  // Crash the round — should transition ARMED → LOST
  const count = await expireOperatorBetsOnCrash(deps, roundId);
  expect(count).toBe(1);
  expect(betLog.getById(betId)?.state).toBe('LOST');

  // Second call: LOST is terminal, should be skipped silently → returns 0
  const count2 = await expireOperatorBetsOnCrash(deps, roundId);
  expect(count2).toBe(0);

  // Balance should only reflect the bet debit — no win credit
  // pid-1 started at 100000, bet 10000 → 90000
  const balResp = await walletClient.balance({ playerId: 'pid-1', sessionId });
  expect(balResp.balance).toBe(90_000);
});

// ---------------------------------------------------------------------------
// Test 5: ambiguous /bet failure → ROLLBACK_PENDING
// ---------------------------------------------------------------------------

it('ambiguous /bet failure: WalletNetworkError → ROLLBACK_PENDING with betTxnId and errorCode retained', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const roundId = uid('round');

  // Construct a WalletClient whose fetchImpl always throws (simulates econnrefused).
  // The client exhausts its retries (4 attempts with no-op sleep) and surfaces a
  // WalletNetworkError. No stub call ever happens.
  const alwaysThrowFetch: typeof fetch = async () => {
    throw new Error('econnrefused');
  };

  // Build a standalone operator config matching the test suite's operator,
  // but pointing at a host that will never be reached (fetchImpl overrides it).
  const failingOperator = {
    operatorId: 'op-test',
    name: 'Test Operator',
    walletBaseUrl: 'http://localhost:0',
    apiKey: 'op-test',
    signingKey: SIGNING_KEY,
    adapter: 'native' as const,
    currencies: ['EUR'],
    minBetMinor: 1,
    maxBetMinor: 10_000_000,
    rtpVariant: 97,
    jurisdictions: [],
    status: 'active' as const,
    createdAt: 0,
    updatedAt: 0,
  };

  const failingClient = new WalletClient(failingOperator, {
    fetchImpl: alwaysThrowFetch,
    sleep: async () => {},  // instant backoff so test doesn't wait
  });

  // Fresh betLog (shared per-test betLog is used here; row is in :memory:)
  const failingDeps: OperatorBetDeps = {
    walletClient: failingClient,
    betLog,
  };

  let thrown: unknown;
  try {
    await placeOperatorBet(failingDeps, {
      operatorId: 'op-test',
      playerId: 'pid-1',
      sessionId: 'sess-pid-1',
      roundId,
      currency: 'EUR',
      amountMinor: 5_000,
      betId,
      betTxnId,
      gameId: 'galaxy-crash',
    });
    expect.fail('Should have thrown a WalletError');
  } catch (err) {
    thrown = err;
  }

  // Must throw a WalletError (specifically WalletNetworkError — subclass of WalletError)
  expect(thrown).toBeInstanceOf(WalletError);
  expect(thrown).toBeInstanceOf(WalletNetworkError);

  // Row must be ROLLBACK_PENDING (ambiguous — operator may have debited)
  const row = betLog.getById(betId);
  expect(row?.state).toBe('ROLLBACK_PENDING');
  expect(row?.betTxnId).toBe(betTxnId);
  expect(row?.errorCode).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Test 6: winTxnId persisted at SETTLING (before /win completes)
// ---------------------------------------------------------------------------

it('SETTLING: winTxnId is persisted to betLog BEFORE the /win HTTP call completes', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const winTxnId = uid('wtxn');
  const roundId = uid('round');
  const sessionId = 'sess-pid-1';

  // Place a happy bet against the real stub so the row reaches ARMED.
  await placeOperatorBet(deps, {
    operatorId: 'op-test',
    playerId: 'pid-1',
    sessionId,
    roundId,
    currency: 'EUR',
    amountMinor: 5_000,
    betId,
    betTxnId,
    gameId: 'galaxy-crash',
  });
  expect(betLog.getById(betId)?.state).toBe('ARMED');

  // Build an intercepting WalletClient for the /win call.
  // It reads the betLog row BEFORE forwarding to the real stub, capturing the
  // state at the exact moment the /win request is about to be sent. This lets
  // us assert that winTxnId was already persisted (Fix 2) before the HTTP round-trip.
  let preWinSnapshot: { state: string; winTxnId: string | null } | null = null;

  const interceptingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/win')) {
      const row = betLog.getById(betId);
      preWinSnapshot = { state: row!.state, winTxnId: row!.winTxnId };
    }
    return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
  };

  const winClient = new WalletClient(
    {
      operatorId: 'op-test',
      name: 'Test Operator',
      walletBaseUrl: `http://localhost:${port}`,
      apiKey: 'op-test',
      signingKey: SIGNING_KEY,
      adapter: 'native' as const,
      currencies: ['EUR'],
      minBetMinor: 1,
      maxBetMinor: 10_000_000,
      rtpVariant: 97,
      jurisdictions: [],
      status: 'active' as const,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      fetchImpl: interceptingFetch,
      sleep: async () => {},
    },
  );

  const winDeps: OperatorBetDeps = {
    walletClient: winClient,
    betLog,
  };

  // Cash out using the intercepting client
  const settledRow = await cashOutOperatorBet(winDeps, {
    betId,
    winTxnId,
    multiplier: 2.0,
    winAmountMinor: 10_000,
    settledAt: Math.floor(Date.now() / 1000),
  });

  // The pre-/win snapshot must show SETTLING with winTxnId already written
  expect(preWinSnapshot).not.toBeNull();
  expect(preWinSnapshot!.state).toBe('SETTLING');
  expect(preWinSnapshot!.winTxnId).toBe(winTxnId);

  // Post-condition: final row is SETTLED with the same winTxnId
  expect(settledRow.state).toBe('SETTLED');
  expect(settledRow.winTxnId).toBe(winTxnId);
  expect(settledRow.winOpTxnId).toBeTruthy();
});
