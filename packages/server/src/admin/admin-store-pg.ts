import type { Pool } from '@crash/wallet';
import type { Cursor } from '@crash/wallet';
import { encodeCursor } from '@crash/wallet';

import type { AdminRole, AdminUser, AuditEntry } from './admin-store.js';
import { AdminNotFoundError, DuplicateAdminError } from './admin-store.js';

// Re-export the shared public surface so callers can import everything about the
// admin store — types, enums, errors, and the Postgres repos — from one place.
export {
  ADMIN_ROLES,
  AdminNotFoundError,
  DuplicateAdminError,
  isAdminRole,
} from './admin-store.js';
export type { AdminRole, AdminUser, AuditEntry } from './admin-store.js';

// ---------------------------------------------------------------------------
// Postgres port of AdminAudit + AdminUsers (Wave B).
//
// Mirrors the SQLite store's PUBLIC interface exactly (same method names, args,
// return shapes, and error classes). The `admins` and `admin_audit` tables are
// created by bootstrapCasinoSchema — this module never issues DDL.
//
// bigint / bigserial columns (id, at, created_at, last_login_at) come back from
// pg as strings; every crossing into JS is coerced with Number().
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  payload_json: string | null;
  at: string;
}

interface AdminUserRow {
  username: string;
  password_hash: string;
  roles_json: string;
  created_at: string;
  last_login_at: string | null;
}

// ---------------------------------------------------------------------------
// PgAdminAudit
// ---------------------------------------------------------------------------

/**
 * Owns the admin_audit table on Postgres. Writes an immutable audit row for
 * every admin operation.
 */
export class PgAdminAudit {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Insert an audit row. Best-effort fire-and-forget: returns `void` and never
   * throws — the audit trail must never block (or fail) the admin operation.
   * Matches the SQLite version's contract so the ~20 existing call sites are
   * unchanged. The INSERT is dispatched via `recordAsync` and its rejection is
   * swallowed (logged only).
   */
  record(e: AuditEntry): void {
    void this.recordAsync(e);
  }

  /**
   * Test-support: the same insert as `record()`, but awaitable. Resolves once
   * the row is durably written; still swallows-and-logs errors so it never
   * throws (preserving record()'s never-throw contract). Tests await this to
   * avoid racing the fire-and-forget write in `record()`.
   */
  async recordAsync(e: AuditEntry): Promise<void> {
    let payloadJson: string | null = null;
    if (e.payload !== undefined) {
      try {
        payloadJson = JSON.stringify(e.payload);
      } catch (serErr) {
        console.error('[PgAdminAudit] payload serialise failed — recording null payload:', serErr);
      }
    }

    const at = Math.floor(Date.now() / 1000);
    try {
      await this.pool.query(
        `INSERT INTO admin_audit (actor, action, target, payload_json, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [e.actor, e.action, e.target, payloadJson, at],
      );
    } catch (err) {
      console.error('[PgAdminAudit] record() failed — audit write error (non-fatal):', err);
    }
  }

  /** Return audit rows newest-first (ORDER BY id DESC). Default limit 100. */
  async list(opts?: { limit?: number }): Promise<Array<AuditEntry & { id: number; at: number }>> {
    const limit = opts?.limit ?? 100;
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT * FROM admin_audit ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => this._rowToEntry(r));
  }

  /**
   * Filtered + cursor-paginated list of audit rows.
   * Keyset: ORDER BY at DESC, id DESC.
   * nextCursor is null when fewer than `limit` rows are returned.
   */
  async listFiltered(
    f: { actor?: string; action?: string; target?: string; from?: number; to?: number },
    page: { limit: number; cursor?: Cursor },
  ): Promise<{ rows: Array<AuditEntry & { id: number; at: number }>; nextCursor: string | null }> {
    const conds: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    // Keyset cursor on (at DESC, id DESC)
    if (page.cursor) {
      const ts = add(page.cursor.ts);
      const ts2 = add(page.cursor.ts);
      const id = add(Number(page.cursor.id));
      conds.push(`(at < ${ts} OR (at = ${ts2} AND id < ${id}))`);
    }
    if (f.actor !== undefined) conds.push(`actor = ${add(f.actor)}`);
    if (f.action !== undefined) conds.push(`action = ${add(f.action)}`);
    if (f.target !== undefined) conds.push(`target = ${add(f.target)}`);
    if (f.from !== undefined) conds.push(`at >= ${add(f.from)}`);
    if (f.to !== undefined) conds.push(`at <= ${add(f.to)}`);

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limitParam = add(page.limit);
    const sql = `SELECT * FROM admin_audit ${where} ORDER BY at DESC, id DESC LIMIT ${limitParam}`;

    const { rows } = await this.pool.query<AuditRow>(sql, params);
    const entries = rows.map((r) => this._rowToEntry(r));

    let nextCursor: string | null = null;
    if (entries.length === page.limit) {
      const last = entries[entries.length - 1]!;
      nextCursor = encodeCursor({ ts: last.at, id: String(last.id) });
    }

    return { rows: entries, nextCursor };
  }

  private _rowToEntry(row: AuditRow): AuditEntry & { id: number; at: number } {
    let payload: unknown = undefined;
    if (row.payload_json !== null) {
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        payload = row.payload_json; // return raw string if unparseable
      }
    }
    return {
      id: Number(row.id),
      actor: row.actor,
      action: row.action,
      target: row.target,
      payload,
      at: Number(row.at),
    };
  }
}

// ---------------------------------------------------------------------------
// PgAdminUsers — owns the `admins` table
// ---------------------------------------------------------------------------

/**
 * Manages admin user accounts on Postgres.
 * Passwords are stored as already-computed hashes (never hashed here, never
 * plaintext). getByUsername returns the hash separately ONLY for login compare.
 */
export class PgAdminUsers {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private _rowToUser(row: AdminUserRow): AdminUser {
    return {
      username: row.username,
      roles: JSON.parse(row.roles_json) as AdminRole[],
      createdAt: Number(row.created_at),
      lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
    };
  }

  /** Create a new admin. Throws DuplicateAdminError if username already exists. */
  async create(username: string, passwordHash: string, roles: AdminRole[]): Promise<AdminUser> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await this.pool.query(
        `INSERT INTO admins (username, password_hash, roles_json, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, NULL)`,
        [username, passwordHash, JSON.stringify(roles), now],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate key') || msg.includes('admins_pkey')) {
        throw new DuplicateAdminError(username);
      }
      throw err;
    }
    return this._rowToUser({
      username,
      password_hash: passwordHash,
      roles_json: JSON.stringify(roles),
      created_at: String(now),
      last_login_at: null,
    });
  }

  /** Look up by username. Returns { user, passwordHash } or null if not found.
   *  The hash is returned separately so the caller can compare without the hash
   *  ever appearing in the public AdminUser shape. */
  async getByUsername(username: string): Promise<{ user: AdminUser; passwordHash: string } | null> {
    const { rows } = await this.pool.query<AdminUserRow>(
      `SELECT * FROM admins WHERE username = $1`,
      [username],
    );
    const row = rows[0];
    if (!row) return null;
    return { user: this._rowToUser(row), passwordHash: row.password_hash };
  }

  /** List admin users, newest-first by created_at. Default limit 100. */
  async list(opts?: { limit?: number }): Promise<AdminUser[]> {
    const limit = opts?.limit ?? 100;
    const { rows } = await this.pool.query<AdminUserRow>(
      `SELECT * FROM admins ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => this._rowToUser(r));
  }

  /** Update password hash and/or roles. Throws AdminNotFoundError if not found. */
  async update(
    username: string,
    patch: { passwordHash?: string; roles?: AdminRole[] },
  ): Promise<AdminUser> {
    const set: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      set.push(`${col} = $${vals.length}`);
    };

    if (patch.passwordHash !== undefined) add('password_hash', patch.passwordHash);
    if (patch.roles !== undefined) add('roles_json', JSON.stringify(patch.roles));

    if (set.length === 0) {
      // Nothing to update — fetch and return current (or 404).
      const existing = await this.getByUsername(username);
      if (!existing) throw new AdminNotFoundError(username);
      return existing.user;
    }

    vals.push(username);
    const { rowCount } = await this.pool.query(
      `UPDATE admins SET ${set.join(', ')} WHERE username = $${vals.length}`,
      vals,
    );
    if (!rowCount) throw new AdminNotFoundError(username);

    return (await this.getByUsername(username))!.user;
  }

  /** Delete an admin. Throws AdminNotFoundError if not found. */
  async delete(username: string): Promise<void> {
    const { rowCount } = await this.pool.query(`DELETE FROM admins WHERE username = $1`, [username]);
    if (!rowCount) throw new AdminNotFoundError(username);
  }

  /** Record a successful login (update last_login_at). */
  async recordLogin(username: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.pool.query(`UPDATE admins SET last_login_at = $1 WHERE username = $2`, [now, username]);
  }

  /** Return total count of admin users (for bootstrap idempotency check). */
  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM admins`);
    return Number(rows[0]!.cnt);
  }
}
