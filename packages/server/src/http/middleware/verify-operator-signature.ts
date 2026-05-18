// TODO(Phase 3/6): mount on /launch (Phase 3) and /op/* (Phase 6).
//   (1) index.ts must add express.json({ verify: (req,_res,buf)=>{ (req as any).rawBody = buf } })
//       so the raw body bytes are available for the signing string; without it,
//       any request WITH a body fails closed (401), never silently accepted.
//   (2) If mounted on a sub-Router (not the root app), req.path is router-relative
//       and will NOT match the operator-signed full path. Pass
//       getSignedPath: (req) => req.originalUrl.split('?')[0] at wiring time.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verify, NonceCache } from '@crash/wallet';
import type { OperatorRegistry, Operator } from '@crash/wallet';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Augmented request after successful verification. */
export interface OperatorAuthedRequest extends Request {
  operator: Operator;
}

export interface VerifyOperatorSignatureOptions {
  /** Max allowed |now - X-Timestamp| in seconds. Default 300 (spec §4.2 rule 1). */
  maxSkewSeconds?: number;
  /** Injectable clock (unix seconds) for tests. Default () => Math.floor(Date.now()/1000). */
  nowSeconds?: () => number;
  /** Shared nonce cache. Default: a new NonceCache() (10-min TTL). Inject for tests/sharing. */
  nonceCache?: NonceCache;
  /**
   * How to obtain the raw request body bytes for the signing string.
   * Default reads (req as any).rawBody (a Buffer) — set by an express.json({verify}) hook.
   * If absent, treats the body as empty Buffer (correct for genuine no-body GETs).
   */
  getRawBody?: (req: Request) => Buffer;
  /**
   * Extracts the exact path string the operator signed (spec §4.2 signing
   * string uses PATH, query excluded). Default: req.path.
   * IMPORTANT: when this middleware is mounted on a sub-Router, req.path is
   * router-relative and will NOT equal the full external path the operator
   * signed. In that case the wiring code MUST pass
   * getSignedPath: (req) => req.originalUrl.split('?')[0]
   * (or otherwise reconstruct the full external path, query stripped).
   */
  getSignedPath?: (req: Request) => string;
}

// ---------------------------------------------------------------------------
// Default raw-body extractor
// ---------------------------------------------------------------------------

function defaultGetRawBody(req: Request): Buffer {
  const raw = (req as unknown as Record<string, unknown>)['rawBody'];
  return raw instanceof Buffer ? raw : Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

function sendError(
  res: Response,
  httpStatus: number,
  code: string,
  message: string,
): void {
  res.status(httpStatus).json({ error: { code, message } });
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Express middleware factory. Verifies the operator HMAC per spec §4.2.
 * On success: attaches `req.operator` and calls next().
 * On any failure: responds 401/403 with the spec §7 error envelope and does NOT call next().
 *
 * NOTE: not yet mounted on a live route. Phase 3 mounts it on /launch,
 * Phase 6 mounts it on /op/*. (TODO seam.)
 */
export function verifyOperatorSignature(
  registry: OperatorRegistry,
  opts?: VerifyOperatorSignatureOptions,
): RequestHandler {
  const maxSkewSeconds = opts?.maxSkewSeconds ?? 300;
  const nowSeconds = opts?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const nonceCache = opts?.nonceCache ?? new NonceCache();
  const getRawBody = opts?.getRawBody ?? defaultGetRawBody;
  const getSignedPath = opts?.getSignedPath ?? ((req: Request) => req.path);

  return function verifyOperatorSignatureMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    try {
      // Step 1: Check all required headers are present and non-empty.
      const apiKey = req.headers['x-api-key'];
      const timestampRaw = req.headers['x-timestamp'];
      const nonce = req.headers['x-nonce'];
      const signature = req.headers['x-signature'];

      if (
        !apiKey || typeof apiKey !== 'string' || apiKey === '' ||
        !timestampRaw || typeof timestampRaw !== 'string' || timestampRaw === '' ||
        !nonce || typeof nonce !== 'string' || nonce === '' ||
        !signature || typeof signature !== 'string' || signature === ''
      ) {
        sendError(res, 401, 'INVALID_REQUEST', 'missing signing headers');
        return;
      }

      // Step 2: Lookup operator by API key.
      const operator = registry.getByApiKey(apiKey);
      if (operator === null) {
        sendError(res, 401, 'INVALID_SIGNATURE', 'unknown api key');
        return;
      }

      // Step 3: Check operator status.
      if (operator.status === 'paused') {
        sendError(res, 403, 'OPERATOR_PAUSED', 'operator is paused');
        return;
      }

      // Step 4: Validate timestamp and skew.
      // Canonical unsigned-integer seconds only (reject "1.5", "+1", "01").
      const ts = /^\d+$/.test(timestampRaw) ? Number(timestampRaw) : NaN;
      if (!Number.isInteger(ts) || Math.abs(nowSeconds() - ts) > maxSkewSeconds) {
        sendError(res, 401, 'STALE_REQUEST', 'request timestamp is outside the allowed skew window');
        return;
      }

      // Step 5: Extract raw body bytes.
      const rawBody = getRawBody(req);

      // Step 6: Verify HMAC signature (constant-time).
      const signatureOk = verify(
        {
          method: req.method,
          path: getSignedPath(req),
          timestamp: ts,
          nonce,
          body: rawBody,
          signature,
        },
        operator.signingKey,
      );

      if (!signatureOk) {
        sendError(res, 401, 'INVALID_SIGNATURE', 'HMAC signature mismatch');
        return;
      }

      // Step 7: Nonce replay check — AFTER signature verify so bad-sig requests
      // cannot poison the nonce cache for a real operator.
      if (!nonceCache.recordIfFresh(operator.operatorId, nonce)) {
        sendError(res, 401, 'NONCE_REUSED', 'nonce has already been used');
        return;
      }

      // Step 8: Success — attach operator to request and proceed.
      (req as OperatorAuthedRequest).operator = operator;
      next();
      return;
    } catch (err) {
      // Unexpected errors (should not happen in normal flow) → 500.
      if (res.headersSent) {
        console.error('[verify-operator-signature] error after response already sent:', err);
        return;
      }
      console.error('[verify-operator-signature] unexpected error:', err);
      sendError(res, 500, 'INTERNAL', 'internal server error');
    }
  };
}
