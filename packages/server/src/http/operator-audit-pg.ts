/**
 * operator-audit-pg.ts — Postgres port of OperatorAudit (Wave B).
 *
 * Same append-only `operator_audit` table, same PUBLIC interface as the SQLite
 * OperatorAudit (operator-audit.ts): record() stays void + best-effort (an audit
 * write must NEVER throw or block the operator mutation), and listByOperator()
 * returns the identical shape. The only surface addition is recordAsync(), an
 * awaitable internal write so tests can deterministically observe the insert.
 *
 * The table already exists (bootstrapCasinoSchema):
 *   operator_audit(id bigserial pk, operator_id text, action text, target text,
 *                  payload_json text, at bigint)
 *
 * Never log secrets in the payload — see operator-audit.ts.
 */

import type { Pool } from 'pg';

// Re-export the public types so call sites can import them from either module.
export type { OperatorAuditEntry } from './operator-audit.js';

import type { OperatorAuditEntry } from './operator-audit.js';

// ---------------------------------------------------------------------------
// Row shape (pg returns bigserial/bigint as strings — coerce with Number()).
// ---------------------------------------------------------------------------

interface OperatorAuditRow {
  id: string | number;
  operator_id: string;
  action: string;
  target: string;
  payload_json: string | null;
  at: string | number;
}

// ---------------------------------------------------------------------------
// PgOperatorAudit
// ---------------------------------------------------------------------------

export class PgOperatorAudit {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // -------------------------------------------------------------------------
  // record — void, fire-and-forget, never throws.
  // -------------------------------------------------------------------------

  /**
   * Insert an audit row. Best-effort: fires the INSERT without awaiting and
   * swallows/logs any failure so the audit trail can never block or fail the
   * operator mutation. Existing (synchronous) call sites keep the void contract.
   */
  record(e: OperatorAuditEntry): void {
    void this.recordAsync(e);
  }

  /**
   * Awaitable variant of record() for tests. Serialises the payload defensively
   * (a serialise failure records a null payload rather than throwing) and never
   * rejects — the INSERT's own failure is logged, matching record()'s guarantee.
   */
  async recordAsync(e: OperatorAuditEntry): Promise<void> {
    try {
      let payloadJson: string | null = null;
      if (e.payload !== undefined) {
        try {
          payloadJson = JSON.stringify(e.payload);
        } catch (serErr) {
          console.error('[PgOperatorAudit] payload serialise failed — recording null payload:', serErr);
        }
      }

      const at = Math.floor(Date.now() / 1000);
      await this.pool.query(
        `INSERT INTO operator_audit (operator_id, action, target, payload_json, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [e.operatorId, e.action, e.target, payloadJson, at],
      );
    } catch (err) {
      console.error('[PgOperatorAudit] recordAsync() failed — audit write error (non-fatal):', err);
    }
  }

  // -------------------------------------------------------------------------
  // listByOperator (minimal read; scoped to operator_id, newest-first)
  // -------------------------------------------------------------------------

  /**
   * Return this operator's audit rows newest-first. Default limit 100.
   * Scoped to operator_id — cross-tenant rows are never returned.
   */
  async listByOperator(
    operatorId: string,
    opts?: { limit?: number },
  ): Promise<Array<OperatorAuditEntry & { id: number; at: number }>> {
    const limit = opts?.limit ?? 100;
    const { rows } = await this.pool.query<OperatorAuditRow>(
      `SELECT * FROM operator_audit WHERE operator_id = $1 ORDER BY id DESC LIMIT $2`,
      [operatorId, limit],
    );
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
      id: Number(row.id),
      operatorId: row.operator_id,
      action: row.action,
      target: row.target,
      payload,
      at: Number(row.at),
    };
  }
}
