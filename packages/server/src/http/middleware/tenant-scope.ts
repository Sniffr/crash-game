/**
 * tenant-scope.ts — Route-level 404-no-leak guard for operator-scoped routes.
 *
 * This is NOT an Express middleware factory — verifyOperatorSignature already
 * provides the auth gate. This is a thin helper that routes call per-row to
 * ensure cross-tenant access is indistinguishable from missing-resource.
 *
 * Design choice:
 *   - verifyOperatorSignature runs once at the router-mount level in index.ts
 *     and sets req.operator on success.
 *   - enforceTenantScope is called per route, per row, to check that the row
 *     belongs to the authenticated operator. It emits BYTE-IDENTICAL 404
 *     responses whether the row is missing or owned by another tenant.
 *
 * Usage (combining null-check + scope-check in one call):
 *
 *     const row = betLog.getById(req.params.betId);
 *     if (!enforceTenantScope(row?.operatorId, req, res, 'BET_NOT_FOUND', 'Bet not found')) return;
 *
 * Or (split null-check from scope-check):
 *
 *     const row = betLog.getById(req.params.betId);
 *     if (!row || !enforceTenantScope(row.operatorId, req, res, 'BET_NOT_FOUND', 'Bet not found')) return;
 *
 * In both forms, if the function returns false the response has already been
 * sent; the caller just needs to `return`.
 */

import type { Request, Response } from 'express';
import type { OperatorAuthedRequest } from './verify-operator-signature.js';

/**
 * Asserts the row's `operatorId` matches the authenticated operator's id.
 *
 * Returns `true` if (and only if):
 *   - req.operator is set (verifyOperatorSignature has run)
 *   - rowOperatorId is non-null/non-undefined
 *   - rowOperatorId === req.operator.operatorId
 *
 * Returns `false` (and has already sent an appropriate response) in all other
 * cases:
 *   - If req.operator is missing (defensive; should never happen if the
 *     middleware chain is wired correctly): sends 401 INVALID_SIGNATURE.
 *   - If rowOperatorId is nullish OR belongs to a different operator: sends
 *     404 with the provided notFoundCode + notFoundMessage. The response is
 *     BYTE-IDENTICAL to the "truly not found" response in the same route —
 *     no existence leak.
 *
 * @param rowOperatorId  The operator_id on the fetched row (or undefined/null if the row wasn't found)
 * @param req            Express Request (must have req.operator from verifyOperatorSignature)
 * @param res            Express Response (used to write the error if returning false)
 * @param notFoundCode   Error code for the 404 body, e.g. 'SESSION_NOT_FOUND'
 * @param notFoundMessage Human-readable 404 message, e.g. 'No such session'
 */
export function enforceTenantScope(
  rowOperatorId: string | undefined | null,
  req: Request,
  res: Response,
  notFoundCode: string,
  notFoundMessage: string,
): boolean {
  const operatorId = (req as OperatorAuthedRequest).operator?.operatorId;

  if (!operatorId) {
    // Defensive — should never reach here without verifyOperatorSignature having run
    // (the middleware chain in index.ts guarantees req.operator is set before the
    // router handles the request). Treated as auth failure, not a 404.
    res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Not authenticated' } });
    return false;
  }

  if (!rowOperatorId || rowOperatorId !== operatorId) {
    // Cross-tenant OR not-found — SAME response, no existence leak.
    // Callers must use the same notFoundCode/notFoundMessage they would use for
    // the "row was null" case so the two branches are byte-identical.
    res.status(404).json({ error: { code: notFoundCode, message: notFoundMessage } });
    return false;
  }

  return true;
}
