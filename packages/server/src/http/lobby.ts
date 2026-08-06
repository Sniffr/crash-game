/**
 * Personal-lobby HTTP router (Wave A).
 *
 * Player-facing endpoints, mounted by the parent at /api/lobby:
 *   - POST /register  — PUBLIC — create account, return player JWT + balance 0
 *   - POST /login     — PUBLIC — verify creds, return player JWT + balance
 *   - GET  /me        — player JWT — identity + balance
 *
 * Player JWT: HS256, payload { sub: playerId, typ: 'player' }, ~24h expiry,
 * signed with process.env.JWT_SECRET via `jose` (same library admin-auth uses).
 * `requirePlayerJwt` verifies the token and REJECTS admin tokens (requires
 * typ==='player'), setting req.player = { playerId }.
 */

import { Router, type RequestHandler } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import * as bcrypt from 'bcryptjs';
import { PlayersRepo, DuplicateUsernameError } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { railFor, SUPPORTED_CURRENCIES } from '@crash/wallet';

// ---------------------------------------------------------------------------
// Request augmentation — mirrors admin-auth.ts's `req.admin` pattern.
// ---------------------------------------------------------------------------

declare module 'express-serve-static-core' {
  interface Request {
    player?: { playerId: string };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLAYER_JWT_TTL_SECONDS = 24 * 60 * 60; // ~24h
const BCRYPT_COST = 10;

// ---------------------------------------------------------------------------
// JWT helpers (jose, HS256) — JWT_SECRET read at call time (fail-closed).
// ---------------------------------------------------------------------------

function getSecretKey(): Uint8Array | null {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret === '') return null;
  return new TextEncoder().encode(secret);
}

interface PlayerClaims {
  sub: string;
  typ: string;
  iat: number;
  exp: number;
}

/** Sign a player JWT. Throws if JWT_SECRET is unset at call time. */
export async function signPlayerJwt(playerId: string): Promise<string> {
  const secretKey = getSecretKey();
  if (!secretKey) throw new Error('JWT_SECRET not set');

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: 'player' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(playerId)
    .setIssuedAt(now)
    .setExpirationTime(now + PLAYER_JWT_TTL_SECONDS)
    .sign(secretKey);
}

/**
 * Express middleware: verify a player Bearer JWT.
 *   - JWT_SECRET unset → 503
 *   - missing/malformed Authorization → 401
 *   - invalid/expired signature → 401
 *   - non-player token (typ !== 'player', e.g. an admin token) → 401
 * On success sets req.player = { playerId } and calls next().
 */
export const requirePlayerJwt: RequestHandler = async (req, res, next): Promise<void> => {
  try {
    const secretKey = getSecretKey();
    if (!secretKey) {
      res.status(503).json({ error: { code: 'LOBBY_DISABLED', message: 'Lobby API not configured' } });
      return;
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Authorization: Bearer <jwt> required' } });
      return;
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      res.status(401).json({ error: { code: 'INVALID_JWT', message: 'JWT token missing' } });
      return;
    }

    let payload: PlayerClaims;
    try {
      const result = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
      payload = result.payload as unknown as PlayerClaims;
    } catch {
      res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Token invalid or expired' } });
      return;
    }

    // Reject non-player tokens (admin tokens carry roles + no typ==='player').
    if (typeof payload.sub !== 'string' || payload.typ !== 'player') {
      res.status(401).json({ error: { code: 'INVALID_JWT', message: 'Not a player token' } });
      return;
    }

    req.player = { playerId: payload.sub };
    next();
  } catch (err) {
    console.error('[lobby] requirePlayerJwt unexpected error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  }
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface LobbyRouterDeps {
  players: PlayersRepo;
  wallet: WalletLedger;
}

export function createLobbyRouter(deps: { players: PlayersRepo; wallet: WalletLedger }): Router {
  const router = Router();

  // Guard: JWT_SECRET must be set to issue tokens. Returns 503 if not.
  function requireSecret(res: import('express').Response): boolean {
    if (!getSecretKey()) {
      res.status(503).json({ error: { code: 'LOBBY_DISABLED', message: 'Lobby API not configured' } });
      return false;
    }
    return true;
  }

  // =========================================================================
  // POST /register — PUBLIC
  // =========================================================================

  router.post('/register', async (req, res): Promise<void> => {
    if (!requireSecret(res)) return;

    const body = (req.body ?? {}) as {
      username?: unknown;
      password?: unknown;
      currency?: unknown;
      phone?: unknown;
      email?: unknown;
    };
    const { username, password, currency, phone, email } = body;

    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'username and password (non-empty strings) required' } });
      return;
    }

    if (typeof currency !== 'string' || !SUPPORTED_CURRENCIES.includes(currency)) {
      res.status(400).json({ error: { code: 'UNSUPPORTED_CURRENCY', message: `currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}` } });
      return;
    }

    const rail = railFor(currency)!;
    const phoneStr = typeof phone === 'string' ? phone.trim() : '';
    const emailStr = typeof email === 'string' ? email.trim() : '';
    if (rail.contact === 'phone' ? !phoneStr : !emailStr) {
      res.status(400).json({
        error: {
          code: 'CONTACT_REQUIRED',
          message: rail.contact === 'phone' ? 'phone is required for this currency' : 'email is required for this currency',
        },
      });
      return;
    }

    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const player = await deps.players.create(username.trim(), passwordHash, {
        currency,
        phone: phoneStr || null,
        email: emailStr || null,
        country: rail.country,
      });
      const token = await signPlayerJwt(player.playerId);
      res.status(201).json({
        token,
        player: { playerId: player.playerId, username: player.username },
        balanceMinor: 0,
      });
    } catch (err) {
      if (err instanceof DuplicateUsernameError) {
        res.status(409).json({ error: { code: 'DUPLICATE_USERNAME', message: 'Username already taken' } });
        return;
      }
      throw err;
    }
  });

  // =========================================================================
  // POST /login — PUBLIC
  // =========================================================================

  router.post('/login', async (req, res): Promise<void> => {
    if (!requireSecret(res)) return;

    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const { username, password } = body;

    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'username and password (non-empty strings) required' } });
      return;
    }

    const found = await deps.players.getByUsernameWithHash(username);

    // Identical response for unknown-user vs bad-password — no enumeration.
    if (!found || !(await bcrypt.compare(password, found.passwordHash))) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
      return;
    }

    const token = await signPlayerJwt(found.playerId);
    const balanceMinor = await deps.wallet.balance(found.playerId, found.currency);
    res.status(200).json({
      token,
      player: { playerId: found.playerId, username: found.username },
      balanceMinor,
      currency: found.currency,
    });
  });

  // =========================================================================
  // GET /me — player JWT
  // =========================================================================

  router.get('/me', requirePlayerJwt, async (req, res): Promise<void> => {
    const playerId = req.player!.playerId;
    const player = await deps.players.getById(playerId);
    if (!player) {
      res.status(404).json({ error: { code: 'PLAYER_NOT_FOUND', message: 'Player not found' } });
      return;
    }
    const balanceMinor = await deps.wallet.balance(playerId, player.currency);
    res.status(200).json({ playerId: player.playerId, username: player.username, balanceMinor, currency: player.currency });
  });

  return router;
}
