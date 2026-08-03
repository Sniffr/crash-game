import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { PgOperatorAudit } from './operator-audit-pg.js';

describe('PgOperatorAudit', () => {
  let db: TestDb;
  let audit: PgOperatorAudit;

  beforeEach(async () => {
    db = await makeTestDb();
    audit = new PgOperatorAudit(db.pool);
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('record → listByOperator shows it, with parsed payload and coerced numerics', async () => {
    await audit.recordAsync({
      operatorId: 'op_1',
      action: 'player.lock',
      target: 'player_42',
      payload: { reason: 'fraud', message: 'manual review' },
    });

    const rows = await audit.listByOperator('op_1');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.operatorId).toBe('op_1');
    expect(row.action).toBe('player.lock');
    expect(row.target).toBe('player_42');
    expect(row.payload).toEqual({ reason: 'fraud', message: 'manual review' });
    // pg returns bigserial/bigint as strings — must be coerced to numbers.
    expect(typeof row.id).toBe('number');
    expect(typeof row.at).toBe('number');
    expect(row.at).toBeGreaterThan(0);
  });

  it('records a null payload when payload is undefined', async () => {
    await audit.recordAsync({ operatorId: 'op_1', action: 'session.terminate', target: 's_1' });
    const rows = await audit.listByOperator('op_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBeUndefined();
  });

  it('scopes results by operator_id — cross-tenant rows are never returned', async () => {
    await audit.recordAsync({ operatorId: 'op_a', action: 'player.lock', target: 'p1' });
    await audit.recordAsync({ operatorId: 'op_b', action: 'player.lock', target: 'p2' });
    await audit.recordAsync({ operatorId: 'op_a', action: 'player.unlock', target: 'p1' });

    const a = await audit.listByOperator('op_a');
    expect(a.map((r) => r.target)).toEqual(['p1', 'p1']);
    expect(a.every((r) => r.operatorId === 'op_a')).toBe(true);

    const b = await audit.listByOperator('op_b');
    expect(b).toHaveLength(1);
    expect(b[0]!.operatorId).toBe('op_b');
  });

  it('returns rows newest-first and honours the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.recordAsync({ operatorId: 'op_1', action: 'limits.update', target: `t_${i}` });
    }
    const all = await audit.listByOperator('op_1');
    expect(all).toHaveLength(5);
    // newest-first ⇒ highest id first ⇒ last inserted target (t_4) leads.
    expect(all[0]!.target).toBe('t_4');
    expect(all[4]!.target).toBe('t_0');

    const limited = await audit.listByOperator('op_1', { limit: 2 });
    expect(limited.map((r) => r.target)).toEqual(['t_4', 't_3']);
  });

  it('record() (void, fire-and-forget) eventually persists the row', async () => {
    audit.record({ operatorId: 'op_1', action: 'player.lock', target: 'p9' });
    // record() does not await; poll until the fire-and-forget insert lands.
    let rows: Awaited<ReturnType<PgOperatorAudit['listByOperator']>> = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      rows = await audit.listByOperator('op_1');
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe('p9');
  });
});
