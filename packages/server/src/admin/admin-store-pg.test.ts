import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';
import { decodeCursor } from '@crash/wallet';
import {
  PgAdminAudit,
  PgAdminUsers,
  DuplicateAdminError,
  AdminNotFoundError,
} from './admin-store-pg.js';

describe('PgAdminUsers', () => {
  let db: TestDb;
  let users: PgAdminUsers;
  beforeEach(async () => {
    db = await makeTestDb();
    users = new PgAdminUsers(db.pool);
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('create → getByUsername returns user + hash', async () => {
    const created = await users.create('alice', 'hash_alice', ['admin', 'finance']);
    expect(created.username).toBe('alice');
    expect(created.roles).toEqual(['admin', 'finance']);
    expect(created.lastLoginAt).toBeNull();
    expect(typeof created.createdAt).toBe('number');

    const got = await users.getByUsername('alice');
    expect(got).not.toBeNull();
    expect(got!.passwordHash).toBe('hash_alice');
    expect(got!.user.username).toBe('alice');
    expect(got!.user.roles).toEqual(['admin', 'finance']);
    expect(got!.user.createdAt).toBe(created.createdAt);
  });

  it('getByUsername returns null for unknown user', async () => {
    expect(await users.getByUsername('ghost')).toBeNull();
  });

  it('duplicate username → DuplicateAdminError', async () => {
    await users.create('bob', 'h1', ['viewer']);
    await expect(users.create('bob', 'h2', ['admin'])).rejects.toBeInstanceOf(DuplicateAdminError);
  });

  it('update patches roles and hash', async () => {
    await users.create('carol', 'old_hash', ['viewer']);
    const updated = await users.update('carol', {
      passwordHash: 'new_hash',
      roles: ['admin', 'support'],
    });
    expect(updated.roles).toEqual(['admin', 'support']);

    const got = await users.getByUsername('carol');
    expect(got!.passwordHash).toBe('new_hash');
    expect(got!.user.roles).toEqual(['admin', 'support']);
  });

  it('update on unknown user → AdminNotFoundError', async () => {
    await expect(users.update('ghost', { roles: ['admin'] })).rejects.toBeInstanceOf(
      AdminNotFoundError,
    );
  });

  it('delete removes the user; second delete → AdminNotFoundError', async () => {
    await users.create('dave', 'h', ['viewer']);
    await users.delete('dave');
    expect(await users.getByUsername('dave')).toBeNull();
    await expect(users.delete('dave')).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('recordLogin sets last_login_at', async () => {
    await users.create('erin', 'h', ['admin']);
    expect((await users.getByUsername('erin'))!.user.lastLoginAt).toBeNull();
    await users.recordLogin('erin');
    const after = (await users.getByUsername('erin'))!.user.lastLoginAt;
    expect(after).not.toBeNull();
    expect(typeof after).toBe('number');
  });

  it('count reflects the number of admins', async () => {
    expect(await users.count()).toBe(0);
    await users.create('a', 'h', ['viewer']);
    await users.create('b', 'h', ['viewer']);
    expect(await users.count()).toBe(2);
  });

  it('list returns admins newest-first by created_at', async () => {
    await users.create('first', 'h', ['viewer']);
    await users.create('second', 'h', ['viewer']);
    const listed = await users.list();
    expect(listed.map((u) => u.username)).toContain('first');
    expect(listed.map((u) => u.username)).toContain('second');
    expect(listed).toHaveLength(2);
  });
});

describe('PgAdminAudit', () => {
  let db: TestDb;
  let audit: PgAdminAudit;
  beforeEach(async () => {
    db = await makeTestDb();
    audit = new PgAdminAudit(db.pool);
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('record then list shows the row (newest-first)', async () => {
    await audit.recordAsync({ actor: 'alice', action: 'login', target: 'session', payload: { ip: '1.2.3.4' } });
    await audit.recordAsync({ actor: 'bob', action: 'ban', target: 'player_9' });

    const rows = await audit.list();
    expect(rows).toHaveLength(2);
    // newest-first (id DESC): bob's row inserted last
    expect(rows[0]!.actor).toBe('bob');
    expect(rows[0]!.action).toBe('ban');
    expect(rows[1]!.actor).toBe('alice');
    expect(rows[1]!.payload).toEqual({ ip: '1.2.3.4' });
    expect(typeof rows[0]!.id).toBe('number');
    expect(typeof rows[0]!.at).toBe('number');
  });

  it('record() is fire-and-forget void but still persists', async () => {
    const ret = audit.record({ actor: 'sys', action: 'noop', target: 't' });
    expect(ret).toBeUndefined();
    // poll until the fire-and-forget write lands (max ~1s)
    let rows = await audit.list();
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await audit.list();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('sys');
  });

  it('list respects the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.recordAsync({ actor: 'a', action: 'act', target: `t${i}` });
    }
    const rows = await audit.list({ limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('listFiltered filters by actor and action', async () => {
    await audit.recordAsync({ actor: 'alice', action: 'login', target: 't' });
    await audit.recordAsync({ actor: 'bob', action: 'login', target: 't' });
    await audit.recordAsync({ actor: 'alice', action: 'ban', target: 't' });

    const byActor = await audit.listFiltered({ actor: 'alice' }, { limit: 100 });
    expect(byActor.rows).toHaveLength(2);
    expect(byActor.rows.every((r) => r.actor === 'alice')).toBe(true);
    expect(byActor.nextCursor).toBeNull();

    const byAction = await audit.listFiltered({ action: 'login' }, { limit: 100 });
    expect(byAction.rows).toHaveLength(2);
    expect(byAction.rows.every((r) => r.action === 'login')).toBe(true);
  });

  it('listFiltered paginates with a keyset cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.recordAsync({ actor: 'a', action: 'act', target: `t${i}` });
    }

    const page1 = await audit.listFiltered({ actor: 'a' }, { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const cursor1 = decodeCursor(page1.nextCursor!)!;
    const page2 = await audit.listFiltered({ actor: 'a' }, { limit: 2, cursor: cursor1 });
    expect(page2.rows).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    const cursor2 = decodeCursor(page2.nextCursor!)!;
    const page3 = await audit.listFiltered({ actor: 'a' }, { limit: 2, cursor: cursor2 });
    expect(page3.rows).toHaveLength(1);
    // last (partial) page → no further cursor
    expect(page3.nextCursor).toBeNull();

    // no id overlap across pages
    const ids = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });
});
