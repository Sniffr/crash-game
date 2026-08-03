/**
 * JWT admin authentication middleware — Task 5.2.
 *
 * Provides:
 *   - requireAdminJwt(opts)  — verifies HS256 Bearer token, checks jti revocation.
 *   - requireRole(...roles)  — role guard (any-of: pass if admin has ≥1 listed role;
 *                              `admin` role is always-pass per spec §1.3 "Everything").
 *   - signAdminJwt(claims, opts) — sign helper shared with the login route.
 *
 * JWT_SECRET is read at request time (not module load) so tests can set it per-case.
 * If JWT_SECRET is unset/empty → 503 ADMIN_DISABLED (fail-closed).
 */

import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { AdminRole } from '../../admin/admin-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JwtClaims {
  sub: string;
  roles: AdminRole[];
  iat: number;
  exp: number;
  jti: string;
}

// Augment Request via declaration merging
declare module 'express-serve-static-core' {
  interface Request {
    admin?: { username: string; roles: AdminRole[] };
    adminJti?: string;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSecretKey(): Uint8Array | null {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret === '') return null;
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// requireAdminJwt
// ---------------------------------------------------------------------------

/**
 * Express middleware that verifies a HS256 Bearer JWT.
 *
 * - Reads JWT_SECRET at request time (fail-closed 503 when unset).
 * - Checks Authorization: Bearer <jwt> header (string only; missing/array → 401).
 * - Verifies signature + expiry via jose jwtVerify.
 * - Checks jti against the in-memory revocation set (populated by logout).
 * - On success: attaches req.admin = { username, roles }, calls next().
 * - Never throws to Express — any unexpected error → 500 INTERNAL.
 */
export function requireAdminJwt(opts: {
  revoked: Set<string>;
  nowSeconds?: () => number;
}): RequestHandler {
  return async function requireAdminJwtMiddleware(req, res, next): Promise<void> {
    try {
      // Fail-closed: JWT_SECRET must be set.
      const secretKey = getSecretKey();
      if (!secretKey) {
        res.status(503).json({ error: { code: 'ADMIN_DISABLED', message: 'Admin API not configured' } });
        return;
      }

      // Extract Bearer token from Authorization header.
      const authHeader = req.headers['authorization'];
      if (!authHeader || typeof authHeader !== 'string') {
        res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Authorization: Bearer <jwt> required' } });
        return;
      }
      if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Authorization: Bearer <jwt> required' } });
        return;
      }
      const token = authHeader.slice(7).trim();
      if (!token) {
        res.status(401).json({ error: { code: 'INVALID_JWT', message: 'JWT token missing' } });
        return;
      }

      // Verify signature + expiry.
      let payload: JwtClaims;
      try {
        const result = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
        payload = result.payload as unknown as JwtClaims;
      } catch {
        res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Token invalid or expired' } });
        return;
      }

      // Validate claims shape.
      if (typeof payload.sub !== 'string' || !Array.isArray(payload.roles) || typeof payload.jti !== 'string') {
        res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Token claims malformed' } });
        return;
      }

      // Check revocation set.
      if (opts.revoked.has(payload.jti)) {
        res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Token has been revoked' } });
        return;
      }

      // Attach admin identity to request.
      req.admin = {
        username: payload.sub,
        roles: payload.roles,
      };
      // Stash jti for logout to add to the revocation set.
      req.adminJti = payload.jti;

      next();
    } catch (err) {
      console.error('[admin-auth] requireAdminJwt unexpected error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

/**
 * Role guard — use AFTER requireAdminJwt.
 *
 * Caller passes the SET of roles that may access the endpoint.
 * Passes if req.admin.roles intersects the allowed set (any-of).
 *
 * IMPORTANT: `admin` is always-pass regardless of the endpoint's specific role
 * list — spec §1.3 says `admin` = "Everything". This is implemented by checking
 * if req.admin.roles includes 'admin' first, then falling back to the any-of check.
 */
export function requireRole(...allowed: AdminRole[]): RequestHandler {
  return function requireRoleMiddleware(req, res, next): void {
    const admin = req.admin;
    if (!admin) {
      // Should not reach here without requireAdminJwt first, but guard defensively.
      res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Not authenticated' } });
      return;
    }
    // admin role is superuser — always passes (spec §1.3: admin = Everything)
    if (admin.roles.includes('admin')) {
      next();
      return;
    }
    // Any-of: pass if the user has at least one of the allowed roles
    const hasRole = allowed.some((r) => admin.roles.includes(r));
    if (!hasRole) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: `Required role: ${allowed.join(' or ')}` } });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// signAdminJwt
// ---------------------------------------------------------------------------

/**
 * Sign an HS256 JWT for an admin user.
 * Used by the login route to issue tokens.
 * Reads JWT_SECRET at call time — caller should have already checked it is set.
 *
 * @throws Error if JWT_SECRET is unset (caller must guard).
 */
export async function signAdminJwt(
  claims: { sub: string; roles: AdminRole[] },
  opts: { ttlSeconds: number; nowSeconds?: () => number },
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const secretKey = getSecretKey();
  if (!secretKey) throw new Error('JWT_SECRET not set');

  const now = opts.nowSeconds ? opts.nowSeconds() : Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const exp = now + opts.ttlSeconds;

  const token = await new SignJWT({ roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey);

  return { token, jti, expiresAt: exp };
}
