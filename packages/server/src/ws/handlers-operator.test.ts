/**
 * Integration test: WS handler operator discrimination (Task 3.1b).
 *
 * Proves that the place_bet and cashout WS handlers correctly discriminate
 * between demo sessions (legacy RocksDB path) and operator-backed sessions
 * (wallet HTTP path).
 *
 * Uses a real operator-stub (startServer(0)), a real BetLog (:memory: SQLite),
 * and a real WalletClientCache. The store (RocksDB) is mocked because the
 * operator-backed bet path never touches RocksDB — and opening RocksDB in a
 * test environment is fragile. Demo session tests use the store mock's return
 * values.
 */

import { vi } from 'vitest';

// Mock RocksDB store — same pattern as bets.test.ts
vi.mock('../store.js', () => ({
  adjustBalance: vi.fn().mockResolvedValue(900),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  recordBet: vi.fn().mockResolvedValue({ bets: 1, wins: 0, losses: 0, totalWagered: 100, totalWon: 0, netProfit: -100, biggestCashout: 0, biggestWin: 0, currentStreak: -1, bestStreak: 0 }),
  recordWin: vi.fn().mockResolvedValue({ bets: 1, wins: 1, losses: 0, totalWagered: 100, totalWon: 200, netProfit: 100, biggestCashout: 2.0, biggestWin: 100, currentStreak: 1, bestStreak: 1 }),
  recordLoss: vi.fn().mockResolvedValue(undefined),
  setBalance: vi.fn().mockResolvedValue(undefined),
  getStats: vi.fn().mockResolvedValue({ bets: 0, wins: 0, losses: 0, totalWagered: 0, totalWon: 0, netProfit: 0, biggestCashout: 0, biggestWin: 0, currentStreak: 0, bestStreak: 0 }),
  getSession: vi.fn(),
  checkRateLimit: vi.fn().mockResolvedValue(true),
  StoreOfflineError: class StoreOfflineError extends Error { constructor() { super('store offline'); } },
  DEFAULT_DEMO_BALANCE: 1000,
}));

// Mock the WS hub — prevents broadcast side effects from interfering
vi.mock('../ws/hub.js', () => ({
  broadcast: vi.fn(),
  sendToSession: vi.fn(),
  safeSend: vi.fn(),
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PgBetLog, PgOperatorRegistry } from '@crash/wallet';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import type { Server } from 'node:http';
import type { WebSocket } from 'ws';

import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import { handleMessage } from './handlers.js';
import { setOperatorWiringDeps } from '../game/operator-deps.js';
import { WalletClientCache } from '../wallet/client-cache.js';
import { _internal__setCurrentRoundForTesting } from '../game/round.js';

import { getSession, checkRateLimit } from '../store.js';
import { safeSend, broadcast, sendToSession } from './hub.js';

const mockGetSession = vi.mocked(getSession);
const mockSafeSend = vi.mocked(safeSend);
const mockBroadcast = vi.mocked(broadcast);
const mockSendToSession = vi.mocked(sendToSession);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';
const SIGNING_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

const OPERATOR_ID = 'op-test';
const PLAYER_ID = 'pid-1';
const CURRENCY = 'EUR';
const INITIAL_BALANCE = 100_000;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let stubServer: Server;
let port: number;
let testDb: TestDb;
let betLog: PgBetLog;
let walletClientCache: WalletClientCache;

// A minimal fake WebSocket object (we only need safeSend which is mocked)
const fakeWs = {} as WebSocket;

// A no-op attachSession
const noop = (_sid: string) => {};

beforeAll(async () => {
  // Start the operator stub on an ephemeral port
  stubServer = startServer(0) as unknown as Server;
  await new Promise<void>((resolve) => stubServer.once('listening', resolve));

  const addr = stubServer.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!port) throw new Error('Could not determine stub server port');

  // Build real operator registry + betLog (isolated Postgres schema so registry
  // and betLog share the same bootstrapped schema)
  testDb = await makeTestDb();
  betLog = new PgBetLog(testDb.pool);
  const registry = new PgOperatorRegistry(testDb.pool);

  await registry.create({
    operatorId: OPERATOR_ID,
    name: 'Test Operator',
    walletBaseUrl: `http://localhost:${port}`,
    currencies: ['EUR', 'USD'],
    status: 'active',
  });

  // Override the auto-generated signing key with the stub's fixed key, then
  // refresh the registry cache so getByApiKey/getById see the fixed key.
  await testDb.pool.query(
    `UPDATE operators SET signing_key_b64 = $1 WHERE operator_id = $2`,
    [STUB_DEFAULT_KEY_B64, OPERATOR_ID],
  );
  await registry.refresh();

  walletClientCache = new WalletClientCache(registry, betLog);

  // Wire the DI seam
  setOperatorWiringDeps({ walletClientCache, betLog });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    stubServer.close((err) => (err ? reject(err) : resolve()));
  });
  await testDb.cleanup();
});

beforeEach(() => {
  resetStubState();
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
});

afterEach(() => {
  _internal__setCurrentRoundForTesting(null);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a synthetic BETTING round. */
function makeBettingRound(roundNumber = 42) {
  return {
    roundNumber,
    phase: 'BETTING' as const,
    crashPoint: 3.0,
    currentMultiplier: 1.0,
    startTime: Date.now(),
    bets: [] as import('@crash/shared/types').Bet[],
    serverSeedHash: 'abc',
  };
}

/** Build a synthetic FLYING round. */
function makeFlyingRound(roundNumber = 42, multiplier = 1.5) {
  return {
    roundNumber,
    phase: 'FLYING' as const,
    crashPoint: 3.0,
    currentMultiplier: multiplier,
    startTime: Date.now(),
    bets: [] as import('@crash/shared/types').Bet[],
    serverSeedHash: 'abc',
  };
}

// ---------------------------------------------------------------------------
// Test 1: demo session → legacy path (no wallet call)
// ---------------------------------------------------------------------------

describe('WS handler operator discrimination', () => {
  it('demo session place_bet → legacy path; no wallet call', async () => {
    const sessionId = 'demo-session-abc';
    const round = makeBettingRound(1);
    _internal__setCurrentRoundForTesting(round);

    // Mock getSession to return a demo session (no operatorId/playerId/currency/balanceMinor)
    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Lucky Falcon',
      balance: 1000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });

    // Send place_bet from a demo session with legacy `amount`
    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amount: 100 } },
      noop,
    );

    // Verify a legacy Bet was pushed to the round (no betId/operatorId)
    expect(round.bets).toHaveLength(1);
    const bet = round.bets[0];
    expect(bet.playerId).toBe(sessionId);
    expect(bet.amount).toBe(100);
    expect(bet.operatorId).toBeUndefined();
    expect(bet.betId).toBeUndefined();

    // bet_placed must be sent
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({ type: 'bet_placed' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Dual-bet (demo path): two slots coexist, same slot rejected, independent cashout
  // ---------------------------------------------------------------------------

  it('demo dual-bet: slots 0 and 1 coexist; duplicate slot rejected; independent cashout', async () => {
    const sessionId = 'demo-dual-1';
    const round = makeBettingRound(7);
    _internal__setCurrentRoundForTesting(round);
    const demoSession = {
      sessionId, displayName: 'Dual Tester', balance: 1000,
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    };
    // One-shot per place_bet call (3) — never a persistent default, so this test
    // can't leak a demo session into the operator tests that follow.
    mockGetSession
      .mockResolvedValueOnce(demoSession)
      .mockResolvedValueOnce(demoSession)
      .mockResolvedValueOnce(demoSession);

    // Two independent bets in the same round from the same session.
    await handleMessage(fakeWs, { type: 'place_bet', data: { sessionId, amount: 10, slot: 0 } }, noop);
    await handleMessage(fakeWs, { type: 'place_bet', data: { sessionId, amount: 20, slot: 1 } }, noop);

    expect(round.bets).toHaveLength(2);
    expect(round.bets.find((b) => b.slot === 0)!.amount).toBe(10);
    expect(round.bets.find((b) => b.slot === 1)!.amount).toBe(20);

    // A second bet in an already-occupied slot is rejected.
    mockSafeSend.mockClear();
    await handleMessage(fakeWs, { type: 'place_bet', data: { sessionId, amount: 10, slot: 0 } }, noop);
    expect(round.bets).toHaveLength(2);
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({ type: 'error', data: expect.objectContaining({ message: expect.stringMatching(/already have a bet in this slot/i) }) }),
    );

    // Cash out slot 0 only — slot 1 stays live.
    const flying = { ...round, phase: 'FLYING' as const, currentMultiplier: 2.0 };
    _internal__setCurrentRoundForTesting(flying);
    await handleMessage(fakeWs, { type: 'cashout', data: { sessionId, slot: 0 } }, noop);
    expect(flying.bets.find((b) => b.slot === 0)!.cashedOut).toBe(true);
    expect(flying.bets.find((b) => b.slot === 1)!.cashedOut).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 2: operator session place_bet → wallet debit + betLog ARMED + Bet pushed
  // ---------------------------------------------------------------------------

  it('operator session place_bet → wallet debit, betLog ARMED, Bet with operatorId pushed', async () => {
    const sessionId = 'op-session-1';
    const round = makeBettingRound(2);
    _internal__setCurrentRoundForTesting(round);

    // Operator-backed session
    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'lucky_falcon_42',
      balance: INITIAL_BALANCE,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      operatorId: OPERATOR_ID,
      playerId: PLAYER_ID,
      currency: CURRENCY,
      balanceMinor: INITIAL_BALANCE,
    });

    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 10_000 } },
      noop,
    );

    // Bet must be in the round with operator fields
    expect(round.bets).toHaveLength(1);
    const bet = round.bets[0];
    expect(bet.playerId).toBe(sessionId);
    expect(bet.operatorId).toBe(OPERATOR_ID);
    expect(bet.betId).toBe(`bet-${sessionId}-2-s0`);
    expect(bet.betTxnId).toBeTruthy();
    expect(bet.amountMinor).toBe(10_000);
    expect(bet.currency).toBe(CURRENCY);
    expect(bet.isBot).toBe(false);

    // betLog row must be ARMED
    const row = await betLog.getById(bet.betId!);
    expect(row?.state).toBe('ARMED');
    expect(row?.playerId).toBe(PLAYER_ID);

    // Stub balance should reflect debit: 100000 - 10000 = 90000
    const walletClient = walletClientCache.get(OPERATOR_ID)!;
    const balResp = await walletClient.balance({ playerId: PLAYER_ID, sessionId });
    expect(balResp.balance).toBe(90_000);

    // bet_placed frame sent to the WS — must include post-debit balanceMinor and currency
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({
        type: 'bet_placed',
        data: expect.objectContaining({
          isOperator: true,
          // Started at 100000, bet 10000 → post-debit balance 90000
          balanceMinor: 90_000,
          currency: CURRENCY,
        }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3: operator cashout → wallet credit, betLog SETTLED, bet.cashedOut=true
  // ---------------------------------------------------------------------------

  it('operator cashout → wallet credit, betLog SETTLED, bet.cashedOut=true', async () => {
    const sessionId = 'op-session-2';
    const round = makeBettingRound(3);
    _internal__setCurrentRoundForTesting(round);

    // Place the bet first
    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'lucky_falcon_42',
      balance: INITIAL_BALANCE,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      operatorId: OPERATOR_ID,
      playerId: 'pid-2', // use pid-2 to keep balances separate
      currency: 'USD',
      balanceMinor: INITIAL_BALANCE,
    });

    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 5_000 } },
      noop,
    );
    expect(round.bets).toHaveLength(1);
    const bet = round.bets[0];
    expect(bet.betId).toBeTruthy();
    expect((await betLog.getById(bet.betId!))?.state).toBe('ARMED');

    // Now switch the round to FLYING and cashout
    const flyingRound = { ...round, phase: 'FLYING' as const, currentMultiplier: 2.0 };
    _internal__setCurrentRoundForTesting(flyingRound);
    // Keep the same bet in the flying round
    flyingRound.bets = round.bets;

    // Send cashout
    await handleMessage(
      fakeWs,
      { type: 'cashout', data: { sessionId } },
      noop,
    );

    // Bet must be cashed out
    expect(bet.cashedOut).toBe(true);
    expect(bet.cashoutMultiplier).toBe(2.0);

    // betLog row must be SETTLED
    const row = await betLog.getById(bet.betId!);
    expect(row?.state).toBe('SETTLED');

    // Stub balance: 100000 - 5000 + 10000 = 105000
    const walletClient = walletClientCache.get(OPERATOR_ID)!;
    const balResp = await walletClient.balance({ playerId: 'pid-2', sessionId });
    expect(balResp.balance).toBe(105_000);

    // cashout_success frame sent via sendToSession (not safeSend)
    // Must include post-credit balanceMinor and currency so the iframe header updates live
    expect(mockSendToSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        type: 'cashout_success',
        data: expect.objectContaining({
          multiplier: expect.any(Number),
          winAmountMinor: expect.any(Number),
          // Started 100000, bet 5000 → 95000, win 10000 (5000*2.0) → 105000
          balanceMinor: 105_000,
          currency: 'USD',
        }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: insufficient funds → error frame, no Bet pushed
  // ---------------------------------------------------------------------------

  it('operator place_bet with insufficient funds → INSUFFICIENT_FUNDS error frame, no Bet pushed', async () => {
    const sessionId = 'op-session-3';
    const round = makeBettingRound(4);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'lucky_falcon_42',
      balance: INITIAL_BALANCE,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      operatorId: OPERATOR_ID,
      playerId: PLAYER_ID,
      currency: CURRENCY,
      balanceMinor: INITIAL_BALANCE,
    });

    // amountMinor exceeds pid-1's balance of 100000
    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 100_001 } },
      noop,
    );

    // No bet pushed
    expect(round.bets).toHaveLength(0);

    // Error frame with INSUFFICIENT_FUNDS code
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
      }),
    );

    // betLog row must be VOIDED (placeOperatorBet transitions PENDING→VOIDED on confirmed rejection)
    const betId = `bet-${sessionId}-4-s0`;
    const betRow = await betLog.getById(betId);
    expect(betRow?.state).toBe('VOIDED');
    expect(betRow?.errorCode).toBeTruthy();

    // Stub balance unchanged: 100000
    const walletClient = walletClientCache.get(OPERATOR_ID)!;
    const balResp = await walletClient.balance({ playerId: PLAYER_ID, sessionId });
    expect(balResp.balance).toBe(100_000);
  });

  // ---------------------------------------------------------------------------
  // Test 5: crash → operator bet ARMED → LOST, no win HTTP call
  // ---------------------------------------------------------------------------

  it('crash → expireOperatorBetsOnCrash transitions ARMED bets to LOST', async () => {
    const sessionId = 'op-session-4';
    const round = makeBettingRound(5);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'lucky_falcon_42',
      balance: INITIAL_BALANCE,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      operatorId: OPERATOR_ID,
      playerId: PLAYER_ID,
      currency: CURRENCY,
      balanceMinor: INITIAL_BALANCE,
    });

    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 10_000 } },
      noop,
    );
    expect(round.bets).toHaveLength(1);
    const bet = round.bets[0];
    expect((await betLog.getById(bet.betId!))?.state).toBe('ARMED');

    // Call expireOperatorBetsOnCrash directly for the round
    const { expireOperatorBetsOnCrash } = await import('../game/bets.js');
    const roundId = `rnd-5`;
    const count = await expireOperatorBetsOnCrash({ betLog }, roundId);

    expect(count).toBe(1);
    expect((await betLog.getById(bet.betId!))?.state).toBe('LOST');

    // Balance should only reflect the bet debit (no win credit)
    const walletClient = walletClientCache.get(OPERATOR_ID)!;
    const balResp = await walletClient.balance({ playerId: PLAYER_ID, sessionId });
    expect(balResp.balance).toBe(90_000);
  });

  // ---------------------------------------------------------------------------
  // Test 6: cashout_pending intentionally omits balanceMinor
  // ---------------------------------------------------------------------------

  it('cashout_pending frame (operator paused at cashout) must NOT include balanceMinor', async () => {
    const sessionId = 'op-session-5';
    const round = makeBettingRound(6);
    _internal__setCurrentRoundForTesting(round);

    // Place the bet with the real (active) wallet client — use pid-1 (EUR), a pre-seeded stub player
    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'lucky_falcon_42',
      balance: INITIAL_BALANCE,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      operatorId: OPERATOR_ID,
      playerId: PLAYER_ID,
      currency: CURRENCY,
      balanceMinor: INITIAL_BALANCE,
    });

    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 5_000 } },
      noop,
    );
    expect(round.bets).toHaveLength(1);
    const bet = round.bets[0];
    expect((await betLog.getById(bet.betId!))?.state).toBe('ARMED');

    // Simulate operator paused: rewire deps so walletClientCache returns null for the operator
    const pausedCache = { get: (_id: string) => null } as unknown as WalletClientCache;
    setOperatorWiringDeps({ walletClientCache: pausedCache, betLog });

    // Switch to FLYING and cashout
    const flyingRound = { ...round, phase: 'FLYING' as const, currentMultiplier: 1.5 };
    flyingRound.bets = round.bets;
    _internal__setCurrentRoundForTesting(flyingRound);

    await handleMessage(
      fakeWs,
      { type: 'cashout', data: { sessionId } },
      noop,
    );

    // Restore the real deps for subsequent tests
    setOperatorWiringDeps({ walletClientCache, betLog });

    // cashout_pending frame must be sent
    expect(mockSendToSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        type: 'cashout_pending',
        data: expect.objectContaining({ code: 'WIN_PENDING' }),
      }),
    );

    // Critically: balanceMinor must NOT be present — the win never credited
    const pendingCall = mockSendToSession.mock.calls.find(
      ([sid, msg]) => sid === sessionId && (msg as { type: string }).type === 'cashout_pending',
    );
    expect(pendingCall).toBeDefined();
    const pendingFrame = pendingCall![1] as { type: string; data: Record<string, unknown> };
    expect(pendingFrame.data.balanceMinor).toBeUndefined();
  });
});
