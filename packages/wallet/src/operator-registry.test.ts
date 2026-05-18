import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  OperatorRegistry,
  DuplicateApiKeyError,
  DuplicateOperatorIdError,
  OperatorNotFoundError,
} from './operator-registry.js';

function makeDb() {
  return new Database(':memory:');
}

function makeInput(override: Partial<Parameters<OperatorRegistry['create']>[0]> = {}) {
  return {
    operatorId: 'op_test_001',
    name: 'Test Casino',
    walletBaseUrl: 'https://wallet.example.com',
    currencies: ['EUR', 'USD'],
    status: 'sandbox' as const,
    ...override,
  };
}

describe('OperatorRegistry', () => {
  let registry: OperatorRegistry;

  beforeEach(() => {
    registry = new OperatorRegistry(makeDb());
  });

  // -------------------------------------------------------------------------
  // Test 1 – create then getById returns operator with expected shape
  // -------------------------------------------------------------------------
  it('create then getById returns the same operator with non-empty apiKey and 32-byte signingKey', () => {
    const { operator, credentials } = registry.create(makeInput());

    expect(operator.operatorId).toBe('op_test_001');
    expect(operator.name).toBe('Test Casino');
    expect(operator.apiKey).toBeTruthy();
    expect(operator.apiKey.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(operator.signingKey)).toBe(true);
    expect(operator.signingKey.length).toBe(32);

    const fetched = registry.getById('op_test_001');
    expect(fetched).not.toBeNull();
    expect(fetched!.operatorId).toBe(operator.operatorId);
    expect(fetched!.apiKey).toBe(credentials.apiKey);
    expect(fetched!.signingKey.length).toBe(32);
  });

  // -------------------------------------------------------------------------
  // Test 2 – credentials contain base64 key that decodes to 32 bytes; getByApiKey works
  // -------------------------------------------------------------------------
  it('credentials signingKeyBase64 decodes to 32 bytes; getByApiKey finds the operator', () => {
    const { operator, credentials } = registry.create(makeInput());

    const decoded = Buffer.from(credentials.signingKeyBase64, 'base64');
    expect(decoded.length).toBe(32);

    const found = registry.getByApiKey(credentials.apiKey);
    expect(found).not.toBeNull();
    expect(found!.operatorId).toBe(operator.operatorId);
  });

  // -------------------------------------------------------------------------
  // Test 3 – list() returns all; list({ status }) filters correctly
  // -------------------------------------------------------------------------
  it('list() returns all operators; list({ status }) filters correctly', () => {
    registry.create(makeInput({ operatorId: 'op_001', status: 'sandbox' }));
    registry.create(makeInput({ operatorId: 'op_002', status: 'active' }));
    registry.create(makeInput({ operatorId: 'op_003', status: 'active' }));

    const all = registry.list();
    expect(all.length).toBe(3);

    const active = registry.list({ status: 'active' });
    expect(active.length).toBe(2);
    expect(active.every((o) => o.status === 'active')).toBe(true);

    const sandbox = registry.list({ status: 'sandbox' });
    expect(sandbox.length).toBe(1);
    expect(sandbox[0].status).toBe('sandbox');
  });

  // -------------------------------------------------------------------------
  // Test 4 – update reflects on next getById; updatedAt advances strictly
  // -------------------------------------------------------------------------
  it('update reflects on next getById; updatedAt advances strictly', async () => {
    registry.create(makeInput());
    const before = registry.getById('op_test_001')!;

    // Ensure at least 1 second passes so unix-second timestamps differ
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const updated = registry.update('op_test_001', { status: 'paused' });
    expect(updated.status).toBe('paused');
    expect(updated.updatedAt).toBeGreaterThan(before.updatedAt);

    const fetched = registry.getById('op_test_001')!;
    expect(fetched.status).toBe('paused');
    expect(fetched.updatedAt).toBeGreaterThan(before.updatedAt);
  });

  // -------------------------------------------------------------------------
  // Test 5 – collision on apiKey throws DuplicateApiKeyError
  // -------------------------------------------------------------------------
  it('two creates with colliding apiKey throws DuplicateApiKeyError', () => {
    const fixedKey = 'ak_test_aabbccddeeff001122334455';
    const opts = { generateApiKey: () => fixedKey };

    const reg = new OperatorRegistry(makeDb(), opts);
    reg.create(makeInput({ operatorId: 'op_a' }));

    expect(() => reg.create(makeInput({ operatorId: 'op_b' }))).toThrow(DuplicateApiKeyError);
  });

  // -------------------------------------------------------------------------
  // Test 6 – getById nonexistent returns null; update nonexistent throws
  // -------------------------------------------------------------------------
  it('getById nonexistent returns null; update nonexistent throws OperatorNotFoundError', () => {
    const result = registry.getById('does_not_exist');
    expect(result).toBeNull();

    expect(() => registry.update('does_not_exist', { status: 'active' })).toThrow(
      OperatorNotFoundError,
    );
  });

  // -------------------------------------------------------------------------
  // Test 7 – create twice with same operatorId throws DuplicateOperatorIdError
  // -------------------------------------------------------------------------
  it('create twice with same operatorId throws DuplicateOperatorIdError', () => {
    // Use a counter-based apiKey generator so the two creates get different api keys
    // and the collision is on operator_id, not api_key.
    let counter = 0;
    const opts = {
      generateApiKey: () => `ak_test_fixed_${++counter}`,
    };

    const reg = new OperatorRegistry(makeDb(), opts);
    reg.create(makeInput({ operatorId: 'op_dup' }));

    expect(() => reg.create(makeInput({ operatorId: 'op_dup' }))).toThrow(DuplicateOperatorIdError);
  });

  // -------------------------------------------------------------------------
  // Test 8 – regenSigningKey returns new credentials; nonexistent throws
  // -------------------------------------------------------------------------
  it('regenSigningKey returns new key; getById reflects change; apiKey unchanged; nonexistent throws', () => {
    const { operator, credentials } = registry.create(makeInput());
    const originalSigningKey = operator.signingKey;
    const originalApiKey = credentials.apiKey;

    const newCreds = registry.regenSigningKey(operator.operatorId);

    // Returned credentials have new signing key
    expect(newCreds.apiKey).toBe(originalApiKey);
    const newKeyBuf = Buffer.from(newCreds.signingKeyBase64, 'base64');
    expect(newKeyBuf.length).toBe(32);
    expect(newKeyBuf.equals(originalSigningKey)).toBe(false);

    // getById reflects the new signing key
    const fetched = registry.getById(operator.operatorId)!;
    expect(fetched.apiKey).toBe(originalApiKey);
    expect(fetched.signingKey.length).toBe(32);
    expect(fetched.signingKey.equals(originalSigningKey)).toBe(false);
    expect(fetched.signingKey.toString('base64')).toBe(newCreds.signingKeyBase64);

    // Nonexistent operator throws OperatorNotFoundError
    expect(() => registry.regenSigningKey('nonexistent')).toThrow(OperatorNotFoundError);
  });
});
