import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { PgBetLog } from './bet-log-pg.js';
import { DuplicateBetIdError, DuplicateBetTxnIdError, BetNotFoundError, IdempotencyMismatchError } from './bet-log.js';
import { InvalidTransitionError } from './state-machine.js';

let seq = 0;
function betInput(over: Partial<Parameters<PgBetLog['create']>[0]> = {}) {
  seq += 1;
  return {
    betId: `bet-${seq}`, operatorId: 'op-a', playerId: 'pid-1', sessionId: 'sess-1',
    roundId: 'rnd-1', currency: 'EUR', amountMinor: 5000, betTxnId: `btxn-${seq}`,
    ...over,
  };
}

describe('PgBetLog', () => {
  let db: TestDb;
  let log: PgBetLog;
  beforeEach(async () => { db = await makeTestDb(); log = new PgBetLog(db.pool); });
  afterEach(async () => { await db.cleanup(); });

  it('create → getById: PENDING, all fields, defaults game_id', async () => {
    const created = await log.create(betInput({ betId: 'b1', betTxnId: 't1' }));
    expect(created.state).toBe('PENDING');
    expect(created.amountMinor).toBe(5000);
    expect(created.gameId).toBe('galaxy-crash');
    expect(created.winTxnId).toBeNull();
    const got = await log.getById('b1');
    expect(got?.betTxnId).toBe('t1');
    expect(await log.getByBetTxnId('t1')).not.toBeNull();
  });

  it('duplicate betId / betTxnId throw typed errors', async () => {
    await log.create(betInput({ betId: 'dup', betTxnId: 'x1' }));
    await expect(log.create(betInput({ betId: 'dup', betTxnId: 'x2' }))).rejects.toBeInstanceOf(DuplicateBetIdError);
    await expect(log.create(betInput({ betId: 'other', betTxnId: 'x1' }))).rejects.toBeInstanceOf(DuplicateBetTxnIdError);
  });

  it('full happy chain PENDING→ARMED→FLYING→SETTLING→SETTLED carries side data', async () => {
    await log.create(betInput({ betId: 'c', betTxnId: 'ct' }));
    await log.transition('c', 'bet_accepted', { betOpTxnId: 'op-1' });
    await log.transition('c', 'round_started');
    await log.transition('c', 'cashout_requested', { winTxnId: 'w1', multiplier: 2.0, winAmountMinor: 10000 });
    const settled = await log.transition('c', 'win_settled', { winOpTxnId: 'op-2' });
    expect(settled.state).toBe('SETTLED');
    expect(settled.betOpTxnId).toBe('op-1');
    expect(settled.winOpTxnId).toBe('op-2');
    expect(settled.winAmountMinor).toBe(10000);
    expect(settled.multiplier).toBe(2.0);
  });

  it('illegal transition → InvalidTransitionError; unknown bet → BetNotFoundError', async () => {
    await log.create(betInput({ betId: 'z', betTxnId: 'zt' }));
    await expect(log.transition('z', 'win_settled')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(log.transition('nope', 'bet_accepted')).rejects.toBeInstanceOf(BetNotFoundError);
  });

  it('round_crashed on ARMED → LOST', async () => {
    await log.create(betInput({ betId: 'l', betTxnId: 'lt' }));
    await log.transition('l', 'bet_accepted');
    const lost = await log.transition('l', 'round_crashed');
    expect(lost.state).toBe('LOST');
  });

  it('idempotency: insert, same-hash replay is noop, different hash mismatches, scoped by operator', async () => {
    const entry = { txnId: 'tx1', operatorId: 'op-a', kind: 'bet' as const, requestHash: 'h1', responseJson: '{"ok":true}', createdAt: 100 };
    await log.putIdempotency(entry);
    await expect(log.putIdempotency(entry)).resolves.toBeUndefined(); // same hash → noop
    await expect(log.putIdempotency({ ...entry, requestHash: 'h2' })).rejects.toBeInstanceOf(IdempotencyMismatchError);
    // same txnId, DIFFERENT operator → distinct row, allowed
    await expect(log.putIdempotency({ ...entry, operatorId: 'op-b' })).resolves.toBeUndefined();
    expect((await log.getIdempotency('op-a', 'tx1'))?.responseJson).toBe('{"ok":true}');
    expect(await log.getIdempotency('op-c', 'tx1')).toBeNull();
  });

  it('listByRound / listByState / listByPlayer / distinct sessions', async () => {
    await log.create(betInput({ betId: 'r1', betTxnId: 'r1t', roundId: 'R', sessionId: 's1' }));
    await log.create(betInput({ betId: 'r2', betTxnId: 'r2t', roundId: 'R', sessionId: 's2' }));
    await log.transition('r2', 'bet_accepted');
    expect((await log.listByRound('R')).length).toBe(2);
    expect((await log.listByState('PENDING')).map((b) => b.betId)).toContain('r1');
    expect((await log.listByState('ARMED')).map((b) => b.betId)).toEqual(['r2']);
    expect((await log.listByPlayer('op-a', 'pid-1')).length).toBe(2);
    expect((await log.listDistinctSessionIdsByPlayer('op-a', 'pid-1')).sort()).toEqual(['s1', 's2']);
  });

  it('financialReport: GGR = stake − win; VOIDED excluded, WIN_FAILED stake-only', async () => {
    // settled win: stake 5000, win 8000
    await log.create(betInput({ betId: 'f1', betTxnId: 'f1t', amountMinor: 5000 }));
    await log.transition('f1', 'bet_accepted'); await log.transition('f1', 'round_started');
    await log.transition('f1', 'cashout_requested', { winAmountMinor: 8000 }); await log.transition('f1', 'win_settled');
    // lost: stake 3000
    await log.create(betInput({ betId: 'f2', betTxnId: 'f2t', amountMinor: 3000 }));
    await log.transition('f2', 'bet_accepted'); await log.transition('f2', 'round_crashed');
    // voided: stake 9999 must NOT count
    await log.create(betInput({ betId: 'f3', betTxnId: 'f3t', amountMinor: 9999 }));
    await log.transition('f3', 'bet_rejected');
    // win_failed: stake 2000 counts, win does NOT
    await log.create(betInput({ betId: 'f4', betTxnId: 'f4t', amountMinor: 2000 }));
    await log.transition('f4', 'bet_accepted'); await log.transition('f4', 'round_started');
    await log.transition('f4', 'cashout_requested', { winAmountMinor: 12000 }); await log.transition('f4', 'win_failed');

    const rows = await log.financialReport({ groupBy: ['operator', 'currency'] });
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.stakeMinor).toBe(5000 + 3000 + 2000); // 10000 (voided excluded)
    expect(r.winMinor).toBe(8000);                  // settled only
    expect(r.ggrMinor).toBe(10000 - 8000);          // 2000
    expect(r.ngrMinor).toBe(2000);
    expect(r.betCount).toBe(3);
  });

  it('listBetsFiltered keyset pagination returns a cursor and no overlap', async () => {
    for (let i = 0; i < 5; i++) await log.create(betInput({ betId: `pg${i}`, betTxnId: `pgt${i}` }));
    const p1 = await log.listBetsFiltered({ operatorId: 'op-a' }, { limit: 2 });
    expect(p1.rows.length).toBe(2);
    expect(p1.nextCursor).not.toBeNull();
    const { decodeCursor } = await import('./cursor.js');
    const p2 = await log.listBetsFiltered({ operatorId: 'op-a' }, { limit: 2, cursor: decodeCursor(p1.nextCursor!) });
    const ids1 = p1.rows.map((r) => r.betId);
    const ids2 = p2.rows.map((r) => r.betId);
    expect(ids1.filter((x) => ids2.includes(x))).toEqual([]); // no overlap
  });

  it('listRoundsFiltered aggregates operator ids + currency totals', async () => {
    await log.create(betInput({ betId: 'a1', betTxnId: 'a1t', roundId: 'RR', currency: 'EUR', amountMinor: 1000 }));
    await log.create(betInput({ betId: 'a2', betTxnId: 'a2t', roundId: 'RR', currency: 'USD', amountMinor: 2000 }));
    const { rows } = await log.listRoundsFiltered({}, { limit: 10 });
    const round = rows.find((r) => r.roundId === 'RR')!;
    expect(round.betCount).toBe(2);
    expect(round.operatorIds).toEqual(['op-a']);
    expect(round.totalAmountMinorByCurrency).toEqual({ EUR: 1000, USD: 2000 });
  });

  it('listSessionsByPlayer summarises stake + settled win per session', async () => {
    await log.create(betInput({ betId: 's_a', betTxnId: 's_at', sessionId: 'S1', amountMinor: 1000 }));
    await log.transition('s_a', 'bet_accepted'); await log.transition('s_a', 'round_started');
    await log.transition('s_a', 'cashout_requested', { winAmountMinor: 2500 }); await log.transition('s_a', 'win_settled');
    const { rows } = await log.listSessionsByPlayer('op-a', 'pid-1', { limit: 10 });
    const s = rows.find((x) => x.sessionId === 'S1')!;
    expect(s.stakeMinor).toBe(1000);
    expect(s.winMinor).toBe(2500);
    expect(s.betCount).toBe(1);
  });
});
