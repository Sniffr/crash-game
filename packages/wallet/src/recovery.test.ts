/**
 * Integration tests for runRecovery (Task 1.7).
 *
 * TRUE end-to-end: real WalletClient → real HTTP → real operator-stub →
 * real BetLog (:memory: sqlite) + real OperatorRegistry (:memory: sqlite).
 *
 * Mirrors bets.test.ts setup: startServer(0) in beforeAll, resetStubState in
 * beforeEach, fresh BetLog+OperatorRegistry per test.
 */

import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';
import {
  startServer,
  resetStubState,
} from '../../../tools/operator-stub/src/index.js';

import {
  BetLog,
  OperatorRegistry,
  WalletClient,
  type BetRow,
  type Alerter,
  type AlertEvent,
} from './index.js';
import type { Operator } from './types.js';
import { runRecovery, type RecoveryDeps } from './recovery.js';

// ---------------------------------------------------------------------------
// Constants — must match operator-stub defaults
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';
const SIGNING_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------

let server: Server;
let port: number;

beforeAll(async () => {
  server = startServer(0) as unknown as Server;
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!port) throw new Error('Could not determine stub server port');
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ---------------------------------------------------------------------------
// Per-test helpers
// ---------------------------------------------------------------------------

let betLog: BetLog;
let registry: OperatorRegistry;
let operatorId: string;
let operator: Operator;
let deps: RecoveryDeps;

function makeNoop(): (ms: number) => Promise<void> {
  return async () => {};
}

function makeFastClientFactory() {
  return (op: Operator) => new WalletClient(op, { sleep: makeNoop() });
}

beforeEach(() => {
  resetStubState();

  // Build registry with the stub's known signing key so HMAC verification passes
  const db = new Database(':memory:');
  operatorId = 'op-test';
  betLog = new BetLog(db);
  let _akSeq = 0;
  registry = new OperatorRegistry(db, {
    generateSigningKey: () => SIGNING_KEY,
    generateApiKey: () => `ak-test-${Date.now()}-${++_akSeq}`,
  });
  const { operator: op } = registry.create({
    operatorId,
    name: 'Test Operator',
    walletBaseUrl: `http://localhost:${port}`,
    adapter: 'native',
    currencies: ['EUR', 'USD'],
    status: 'active',
  });
  operator = op;

  deps = {
    betLog,
    registry,
    clientFactory: makeFastClientFactory(),
    log: () => {}, // suppress log noise in tests
  };
});

afterEach(() => {
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
// Helper: build a fast WalletClient for direct stub calls in seeding
// ---------------------------------------------------------------------------

function makeStubClient(): WalletClient {
  return new WalletClient(operator, { sleep: makeNoop() });
}

// ---------------------------------------------------------------------------
// Test 1: empty bet_log → zero-everything report
// ---------------------------------------------------------------------------

it('empty bet_log → all-zero report', async () => {
  const report = await runRecovery(deps);

  expect(report.pending).toEqual({ found: 0, resolved: 0, failed: 0, skipped: 0 });
  expect(report.rollbackPending).toEqual({ found: 0, resolved: 0, failed: 0, skipped: 0 });
  expect(report.settling).toEqual({ found: 0, resolved: 0, failed: 0, skipped: 0 });
});

// ---------------------------------------------------------------------------
// Test 2: PENDING → VOIDED via /rollback noop
// The stub has never seen this betTxnId, so /rollback returns noop.
// ---------------------------------------------------------------------------

it('PENDING → VOIDED via /rollback noop (stub never saw the bet)', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');

  // Seed a PENDING row (betLog.create defaults to PENDING)
  betLog.create({
    betId,
    operatorId,
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId: uid('round'),
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId,
  });

  expect(betLog.getById(betId)?.state).toBe('PENDING');

  const alertEmits: AlertEvent[] = [];
  const fakeAlerter: Alerter = { emit: (e) => alertEmits.push(e) };
  const report = await runRecovery({
    ...deps,
    alerter: fakeAlerter,
  });

  // Row must now be VOIDED
  const row = betLog.getById(betId);
  expect(row?.state).toBe('VOIDED');
  expect(row?.rollbackTxnId).toBeTruthy();

  // Report: pending.resolved = 1
  expect(report.pending.found).toBe(1);
  expect(report.pending.resolved).toBe(1);
  expect(report.pending.failed).toBe(0);
  expect(report.pending.skipped).toBe(0);

  // rollbackPending should not count this row
  expect(report.rollbackPending.found).toBe(0);

  // Stub balance unchanged (noop means no debit ever happened)
  const client = makeStubClient();
  const balResp = await client.balance({ playerId: 'pid-1', sessionId: 'sess-pid-1' });
  expect(balResp.balance).toBe(100_000);

  // No alert emitted for a clean VOIDED resolution
  expect(alertEmits).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 3: ROLLBACK_PENDING (post-debit) → VOIDED with actual refund
// Seed: place a real /bet → stub debits pid-1 → put row in ROLLBACK_PENDING.
// ---------------------------------------------------------------------------

it('ROLLBACK_PENDING (post-debit) → VOIDED with actual refund', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const roundId = uid('round');

  // Place a real /bet against the stub so pid-1 is debited
  const stubClient = makeStubClient();
  await stubClient.bet({
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId,
    betId,
    txnId: betTxnId,
    amountMinor: 10_000,
    currency: 'EUR',
    gameId: 'galaxy-crash',
    placedAt: Math.floor(Date.now() / 1000),
  });

  // Manually seed the row: PENDING → ROLLBACK_PENDING
  betLog.create({
    betId,
    operatorId,
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId,
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId,
  });
  betLog.transition(betId, 'rollback_started', { errorCode: 'crashed_mid_bet' });
  expect(betLog.getById(betId)?.state).toBe('ROLLBACK_PENDING');

  // pid-1 balance should be 90000 now (debited by /bet)
  const beforeBalance = await stubClient.balance({ playerId: 'pid-1', sessionId: 'sess-pid-1' });
  expect(beforeBalance.balance).toBe(90_000);

  const report = await runRecovery(deps);

  // Row must now be VOIDED
  const row = betLog.getById(betId);
  expect(row?.state).toBe('VOIDED');
  expect(row?.rollbackTxnId).toBeTruthy();

  // Balance restored to 100000
  const afterBalance = await stubClient.balance({ playerId: 'pid-1', sessionId: 'sess-pid-1' });
  expect(afterBalance.balance).toBe(100_000);

  // Report
  expect(report.rollbackPending.found).toBe(1);
  expect(report.rollbackPending.resolved).toBe(1);
  expect(report.rollbackPending.failed).toBe(0);
  expect(report.rollbackPending.skipped).toBe(0);
  expect(report.pending.found).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 4: SETTLING → SETTLED
// Seed: real /bet → ARMED, then cashout_requested → SETTLING (don't call /win).
// ---------------------------------------------------------------------------

it('SETTLING → SETTLED via /win replay', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const winTxnId = uid('wtxn');
  const roundId = uid('round');

  const stubClient = makeStubClient();

  // Place real /bet
  const betResp = await stubClient.bet({
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId,
    betId,
    txnId: betTxnId,
    amountMinor: 10_000,
    currency: 'EUR',
    gameId: 'galaxy-crash',
    placedAt: Math.floor(Date.now() / 1000),
  });

  // Seed bet_log: PENDING → ARMED → SETTLING
  betLog.create({
    betId,
    operatorId,
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId,
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId,
  });
  betLog.transition(betId, 'bet_accepted', { betOpTxnId: betResp.operatorTxnId });
  betLog.transition(betId, 'cashout_requested', {
    winTxnId,
    multiplier: 2.0,
    winAmountMinor: 20_000,
  });
  expect(betLog.getById(betId)?.state).toBe('SETTLING');

  const report = await runRecovery(deps);

  const row = betLog.getById(betId);
  expect(row?.state).toBe('SETTLED');
  expect(row?.winOpTxnId).toBeTruthy();

  // Balance: 100000 - 10000 (bet) + 20000 (win) = 110000
  const balResp = await stubClient.balance({ playerId: 'pid-1', sessionId: 'sess-pid-1' });
  expect(balResp.balance).toBe(110_000);

  // Report
  expect(report.settling.found).toBe(1);
  expect(report.settling.resolved).toBe(1);
  expect(report.settling.failed).toBe(0);
  expect(report.settling.skipped).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 5: SETTLING win exhaustion → WIN_FAILED
// clientFactory injects an always-throwing fetchImpl so /win always fails.
// ---------------------------------------------------------------------------

it('SETTLING → WIN_FAILED when /win exhausts retries', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');
  const winTxnId = uid('wtxn');
  const roundId = uid('round');

  const stubClient = makeStubClient();

  // Place real /bet
  const betResp = await stubClient.bet({
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId,
    betId,
    txnId: betTxnId,
    amountMinor: 10_000,
    currency: 'EUR',
    gameId: 'galaxy-crash',
    placedAt: Math.floor(Date.now() / 1000),
  });

  // Seed row in SETTLING
  betLog.create({
    betId,
    operatorId,
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId,
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId,
  });
  betLog.transition(betId, 'bet_accepted', { betOpTxnId: betResp.operatorTxnId });
  betLog.transition(betId, 'cashout_requested', {
    winTxnId,
    multiplier: 2.0,
    winAmountMinor: 20_000,
  });
  expect(betLog.getById(betId)?.state).toBe('SETTLING');

  // clientFactory that always throws
  const alwaysThrowFetch: typeof fetch = async () => {
    throw new Error('simulated-econnrefused');
  };

  const failClientFactory = (op: Operator) =>
    new WalletClient(op, {
      fetchImpl: alwaysThrowFetch,
      sleep: makeNoop(),
    });

  const alertEmits: AlertEvent[] = [];
  const fakeAlerter: Alerter = { emit: (e) => alertEmits.push(e) };
  const report = await runRecovery({
    ...deps,
    clientFactory: failClientFactory,
    alerter: fakeAlerter,
  });

  const row = betLog.getById(betId);
  expect(row?.state).toBe('WIN_FAILED');
  expect(row?.errorCode).toBeTruthy();

  // Alerter must have been called exactly once for the exhausted SETTLING row
  expect(alertEmits).toHaveLength(1);
  expect(alertEmits[0]).toMatchObject({
    kind: 'win_failed',
    source: 'recovery',
    betRow: expect.objectContaining({ betId }),
  });

  expect(report.settling.found).toBe(1);
  expect(report.settling.failed).toBe(1);
  expect(report.settling.resolved).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 6: operator-not-found → skipped (no crash)
// ---------------------------------------------------------------------------

it('operator-not-found → row unchanged, skipped counted, no throw', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');

  // Create row with a bogus operatorId NOT in the registry
  const db2 = new Database(':memory:');
  const isolatedBetLog = new BetLog(db2);
  const isolatedRegistry = new OperatorRegistry(db2); // empty — no operators

  isolatedBetLog.create({
    betId,
    operatorId: 'op-missing',
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId: uid('round'),
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId,
  });

  // Transition to ROLLBACK_PENDING so it tries operator lookup
  isolatedBetLog.transition(betId, 'rollback_started', { errorCode: 'crashed_mid_bet' });

  const report = await runRecovery({
    betLog: isolatedBetLog,
    registry: isolatedRegistry,
    clientFactory: makeFastClientFactory(),
    log: () => {},
  });

  // Row state unchanged — still ROLLBACK_PENDING
  const row = isolatedBetLog.getById(betId);
  expect(row?.state).toBe('ROLLBACK_PENDING');

  expect(report.rollbackPending.skipped).toBe(1);
  expect(report.rollbackPending.resolved).toBe(0);
  expect(report.rollbackPending.failed).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 7: idempotent re-run → zero work on second call
// After test-2-style resolution (PENDING → VOIDED), a second runRecovery
// finds no non-terminal rows.
// ---------------------------------------------------------------------------

it('idempotent re-run after resolution yields all-zero counts', async () => {
  const betId = uid('bet');
  const betTxnId = uid('btxn');

  betLog.create({
    betId,
    operatorId,
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId: uid('round'),
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId,
  });

  // First run resolves it
  const report1 = await runRecovery(deps);
  expect(betLog.getById(betId)?.state).toBe('VOIDED');
  expect(report1.pending.resolved).toBe(1);

  // Second run: no rows to process
  const report2 = await runRecovery(deps);
  expect(report2.pending).toEqual({ found: 0, resolved: 0, failed: 0, skipped: 0 });
  expect(report2.rollbackPending).toEqual({ found: 0, resolved: 0, failed: 0, skipped: 0 });
  expect(report2.settling).toEqual({ found: 0, resolved: 0, failed: 0, skipped: 0 });
});

// ---------------------------------------------------------------------------
// Test 8: throwing clientFactory → row skipped (not failed), sweep continues,
// no throw; factory called at most once per operator (cache-on-throw).
// ---------------------------------------------------------------------------

it('throwing clientFactory caches null: row 1 skipped, row 2 resolved, factory called exactly twice', async () => {
  // Register a second operator (same stub URL, same key) for the second row
  const operatorId2 = 'op-test-2';
  registry.create({
    operatorId: operatorId2,
    name: 'Test Operator 2',
    walletBaseUrl: `http://localhost:${port}`,
    adapter: 'native',
    currencies: ['EUR', 'USD'],
    status: 'active',
  });

  const betId1 = uid('bet');
  const betTxnId1 = uid('btxn');
  const betId2 = uid('bet');
  const betTxnId2 = uid('btxn');

  // Seed two ROLLBACK_PENDING rows for two different operators
  betLog.create({
    betId: betId1,
    operatorId,       // op-test → factory throws on first call
    playerId: 'pid-1',
    sessionId: 'sess-pid-1',
    roundId: uid('round'),
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId: betTxnId1,
  });
  betLog.transition(betId1, 'rollback_started', { errorCode: 'recovery_pending_at_startup' });

  betLog.create({
    betId: betId2,
    operatorId: operatorId2, // op-test-2 → factory succeeds on second call
    playerId: 'pid-2',
    sessionId: 'sess-pid-2',
    roundId: uid('round'),
    currency: 'EUR',
    amountMinor: 10_000,
    betTxnId: betTxnId2,
  });
  betLog.transition(betId2, 'rollback_started', { errorCode: 'recovery_pending_at_startup' });

  // clientFactory that throws synchronously the first time, works thereafter
  let callCount = 0;
  const throwingOnceFactory = (op: Operator) => {
    callCount++;
    if (callCount === 1) {
      throw new Error('simulated-factory-failure-on-first-call');
    }
    return new WalletClient(op, { sleep: makeNoop() });
  };

  // runRecovery must NOT throw — call it directly and let the test fail if it does
  const report = await runRecovery({
    ...deps,
    clientFactory: throwingOnceFactory,
  });

  // Row 1: still ROLLBACK_PENDING — factory threw → null cached → counted as skipped
  expect(betLog.getById(betId1)?.state).toBe('ROLLBACK_PENDING');

  // Row 2: reached VOIDED (sweep continued past the skipped operator)
  expect(betLog.getById(betId2)?.state).toBe('VOIDED');

  // Report: skipped=1 (factory threw for op-test), resolved=1 (op-test-2 worked)
  expect(report!.rollbackPending.skipped).toBe(1);
  expect(report!.rollbackPending.resolved).toBe(1);

  // Factory was called exactly twice (once per operator) — proves cache-on-throw
  expect(callCount).toBe(2);
});
