import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  BetLog,
  BetNotFoundError,
  DuplicateBetIdError,
  DuplicateBetTxnIdError,
  IdempotencyMismatchError,
  type CreateBetInput,
  type IdempotencyEntry,
} from './bet-log.js';
import { InvalidTransitionError } from './state-machine.js';

function makeDb() {
  return new Database(':memory:');
}

function makeBetInput(override: Partial<CreateBetInput> = {}): CreateBetInput {
  return {
    betId: 'bet-001',
    operatorId: 'op-1',
    playerId: 'player-1',
    sessionId: 'sess-1',
    roundId: 'round-1',
    currency: 'EUR',
    amountMinor: 500,
    betTxnId: 'txn-bet-001',
    ...override,
  };
}

describe('BetLog', () => {
  let log: BetLog;

  beforeEach(() => {
    log = new BetLog(makeDb());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1 – create + getById round-trip
  // -------------------------------------------------------------------------
  it('create + getById: state=PENDING, all input fields present, nullable fields null, createdAt===updatedAt', () => {
    const input = makeBetInput();
    const row = log.create(input);

    expect(row.betId).toBe(input.betId);
    expect(row.operatorId).toBe(input.operatorId);
    expect(row.playerId).toBe(input.playerId);
    expect(row.sessionId).toBe(input.sessionId);
    expect(row.roundId).toBe(input.roundId);
    expect(row.currency).toBe(input.currency);
    expect(row.amountMinor).toBe(input.amountMinor);
    expect(row.betTxnId).toBe(input.betTxnId);
    expect(row.state).toBe('PENDING');
    expect(row.winTxnId).toBeNull();
    expect(row.rollbackTxnId).toBeNull();
    expect(row.betOpTxnId).toBeNull();
    expect(row.winOpTxnId).toBeNull();
    expect(row.winAmountMinor).toBeNull();
    expect(row.multiplier).toBeNull();
    expect(row.errorCode).toBeNull();
    expect(row.createdAt).toBe(row.updatedAt);

    const fetched = log.getById(input.betId);
    expect(fetched).not.toBeNull();
    expect(fetched!.betId).toBe(input.betId);
  });

  // -------------------------------------------------------------------------
  // Test 2 – duplicate betId → DuplicateBetIdError
  // -------------------------------------------------------------------------
  it('create with duplicate betId throws DuplicateBetIdError', () => {
    log.create(makeBetInput({ betId: 'bet-dup', betTxnId: 'txn-a' }));
    expect(() =>
      log.create(makeBetInput({ betId: 'bet-dup', betTxnId: 'txn-b' })),
    ).toThrow(DuplicateBetIdError);
  });

  // -------------------------------------------------------------------------
  // Test 3 – duplicate betTxnId (different betId) → DuplicateBetTxnIdError
  // -------------------------------------------------------------------------
  it('create with duplicate betTxnId (different betId) throws DuplicateBetTxnIdError', () => {
    log.create(makeBetInput({ betId: 'bet-a', betTxnId: 'txn-shared' }));
    expect(() =>
      log.create(makeBetInput({ betId: 'bet-b', betTxnId: 'txn-shared' })),
    ).toThrow(DuplicateBetTxnIdError);
  });

  // -------------------------------------------------------------------------
  // Test 4 – transition PENDING → ARMED, sideData applied, updatedAt advances
  // -------------------------------------------------------------------------
  it('transition PENDING→ARMED sets state + betOpTxnId; updatedAt > createdAt after time advance', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    log = new BetLog(makeDb());
    const row = log.create(makeBetInput());

    // Advance clock by 2 seconds so the unix-second timestamp increments
    vi.setSystemTime(now + 2000);

    const updated = log.transition(row.betId, 'bet_accepted', { betOpTxnId: 'op-1' });

    expect(updated.state).toBe('ARMED');
    expect(updated.betOpTxnId).toBe('op-1');
    expect(updated.updatedAt).toBeGreaterThan(row.createdAt);
  });

  // -------------------------------------------------------------------------
  // Test 5 – illegal event → InvalidTransitionError
  // -------------------------------------------------------------------------
  it('transition with illegal event on PENDING bet throws InvalidTransitionError', () => {
    const row = log.create(makeBetInput());
    expect(() => log.transition(row.betId, 'win_settled')).toThrow(InvalidTransitionError);
  });

  // -------------------------------------------------------------------------
  // Test 6 – missing betId → BetNotFoundError
  // -------------------------------------------------------------------------
  it('transition on nonexistent betId throws BetNotFoundError', () => {
    expect(() => log.transition('does-not-exist', 'bet_accepted')).toThrow(BetNotFoundError);
  });

  // -------------------------------------------------------------------------
  // Test 7 – full happy path chain PENDING → SETTLED
  // -------------------------------------------------------------------------
  it('full chain PENDING→ARMED→FLYING→SETTLING→SETTLED reflects all sideData', () => {
    const row = log.create(makeBetInput({ betId: 'bet-chain', betTxnId: 'txn-chain' }));

    log.transition(row.betId, 'bet_accepted', { betOpTxnId: 'op-bet-1' });
    log.transition(row.betId, 'round_started');
    log.transition(row.betId, 'cashout_requested');
    const settled = log.transition(row.betId, 'win_settled', {
      winTxnId: 'txn-win-1',
      winOpTxnId: 'op-win-1',
      winAmountMinor: 1500,
      multiplier: 3.0,
    });

    expect(settled.state).toBe('SETTLED');
    expect(settled.betOpTxnId).toBe('op-bet-1');
    expect(settled.winTxnId).toBe('txn-win-1');
    expect(settled.winOpTxnId).toBe('op-win-1');
    expect(settled.winAmountMinor).toBe(1500);
    expect(settled.multiplier).toBe(3.0);
  });

  // -------------------------------------------------------------------------
  // Test 8 – listByState with limit
  // -------------------------------------------------------------------------
  it('listByState returns only matching state; limit is respected', () => {
    log.create(makeBetInput({ betId: 'b1', betTxnId: 'txn-1' }));
    log.create(makeBetInput({ betId: 'b2', betTxnId: 'txn-2' }));
    log.create(makeBetInput({ betId: 'b3', betTxnId: 'txn-3' }));

    log.transition('b1', 'bet_accepted');
    log.transition('b2', 'bet_accepted');
    // b3 stays PENDING

    const armed = log.listByState('ARMED');
    expect(armed.length).toBe(2);
    expect(armed.every((r) => r.state === 'ARMED')).toBe(true);
    expect(armed.map((r) => r.betId).sort()).toEqual(['b1', 'b2'].sort());

    const limited = log.listByState('ARMED', 1);
    expect(limited.length).toBe(1);

    const pending = log.listByState('PENDING');
    expect(pending.length).toBe(1);
    expect(pending[0].betId).toBe('b3');
  });

  // -------------------------------------------------------------------------
  // Test 9 – idempotency: put/get round-trip; same hash = no-op; diff hash = error
  // -------------------------------------------------------------------------
  it('putIdempotency + getIdempotency round-trip; same hash idempotent; diff hash throws', () => {
    const entry: IdempotencyEntry = {
      txnId: 'txn-idem-1',
      operatorId: 'op-1',
      kind: 'bet',
      requestHash: 'hash-aaa',
      responseJson: '{"ok":true}',
      createdAt: Math.floor(Date.now() / 1000),
    };

    log.putIdempotency(entry);

    const fetched = log.getIdempotency(entry.txnId);
    expect(fetched).not.toBeNull();
    expect(fetched!.txnId).toBe(entry.txnId);
    expect(fetched!.requestHash).toBe(entry.requestHash);
    expect(fetched!.responseJson).toBe(entry.responseJson);
    expect(fetched!.kind).toBe('bet');

    // Same txnId + same requestHash → silent no-op (no throw)
    expect(() => log.putIdempotency({ ...entry })).not.toThrow();

    // Same txnId + different requestHash → IdempotencyMismatchError
    expect(() =>
      log.putIdempotency({ ...entry, requestHash: 'hash-bbb' }),
    ).toThrow(IdempotencyMismatchError);
  });

  // -------------------------------------------------------------------------
  // Test 10 – listByRound returns only bets for that roundId, ordered ASC
  // -------------------------------------------------------------------------
  it('listByRound returns only bets for the specified roundId, ordered by created_at ASC', () => {
    log.create(makeBetInput({ betId: 'b-r1-a', betTxnId: 'txn-r1-a', roundId: 'r1' }));
    log.create(makeBetInput({ betId: 'b-r1-b', betTxnId: 'txn-r1-b', roundId: 'r1' }));
    log.create(makeBetInput({ betId: 'b-r2',   betTxnId: 'txn-r2',   roundId: 'r2' }));

    const r1 = log.listByRound('r1');
    expect(r1.length).toBe(2);
    expect(r1.every((b) => b.roundId === 'r1')).toBe(true);

    // Verify ASC ordering (earlier created_at first)
    expect(r1[0].createdAt).toBeLessThanOrEqual(r1[1].createdAt);

    const r2 = log.listByRound('r2');
    expect(r2.length).toBe(1);
    expect(r2[0].betId).toBe('b-r2');

    const r3 = log.listByRound('r3');
    expect(r3.length).toBe(0);
  });
});
