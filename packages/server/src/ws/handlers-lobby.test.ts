/**
 * Unit test: MAX_STAKE enforced in KES via FX for the lobby (real-money) bet
 * path (Task 9).
 *
 * handlePlaceLobbyBet must, when an `fx` dependency is wired in, convert the
 * stake to KES minor units and reject bets whose KES-equivalent exceeds
 * MAX_STAKE (shared config, major units). When `fx` is absent the check is
 * skipped entirely (back-compat with existing operator/lobby tests that
 * don't wire fx).
 */

import { vi } from 'vitest';

// Mock RocksDB store — same pattern as handlers-operator.test.ts. The lobby
// path never touches these, but handleMessage's place_bet case calls
// checkRateLimit + getSession before dispatching.
vi.mock('../store.js', () => ({
  adjustBalance: vi.fn().mockResolvedValue(900),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  recordBet: vi.fn().mockResolvedValue({ bets: 1, wins: 0, losses: 0, totalWagered: 100, totalWon: 0, netProfit: -100, biggestCashout: 0, biggestWin: 0, currentStreak: -1, bestStreak: 0 }),
  recordWin: vi.fn().mockResolvedValue({ bets: 1, wins: 1, losses: 0, totalWagered: 100, totalWon: 200, netProfit: 100, biggestCashout: 2.0, biggestWin: 100, currentStreak: 1, bestStreak: 1 }),
  recordLoss: vi.fn().mockResolvedValue(undefined),
  recordStatsSafely: vi.fn(async (fn: () => Promise<unknown>) => { try { return await fn(); } catch { return undefined; } }),
  setBalance: vi.fn().mockResolvedValue(undefined),
  getStats: vi.fn().mockResolvedValue({ bets: 0, wins: 0, losses: 0, totalWagered: 0, totalWon: 0, netProfit: 0, biggestCashout: 0, biggestWin: 0, currentStreak: 0, bestStreak: 0 }),
  getSession: vi.fn(),
  checkRateLimit: vi.fn().mockResolvedValue(true),
  StoreOfflineError: class StoreOfflineError extends Error { constructor() { super('store offline'); } },
  DEFAULT_DEMO_BALANCE: 1000,
}));

// Mock the WS hub — prevents broadcast side effects from interfering.
vi.mock('../ws/hub.js', () => ({
  broadcast: vi.fn(),
  sendToSession: vi.fn(),
  safeSend: vi.fn(),
}));

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';

import { handleMessage } from './handlers.js';
import { setLobbyWiringDeps } from '../game/lobby-deps.js';
import { _internal__setCurrentRoundForTesting } from '../game/round.js';
import { getSession, checkRateLimit, recordBet } from '../store.js';
import { safeSend } from './hub.js';

const mockGetSession = vi.mocked(getSession);
const mockRecordBet = vi.mocked(recordBet);
const mockSafeSend = vi.mocked(safeSend);

const noop = (_sid: string) => {};
const fakeWs = {} as import('ws').WebSocket;

/** Build a synthetic BETTING round. */
function makeBettingRound(roundNumber: number) {
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

/** Stub FX: NGN halves to KES (300000 NGN-minor -> 150000 KES-minor = 1500 KES); other currencies pass through 1:1. */
const stubFx = {
  toKesMinor: vi.fn(async (amountMinor: number, currency: string) =>
    currency === 'NGN' ? amountMinor * 0.5 : amountMinor,
  ),
};

function makeWalletMock() {
  return {
    bet: vi.fn().mockResolvedValue(99_000),
  } as unknown as WalletLedger;
}

describe('handlePlaceLobbyBet — MAX_STAKE enforced in KES via FX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue(true);
    stubFx.toKesMinor.mockClear();
  });

  afterEach(() => {
    _internal__setCurrentRoundForTesting(null);
    setLobbyWiringDeps(null);
  });

  it('rejects an NGN stake whose KES-equivalent exceeds MAX_STAKE (no bet placed, no wallet call)', async () => {
    const wallet = makeWalletMock();
    setLobbyWiringDeps({ wallet, fx: stubFx });

    const sessionId = 'lobby-session-1';
    const round = makeBettingRound(10);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Lucky Falcon',
      balance: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      lobbyPlayerId: 'lp-1',
      currency: 'NGN',
    });

    // 300000 minor NGN (₦3000) * 0.5 = 150000 KES-minor = 1500 KES > MAX_STAKE (1000)
    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 300_000 } },
      noop,
    );

    expect(round.bets).toHaveLength(0);
    expect(wallet.bet).not.toHaveBeenCalled();
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ message: expect.stringMatching(/Max stake is KSh/i) }),
      }),
    );
  });

  it('allows an NGN stake whose KES-equivalent is under MAX_STAKE (bet placed, wallet debited)', async () => {
    const wallet = makeWalletMock();
    setLobbyWiringDeps({ wallet, fx: stubFx });

    const sessionId = 'lobby-session-2';
    const round = makeBettingRound(11);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Lucky Falcon',
      balance: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      lobbyPlayerId: 'lp-2',
      currency: 'NGN',
    });

    // 100000 minor NGN (₦1000) * 0.5 = 50000 KES-minor = 500 KES <= MAX_STAKE (1000)
    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 100_000 } },
      noop,
    );

    expect(wallet.bet).toHaveBeenCalledWith('lp-2', 100_000, expect.any(String), 'NGN');
    expect(round.bets).toHaveLength(1);
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({ type: 'bet_placed' }),
    );
  });

  it('records lobby stats in MINOR units tagged with the session currency, and ships them on bet_placed', async () => {
    // Regression: money sessions recorded no stats at all, so the in-game panel
    // sat at zero forever. They must record in minor units + currency — writing
    // a minor amount without the tag would render as a 100x major-unit figure.
    const wallet = makeWalletMock();
    setLobbyWiringDeps({ wallet, fx: stubFx });

    const sessionId = 'lobby-session-stats';
    const round = makeBettingRound(21);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Stat Falcon',
      balance: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      lobbyPlayerId: 'lp-stats',
      currency: 'NGN',
    });

    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 100_000 } },
      noop,
    );

    expect(mockRecordBet).toHaveBeenCalledWith(sessionId, 100_000, 'NGN');
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({
        type: 'bet_placed',
        data: expect.objectContaining({ stats: expect.objectContaining({ bets: 1 }) }),
      }),
    );
  });

  it('a stats-store outage does not fail a bet whose wallet debit already succeeded', async () => {
    const wallet = makeWalletMock();
    setLobbyWiringDeps({ wallet, fx: stubFx });
    mockRecordBet.mockRejectedValueOnce(new Error('store offline'));

    const sessionId = 'lobby-session-stats-down';
    const round = makeBettingRound(22);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Resilient Falcon',
      balance: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      lobbyPlayerId: 'lp-down',
      currency: 'NGN',
    });

    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 100_000 } },
      noop,
    );

    // The bet stands and the player is told so — just without a stats field.
    expect(wallet.bet).toHaveBeenCalledWith('lp-down', 100_000, expect.any(String), 'NGN');
    expect(round.bets).toHaveLength(1);
    const frame = mockSafeSend.mock.calls.map((c) => c[1]).find((f) => f?.type === 'bet_placed');
    expect(frame).toBeTruthy();
    expect(frame.data.stats).toBeUndefined();
    expect(mockSafeSend).not.toHaveBeenCalledWith(fakeWs, expect.objectContaining({ type: 'error' }));
  });

  it('M2: an FX outage (toKesMinor throws) rejects the bet gracefully instead of throwing out of the handler', async () => {
    const wallet = makeWalletMock();
    const flakyFx = { toKesMinor: vi.fn().mockRejectedValue(new Error('fx provider unreachable')) };
    setLobbyWiringDeps({ wallet, fx: flakyFx });

    const sessionId = 'lobby-session-4';
    const round = makeBettingRound(13);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Lucky Falcon',
      balance: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      lobbyPlayerId: 'lp-4',
      currency: 'NGN',
    });

    // Must not throw out of handleMessage — the FX failure should be caught
    // and surfaced as a normal error frame, with no bet placed and no debit.
    await expect(
      handleMessage(fakeWs, { type: 'place_bet', data: { sessionId, amountMinor: 100_000 } }, noop),
    ).resolves.toBeUndefined();

    expect(round.bets).toHaveLength(0);
    expect(wallet.bet).not.toHaveBeenCalled();
    expect(mockSafeSend).toHaveBeenCalledWith(
      fakeWs,
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('skips the KES cap check when fx is not wired (back-compat)', async () => {
    const wallet = makeWalletMock();
    setLobbyWiringDeps({ wallet }); // no fx

    const sessionId = 'lobby-session-3';
    const round = makeBettingRound(12);
    _internal__setCurrentRoundForTesting(round);

    mockGetSession.mockResolvedValueOnce({
      sessionId,
      displayName: 'Lucky Falcon',
      balance: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      lobbyPlayerId: 'lp-3',
      currency: 'NGN',
    });

    // Would fail the KES cap if fx were wired (300000 * 0.5 = 1500 KES), but
    // with no fx dependency the check must be skipped entirely.
    await handleMessage(
      fakeWs,
      { type: 'place_bet', data: { sessionId, amountMinor: 300_000 } },
      noop,
    );

    expect(wallet.bet).toHaveBeenCalled();
    expect(round.bets).toHaveLength(1);
  });
});
