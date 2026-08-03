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
export interface OperatorAuditEntry {
  operatorId: string;
  action: string;
  target: string;
  payload?: unknown;
}
