import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { PgOperatorRegistry } from './operator-registry-pg.js';
import { DuplicateApiKeyError, DuplicateOperatorIdError, OperatorNotFoundError } from './operator-registry.js';

function makeInput(override: Partial<Parameters<PgOperatorRegistry['create']>[0]> = {}) {
  return {
    operatorId: 'op_test_001',
    name: 'Test Casino',
    walletBaseUrl: 'https://wallet.example.com',
    currencies: ['EUR', 'USD'],
    status: 'sandbox' as const,
    ...override,
  };
}

describe('PgOperatorRegistry', () => {
  let db: TestDb;
  let reg: PgOperatorRegistry;
  beforeEach(async () => {
    db = await makeTestDb();
    reg = new PgOperatorRegistry(db.pool);
    await reg.refresh();
  });
  afterEach(async () => { await db.cleanup(); });

  it('create → sync reads reflect it after the async write', async () => {
    const { operator, credentials } = await reg.create(makeInput());
    expect(operator.operatorId).toBe('op_test_001');
    expect(operator.currencies).toEqual(['EUR', 'USD']);
    expect(credentials.apiKey).toMatch(/^ak_test_/);
    expect(credentials.signingKeyBase64).toHaveLength(44); // 32 bytes b64
    // sync cache reads
    expect(reg.getById('op_test_001')?.name).toBe('Test Casino');
    expect(reg.getByApiKey(credentials.apiKey)?.operatorId).toBe('op_test_001');
    expect(reg.list().map((o) => o.operatorId)).toEqual(['op_test_001']);
  });

  it('signing key round-trips as a 32-byte Buffer', async () => {
    const { operator } = await reg.create(makeInput());
    expect(Buffer.isBuffer(operator.signingKey)).toBe(true);
    expect(operator.signingKey).toHaveLength(32);
  });

  it('duplicate operatorId → DuplicateOperatorIdError', async () => {
    await reg.create(makeInput());
    await expect(reg.create(makeInput())).rejects.toBeInstanceOf(DuplicateOperatorIdError);
  });

  it('duplicate api key → DuplicateApiKeyError', async () => {
    const fixedKey = 'ak_test_collision';
    const r = new PgOperatorRegistry(db.pool, { generateApiKey: () => fixedKey });
    await r.refresh();
    await r.create(makeInput({ operatorId: 'a' }));
    await expect(r.create(makeInput({ operatorId: 'b' }))).rejects.toBeInstanceOf(DuplicateApiKeyError);
  });

  it('update patches fields; unknown id → OperatorNotFoundError', async () => {
    await reg.create(makeInput());
    const updated = await reg.update('op_test_001', { name: 'Renamed', status: 'active', shareBps: 2000 });
    expect(updated.name).toBe('Renamed');
    expect(updated.status).toBe('active');
    expect(updated.shareBps).toBe(2000);
    expect(reg.getById('op_test_001')?.name).toBe('Renamed'); // cache refreshed
    await expect(reg.update('ghost', { name: 'x' })).rejects.toBeInstanceOf(OperatorNotFoundError);
  });

  it('regenSigningKey rotates the key, keeps api key, invalidates old lookups', async () => {
    const { credentials } = await reg.create(makeInput());
    const before = reg.getById('op_test_001')!.signingKey.toString('base64');
    const creds2 = await reg.regenSigningKey('op_test_001');
    expect(creds2.apiKey).toBe(credentials.apiKey);
    expect(creds2.signingKeyBase64).not.toBe(before);
    expect(reg.getById('op_test_001')!.signingKey.toString('base64')).toBe(creds2.signingKeyBase64);
  });

  it('delete removes from PG + cache', async () => {
    await reg.create(makeInput());
    await reg.delete('op_test_001');
    expect(reg.getById('op_test_001')).toBeNull();
    expect(reg.list()).toEqual([]);
    await expect(reg.delete('op_test_001')).rejects.toBeInstanceOf(OperatorNotFoundError);
  });

  it('list filters by status and preserves created order', async () => {
    await reg.create(makeInput({ operatorId: 'a', status: 'active' }));
    await reg.create(makeInput({ operatorId: 'b', status: 'sandbox' }));
    await reg.create(makeInput({ operatorId: 'c', status: 'active' }));
    expect(reg.list().map((o) => o.operatorId)).toEqual(['a', 'b', 'c']);
    expect(reg.list({ status: 'active' }).map((o) => o.operatorId)).toEqual(['a', 'c']);
  });

  it('a fresh registry sees persisted operators after refresh()', async () => {
    await reg.create(makeInput());
    const reg2 = new PgOperatorRegistry(db.pool);
    expect(reg2.getById('op_test_001')).toBeNull(); // not yet loaded
    await reg2.refresh();
    expect(reg2.getById('op_test_001')?.name).toBe('Test Casino');
  });
});
