import type { Database } from 'better-sqlite3';
import type { Cursor } from '@crash/wallet';
import { encodeCursor } from '@crash/wallet';

// ---------------------------------------------------------------------------
// Derive Statement type without importing the namespace type (mirrors bet-log.ts)
// ---------------------------------------------------------------------------

type SqliteStatement<P extends unknown[] = unknown[]> = ReturnType<Database['prepare']> & {
  run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  get(...params: P): unknown;
  all(...params: P): unknown[];
};

// ---------------------------------------------------------------------------
// AdminUsers public types
// ---------------------------------------------------------------------------

export type AdminRole = 'admin' | 'finance' | 'support' | 'viewer';

export const ADMIN_ROLES = ['admin', 'finance', 'support', 'viewer'] as const;

export function isAdminRole(s: string): s is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(s);
}

export interface AdminUser {
  username: string;
  roles: AdminRole[];
  createdAt: number;
  lastLoginAt: number | null;
}

interface AdminUserRow {
  username: string;
  password_hash: string;
  roles_json: string;
  created_at: number;
  last_login_at: number | null;
}

export class DuplicateAdminError extends Error {
  constructor(username: string) {
    super(`Admin '${username}' already exists`);
    this.name = 'DuplicateAdminError';
  }
}

export class AdminNotFoundError extends Error {
  constructor(username: string) {
    super(`Admin '${username}' not found`);
    this.name = 'AdminNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  payload?: unknown;
}

interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  payload_json: string | null;
  at: number;
}

// ---------------------------------------------------------------------------
// AdminAudit
// ---------------------------------------------------------------------------

/**
 * Owns the admin_audit table in the shared SQLite database.
 * Writes an immutable audit row for every admin operation.
 * Phase 5.2 will add an `admins` table elsewhere — that is out of scope here.
 */
export class AdminAudit {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this._ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        actor        TEXT NOT NULL,
        action       TEXT NOT NULL,
        target       TEXT NOT NULL,
        payload_json TEXT,
        at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit(at, id);
    `);
  }

  // -------------------------------------------------------------------------
  // Prepared-statement helpers (lazy, created once per instance)
  // -------------------------------------------------------------------------

  private _stmts = {} as Record<string, SqliteStatement>;

  private stmt<P extends unknown[] = unknown[]>(key: string, sql: string): SqliteStatement<P> {
    if (!this._stmts[key]) {
      this._stmts[key] = this.db.prepare(sql) as SqliteStatement;
    }
    return this._stmts[key] as SqliteStatement<P>;
  }

  // -------------------------------------------------------------------------
  // record
  // -------------------------------------------------------------------------

  /**
   * Insert an audit row. Best-effort: logs but does NOT throw on serialise or
   * persistence failure — the audit trail must never block the admin operation.
   */
  record(e: AuditEntry): void {
    try {
      let payloadJson: string | null = null;
      if (e.payload !== undefined) {
        try {
          payloadJson = JSON.stringify(e.payload);
        } catch (serErr) {
          console.error('[AdminAudit] payload serialise failed — recording null payload:', serErr);
        }
      }

      const at = Math.floor(Date.now() / 1000);
      this.stmt(
        'insert_audit',
        `INSERT INTO admin_audit (actor, action, target, payload_json, at)
         VALUES (@actor, @action, @target, @payload_json, @at)`,
      ).run({
        actor: e.actor,
        action: e.action,
        target: e.target,
        payload_json: payloadJson,
        at,
      });
    } catch (err) {
      console.error('[AdminAudit] record() failed — audit write error (non-fatal):', err);
    }
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * Return audit rows newest-first. Default limit 100.
   */
  list(opts?: { limit?: number }): Array<AuditEntry & { id: number; at: number }> {
    const limit = opts?.limit ?? 100;
    const rows = this.stmt(
      'list_audit',
      `SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?`,
    ).all(limit) as AuditRow[];

    return rows.map((row) => this._rowToEntry(row));
  }

  /**
   * Filtered + cursor-paginated list of audit rows (§12.1).
   * Keyset: ORDER BY at DESC, id DESC.
   * nextCursor is null when fewer than `limit` rows are returned.
   */
  listFiltered(
    f: { actor?: string; action?: string; target?: string; from?: number; to?: number },
    page: { limit: number; cursor?: Cursor },
  ): { rows: Array<AuditEntry & { id: number; at: number }>; nextCursor: string | null } {
    const conds: string[] = [];
    const params: unknown[] = [];

    // Keyset cursor on (at DESC, id DESC)
    if (page.cursor) {
      conds.push('(at < ? OR (at = ? AND id < ?))');
      params.push(page.cursor.ts, page.cursor.ts, Number(page.cursor.id));
    }
    if (f.actor !== undefined) {
      conds.push('actor = ?');
      params.push(f.actor);
    }
    if (f.action !== undefined) {
      conds.push('action = ?');
      params.push(f.action);
    }
    if (f.target !== undefined) {
      conds.push('target = ?');
      params.push(f.target);
    }
    if (f.from !== undefined) {
      conds.push('at >= ?');
      params.push(f.from);
    }
    if (f.to !== undefined) {
      conds.push('at <= ?');
      params.push(f.to);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    // Dynamic SQL — cannot use the prepared-statement cache for dynamic WHERE clauses
    const sql = `SELECT * FROM admin_audit ${where} ORDER BY at DESC, id DESC LIMIT ?`;
    params.push(page.limit);

    const rows = this.db.prepare(sql).all(...params) as AuditRow[];
    const entries = rows.map((row) => this._rowToEntry(row));

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
      id: row.id,
      actor: row.actor,
      action: row.action,
      target: row.target,
      payload,
      at: row.at,
    };
  }
}

// ---------------------------------------------------------------------------
// AdminUsers — owns the `admins` table
// ---------------------------------------------------------------------------

/**
 * Manages admin user accounts.
 * Passwords are stored as bcryptjs hashes (cost 10) — never plaintext.
 * getByUsername returns the hash separately ONLY for login comparison.
 */
export class AdminUsers {
  private readonly db: Database;
  private _stmts = {} as Record<string, SqliteStatement>;

  constructor(db: Database) {
    this.db = db;
    this._ensureSchema();
  }

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        username      TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        roles_json    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );
    `);
  }

  private stmt<P extends unknown[] = unknown[]>(key: string, sql: string): SqliteStatement<P> {
    if (!this._stmts[key]) {
      this._stmts[key] = this.db.prepare(sql) as SqliteStatement;
    }
    return this._stmts[key] as SqliteStatement<P>;
  }

  private _rowToUser(row: AdminUserRow): AdminUser {
    return {
      username: row.username,
      roles: JSON.parse(row.roles_json) as AdminRole[],
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at ?? null,
    };
  }

  /** Create a new admin. Throws DuplicateAdminError if username already exists. */
  create(username: string, passwordHash: string, roles: AdminRole[]): AdminUser {
    const now = Math.floor(Date.now() / 1000);
    try {
      this.stmt(
        'insert_admin',
        `INSERT INTO admins (username, password_hash, roles_json, created_at, last_login_at)
         VALUES (@username, @password_hash, @roles_json, @created_at, NULL)`,
      ).run({
        username,
        password_hash: passwordHash,
        roles_json: JSON.stringify(roles),
        created_at: now,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed')) {
        throw new DuplicateAdminError(username);
      }
      throw err;
    }
    return this._rowToUser({
      username,
      password_hash: passwordHash,
      roles_json: JSON.stringify(roles),
      created_at: now,
      last_login_at: null,
    });
  }

  /** Look up by username. Returns { user, passwordHash } or null if not found.
   *  The hash is returned separately so the caller can bcrypt-compare without
   *  the hash ever appearing in the public AdminUser shape. */
  getByUsername(username: string): { user: AdminUser; passwordHash: string } | null {
    const row = this.stmt(
      'get_admin',
      `SELECT * FROM admins WHERE username = ?`,
    ).get(username) as AdminUserRow | undefined;
    if (!row) return null;
    return { user: this._rowToUser(row), passwordHash: row.password_hash };
  }

  /** List admin users, newest-first by created_at. Default limit 100. */
  list(opts?: { limit?: number }): AdminUser[] {
    const limit = opts?.limit ?? 100;
    const rows = this.stmt(
      'list_admins',
      `SELECT * FROM admins ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as AdminUserRow[];
    return rows.map((r) => this._rowToUser(r));
  }

  /** Update password hash and/or roles. Throws AdminNotFoundError if not found. */
  update(username: string, patch: { passwordHash?: string; roles?: AdminRole[] }): AdminUser {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { username };

    if (patch.passwordHash !== undefined) {
      setClauses.push('password_hash = @password_hash');
      params['password_hash'] = patch.passwordHash;
    }
    if (patch.roles !== undefined) {
      setClauses.push('roles_json = @roles_json');
      params['roles_json'] = JSON.stringify(patch.roles);
    }
    if (setClauses.length === 0) {
      // Nothing to update — fetch and return current
      const existing = this.getByUsername(username);
      if (!existing) throw new AdminNotFoundError(username);
      return existing.user;
    }

    const sql = `UPDATE admins SET ${setClauses.join(', ')} WHERE username = @username`;
    const info = this.db.prepare(sql).run(params);
    if (info.changes === 0) throw new AdminNotFoundError(username);

    return this.getByUsername(username)!.user;
  }

  /** Delete an admin. Throws AdminNotFoundError if not found. */
  delete(username: string): void {
    const info = this.stmt(
      'delete_admin',
      `DELETE FROM admins WHERE username = ?`,
    ).run(username);
    if ((info as { changes: number }).changes === 0) throw new AdminNotFoundError(username);
  }

  /** Record a successful login (update last_login_at). */
  recordLogin(username: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.stmt(
      'record_login',
      `UPDATE admins SET last_login_at = ? WHERE username = ?`,
    ).run(now, username);
  }

  /** Return total count of admin users (for bootstrap idempotency check). */
  count(): number {
    const row = this.stmt<[]>(
      'count_admins',
      `SELECT COUNT(*) as cnt FROM admins`,
    ).get() as { cnt: number };
    return row.cnt;
  }
}
