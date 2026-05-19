import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Derive Statement type without importing the namespace type (mirrors bet-log.ts)
// ---------------------------------------------------------------------------

type SqliteStatement<P extends unknown[] = unknown[]> = ReturnType<Database['prepare']> & {
  run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  get(...params: P): unknown;
  all(...params: P): unknown[];
};

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

    return rows.map((row) => {
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
    });
  }
}
