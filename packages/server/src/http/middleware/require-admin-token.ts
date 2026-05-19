import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Phase-4 stub admin auth. Gates /admin/* on a shared secret in
 * process.env.ADMIN_API_TOKEN compared in constant time.
 * If ADMIN_API_TOKEN is unset/empty the entire admin surface is DISABLED
 * (503 ADMIN_DISABLED) — an unconfigured deployment must not be force-creditable.
 * Phase 5.2 replaces this with real JWT + roles.
 */
export function requireAdminToken(): RequestHandler {
  return function requireAdminTokenMiddleware(req, res, next): void {
    try {
      // Read env at REQUEST time (not module load) so tests can set per-case.
      const envToken = process.env['ADMIN_API_TOKEN'];

      if (!envToken || envToken === '') {
        // Admin surface fully disabled — fail closed loudly.
        res.status(503).json({
          error: {
            code: 'ADMIN_DISABLED',
            message: 'Admin API not configured',
          },
        });
        return;
      }

      // Read header — reject arrays (header sent multiple times) and missing.
      const headerToken = req.headers['x-admin-token'];
      if (!headerToken || typeof headerToken !== 'string') {
        res.status(401).json({
          error: {
            code: 'INVALID_ADMIN_TOKEN',
            message: 'X-Admin-Token header required',
          },
        });
        return;
      }

      // Constant-time comparison to prevent timing oracle attacks.
      // Length check first: mismatched length → 401 without calling timingSafeEqual
      // (timingSafeEqual requires equal-length Buffers; short-circuit on length mismatch).
      const expected = Buffer.from(envToken, 'utf8');
      const provided = Buffer.from(headerToken, 'utf8');

      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        res.status(401).json({
          error: {
            code: 'INVALID_ADMIN_TOKEN',
            message: 'Admin token mismatch',
          },
        });
        return;
      }

      // Success — set actor for audit trail (Phase 5.2 replaces with JWT subject).
      (req as unknown as Record<string, unknown>)['adminActor'] = 'admin-token';
      next();
    } catch (err) {
      console.error('[require-admin-token] unexpected error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL' } });
      }
    }
  };
}
