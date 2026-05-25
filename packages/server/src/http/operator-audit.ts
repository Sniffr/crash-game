/**
 * operator-audit.ts — Owns the `operator_audit` table in the shared SQLite DB.
 *
 * Every MUTATION on the operator-backoffice surface (§6.3 player.lock,
 * §6.4 player.unlock, §7.1 session.terminate, §9.2 limits.update) is recorded
 * here. READS are NOT audited (see operator-backoffice-v1.md §2.6).
 *
 * Mirrors the structure/style of AdminAudit (admin/admin-store.ts): the table is
 * append-only, record() is best-effort (NEVER throws — an audit-write failure
 * must not block or fail the mutation), and payloads are serialised defensively.
 *
 * Never log secrets in the payload (no signingKey / apiKey / tokens). The
 * callers in operator.ts only pass {reason, message, minBetMinor, maxBetMinor},
 * none of which are secrets.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Derive Statement type without importing the namespace type (mirrors AdminAudit)
// ---------------------------------------------------------------------------

type SqliteStatement<P extends unknown[] = unknown[]> = ReturnType<Database['prepare']> & {
  run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  get(...params: P): unknown;
  all(...params: P): unknown[];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OperatorAuditEntry {
  operatorId: string;
  action: string;
  target: string;
  payload?: unknown;
}

interface OperatorAuditRow {
  id: number;
  operator_id: string;
  action: string;
  target: string;
  payload_json: string | null;
  at: number;
}

// ---------------------------------------------------------------------------
// OperatorAudit
// ---------------------------------------------------------------------------

export class OperatorAudit {
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
      CREATE TABLE IF NOT EXISTS operator_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id TEXT NOT NULL,
        action      TEXT NOT NULL,
        target      TEXT NOT NULL,
        payload_json TEXT,
        at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_op_audit_operator_at ON operator_audit(operator_id, at);
      CREATE INDEX IF NOT EXISTS idx_op_audit_at ON operator_audit(at, id);
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
   * persistence failure — the audit trail must never block the operator mutation.
   */
  record(e: OperatorAuditEntry): void {
    try {
      let payloadJson: string | null = null;
      if (e.payload !== undefined) {
        try {
          payloadJson = JSON.stringify(e.payload);
        } catch (serErr) {
          console.error('[OperatorAudit] payload serialise failed — recording null payload:', serErr);
        }
      }

      const at = Math.floor(Date.now() / 1000);
      this.stmt(
        'insert_audit',
        `INSERT INTO operator_audit (operator_id, action, target, payload_json, at)
         VALUES (@operator_id, @action, @target, @payload_json, @at)`,
      ).run({
        operator_id: e.operatorId,
        action: e.action,
        target: e.target,
        payload_json: payloadJson,
        at,
      });
    } catch (err) {
      console.error('[OperatorAudit] record() failed — audit write error (non-fatal):', err);
    }
  }

  // -------------------------------------------------------------------------
  // listByOperator (minimal read for tests)
  // -------------------------------------------------------------------------

  /**
   * Return this operator's audit rows newest-first. Default limit 100.
   * Scoped to operator_id — cross-tenant rows are never returned.
   */
  listByOperator(
    operatorId: string,
    opts?: { limit?: number },
  ): Array<OperatorAuditEntry & { id: number; at: number }> {
    const limit = opts?.limit ?? 100;
    const rows = this.stmt(
      'list_by_operator',
      `SELECT * FROM operator_audit WHERE operator_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(operatorId, limit) as OperatorAuditRow[];
    return rows.map((row) => this._rowToEntry(row));
  }

  private _rowToEntry(row: OperatorAuditRow): OperatorAuditEntry & { id: number; at: number } {
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
      operatorId: row.operator_id,
      action: row.action,
      target: row.target,
      payload,
      at: row.at,
    };
  }
}
