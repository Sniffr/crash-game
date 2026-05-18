/**
 * Operator Stub Server — Galaxy Crash seamless wallet protocol §5
 *
 * Implements the operator side of the wallet API so integrators can
 * develop and test locally without a live operator backend.
 *
 * All state is in-memory and resets on every restart.
 */

import crypto from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

// 32-byte key. Override via STUB_SIGNING_KEY (base64-encoded).
const DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLWZvcmRldg=='; // "test-stub-key-32bytes-fordev"
const SIGNING_KEY_B64 = process.env['STUB_SIGNING_KEY'] ?? DEFAULT_KEY_B64;
const SIGNING_KEY = Buffer.from(SIGNING_KEY_B64, 'base64');

// When truthy, the next /win call returns 500 (one-shot, cleared after use).
let pendingForceFailWin = false;

function shouldFailNextWin(): boolean {
  // Arm flag lazily on each call so tests can set the env var at runtime.
  if (process.env['STUB_FAIL_NEXT_WIN']) {
    pendingForceFailWin = true;
    delete process.env['STUB_FAIL_NEXT_WIN'];
  }
  if (pendingForceFailWin) {
    pendingForceFailWin = false;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface Player {
  currency: string;
  balance: number; // minor units
  displayName: string;
}

const players = new Map<string, Player>([
  ['pid-1', { currency: 'EUR', balance: 100000, displayName: 'lucky_falcon_42' }],
  ['pid-2', { currency: 'USD', balance: 100000, displayName: 'cosmic_otter_7' }],
  ['pid-3', { currency: 'BTC', balance: 1000000, displayName: 'void_walker_3' }],
]);

// token → playerId
const launchTokens = new Map<string, string>([
  ['tok-pid-1', 'pid-1'],
  ['tok-pid-2', 'pid-2'],
  ['tok-pid-3', 'pid-3'],
]);

// Idempotency: `${operatorId}:${txnId}` → { req, res }
const idempotencyTable = new Map<string, { req: object; res: object }>();

// Bets by betTxnId for rollback lookup: betTxnId → { playerId, amountMinor, rolledBack }
interface BetRecord {
  playerId: string;
  amountMinor: number;
  rolledBack: boolean;
}
const betByTxnId = new Map<string, BetRecord>();

// Round-end events (append-only)
const roundEndLog: object[] = [];

// Nonce cache: nonce → expiry (unix ms)
const nonceCache = new Map<string, number>();
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256Hex(key: Buffer, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function verifyHmac(key: Buffer, data: string, expected: string): boolean {
  const actual = Buffer.from(hmacSha256Hex(key, data));
  const exp = Buffer.from(expected);
  if (actual.length !== exp.length) return false;
  return crypto.timingSafeEqual(actual, exp);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

// Extend Request with rawBody
declare module 'express-serve-static-core' {
  interface Request {
    rawBody: Buffer;
  }
}

export const app = express();

// Capture raw body bytes for HMAC signing, then parse JSON
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  }),
);

// ---------------------------------------------------------------------------
// Nonce cleanup (prune expired nonces)
// ---------------------------------------------------------------------------

function pruneNonces(): void {
  const now = Date.now();
  for (const [nonce, expiry] of nonceCache) {
    if (expiry < now) nonceCache.delete(nonce);
  }
}

// ---------------------------------------------------------------------------
// Signature middleware (verifies inbound, sets up response signing)
// ---------------------------------------------------------------------------

function signatureMiddleware(req: Request, res: Response, next: NextFunction): void {
  const timestamp = req.headers['x-timestamp'] as string | undefined;
  const nonce = req.headers['x-nonce'] as string | undefined;
  const incomingSig = req.headers['x-signature'] as string | undefined;

  const nowSec = Math.floor(Date.now() / 1000);

  if (!timestamp || !nonce || !incomingSig) {
    sendError(res, 401, 'INVALID_SIGNATURE', 'Missing required signing headers', timestamp);
    return;
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(nowSec - ts) > 300) {
    sendError(res, 401, 'STALE_REQUEST', 'Request timestamp is outside ±300s window', timestamp);
    return;
  }

  pruneNonces();
  if (nonceCache.has(nonce)) {
    sendError(res, 401, 'NONCE_REUSED', 'Nonce has already been used', timestamp);
    return;
  }

  // Reconstruct signing string per spec §4.2
  const rawBody: Buffer = req.rawBody ?? Buffer.alloc(0);
  const bodyHash = sha256Hex(rawBody);
  const signingString = `${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${bodyHash}`;

  if (!verifyHmac(SIGNING_KEY, signingString, incomingSig)) {
    sendError(res, 401, 'INVALID_SIGNATURE', 'HMAC-SHA256 signature mismatch', timestamp);
    return;
  }

  // Record nonce
  nonceCache.set(nonce, Date.now() + NONCE_TTL_MS);

  // Monkey-patch res.json to add response signature per spec §4.3
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const bodyStr = JSON.stringify(body);
    const bodyHash2 = sha256Hex(Buffer.from(bodyStr));
    const status = res.statusCode;
    const resSigString = `${status}\n${timestamp}\n${bodyHash2}`;
    const resSig = hmacSha256Hex(SIGNING_KEY, resSigString);
    res.setHeader('X-Signature', resSig);
    return origJson(body);
  };

  next();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  timestamp?: string,
  details?: object,
): void {
  const body = { error: { code, message, ...details } };

  // Sign the error response if we have a timestamp to sign with
  if (timestamp) {
    const bodyStr = JSON.stringify(body);
    const bodyHash = sha256Hex(Buffer.from(bodyStr));
    const sigString = `${status}\n${timestamp}\n${bodyHash}`;
    const sig = hmacSha256Hex(SIGNING_KEY, sigString);
    res.setHeader('X-Signature', sig);
  }

  res.status(status).json(body);
}

function operatorId(req: Request): string {
  // Treat X-API-Key as operator id (single-tenant stub)
  return (req.headers['x-api-key'] as string | undefined) ?? 'default';
}

function idempotencyKey(opId: string, txnId: string): string {
  return `${opId}:${txnId}`;
}

function randomBase36(len: number): string {
  let s = '';
  while (s.length < len) {
    s += Math.random().toString(36).slice(2);
  }
  return s.slice(0, len);
}

function genOperatorTxnId(): string {
  return `op-tx-${randomBase36(5)}`;
}

// ---------------------------------------------------------------------------
// Logging middleware
// ---------------------------------------------------------------------------

app.use((req: Request, res: Response, next: NextFunction) => {
  res.on('finish', () => {
    const sig = req.headers['x-signature'] ? 'signed' : 'unsigned';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (${sig}) → ${res.statusCode}`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// 5.1 POST /authenticate
app.post('/authenticate', signatureMiddleware, (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    sendError(res, 400, 'INVALID_REQUEST', 'Missing token', req.headers['x-timestamp'] as string);
    return;
  }

  const playerId = launchTokens.get(token);
  if (!playerId) {
    sendError(res, 401, 'INVALID_TOKEN', 'Launch token is invalid or expired', req.headers['x-timestamp'] as string);
    return;
  }

  const player = players.get(playerId)!;
  const sessionEndsAt = Math.floor(Date.now() / 1000) + 8 * 3600;

  res.json({
    playerId,
    displayName: player.displayName,
    currency: player.currency,
    balance: player.balance,
    country: 'MT',
    jurisdiction: 'MT',
    language: 'en',
    rgLimits: {
      maxBetMinor: 500000,
      sessionEndsAt,
    },
  });
});

// 5.2 POST /balance
app.post('/balance', signatureMiddleware, (req: Request, res: Response) => {
  const { playerId } = req.body as { playerId?: string };
  const player = players.get(playerId ?? '');
  if (!player) {
    sendError(res, 404, 'PLAYER_NOT_FOUND', `Player ${playerId} not found`, req.headers['x-timestamp'] as string);
    return;
  }

  res.json({ balance: player.balance, currency: player.currency });
});

// 5.3 POST /bet
app.post('/bet', signatureMiddleware, (req: Request, res: Response) => {
  const body = req.body as {
    playerId?: string;
    txnId?: string;
    amountMinor?: number;
    currency?: string;
  };

  const ts = req.headers['x-timestamp'] as string;
  const opId = operatorId(req);

  // Idempotency check first
  if (body.txnId) {
    const cached = idempotencyTable.get(idempotencyKey(opId, body.txnId));
    if (cached) {
      res.json(cached.res);
      return;
    }
  }

  const player = players.get(body.playerId ?? '');
  if (!player) {
    sendError(res, 404, 'PLAYER_NOT_FOUND', `Player ${body.playerId} not found`, ts);
    return;
  }

  if (!body.txnId || body.amountMinor === undefined || !body.currency) {
    sendError(res, 400, 'INVALID_REQUEST', 'Missing required fields', ts);
    return;
  }

  if (body.currency !== player.currency) {
    sendError(res, 422, 'CURRENCY_MISMATCH', `Player currency is ${player.currency}, got ${body.currency}`, ts);
    return;
  }

  if (body.amountMinor <= 0) {
    sendError(res, 400, 'INVALID_REQUEST', 'amountMinor must be positive', ts);
    return;
  }

  if (body.amountMinor > 500000) {
    sendError(res, 409, 'BET_LIMIT_EXCEEDED', `Bet ${body.amountMinor} exceeds max 500000`, ts);
    return;
  }

  if (player.balance < body.amountMinor) {
    sendError(res, 409, 'INSUFFICIENT_FUNDS', `Balance ${player.balance} < bet ${body.amountMinor}`, ts, {
      balanceMinor: player.balance,
    });
    return;
  }

  player.balance -= body.amountMinor;
  const operatorTxnId = genOperatorTxnId();
  const responseBody = { operatorTxnId, balanceMinor: player.balance, currency: player.currency };

  // Store for idempotency and rollback
  idempotencyTable.set(idempotencyKey(opId, body.txnId), { req: body, res: responseBody });
  betByTxnId.set(body.txnId, { playerId: body.playerId!, amountMinor: body.amountMinor, rolledBack: false });

  res.json(responseBody);
});

// 5.4 POST /win
app.post('/win', signatureMiddleware, (req: Request, res: Response) => {
  const body = req.body as {
    playerId?: string;
    txnId?: string;
    amountMinor?: number;
    currency?: string;
  };

  const ts = req.headers['x-timestamp'] as string;
  const opId = operatorId(req);

  // STUB_FAIL_NEXT_WIN: simulate upstream failure BEFORE idempotency check
  if (shouldFailNextWin()) {
    sendError(res, 500, 'UPSTREAM_ERROR', 'Simulated failure', ts);
    return;
  }

  // Idempotency check
  if (body.txnId) {
    const cached = idempotencyTable.get(idempotencyKey(opId, body.txnId));
    if (cached) {
      res.json(cached.res);
      return;
    }
  }

  const player = players.get(body.playerId ?? '');
  if (!player) {
    sendError(res, 404, 'PLAYER_NOT_FOUND', `Player ${body.playerId} not found`, ts);
    return;
  }

  if (!body.txnId || body.amountMinor === undefined || !body.currency) {
    sendError(res, 400, 'INVALID_REQUEST', 'Missing required fields', ts);
    return;
  }

  if (body.currency !== player.currency) {
    sendError(res, 422, 'CURRENCY_MISMATCH', `Player currency is ${player.currency}, got ${body.currency}`, ts);
    return;
  }

  player.balance += body.amountMinor;
  const operatorTxnId = genOperatorTxnId();
  const responseBody = { operatorTxnId, balanceMinor: player.balance, currency: player.currency };

  idempotencyTable.set(idempotencyKey(opId, body.txnId), { req: body, res: responseBody });

  res.json(responseBody);
});

// 5.5 POST /rollback
app.post('/rollback', signatureMiddleware, (req: Request, res: Response) => {
  const body = req.body as {
    playerId?: string;
    betTxnId?: string;
    txnId?: string;
    reason?: string;
  };

  const ts = req.headers['x-timestamp'] as string;
  const opId = operatorId(req);

  // Idempotency check (txnId is the rollback txnId)
  if (body.txnId) {
    const cached = idempotencyTable.get(idempotencyKey(opId, body.txnId));
    if (cached) {
      res.json(cached.res);
      return;
    }
  }

  const betRecord = body.betTxnId ? betByTxnId.get(body.betTxnId) : undefined;

  if (!betRecord) {
    // Unknown betTxnId → noop per spec §5.5
    const player = players.get(body.playerId ?? '');
    const noopRes = {
      operatorTxnId: 'op-tx-noop',
      balanceMinor: player?.balance ?? 0,
      currency: player?.currency ?? 'EUR',
      status: 'noop',
    };
    if (body.txnId) {
      idempotencyTable.set(idempotencyKey(opId, body.txnId), { req: body, res: noopRes });
    }
    res.json(noopRes);
    return;
  }

  const player = players.get(betRecord.playerId);
  if (!player) {
    sendError(res, 404, 'PLAYER_NOT_FOUND', `Player ${betRecord.playerId} not found`, ts);
    return;
  }

  if (betRecord.rolledBack) {
    // Already rolled back — return prior rollback response (should have been cached by txnId, but handle gracefully)
    const responseBody = {
      operatorTxnId: 'op-tx-noop',
      balanceMinor: player.balance,
      currency: player.currency,
      status: 'rolled_back',
    };
    res.json(responseBody);
    return;
  }

  betRecord.rolledBack = true;
  player.balance += betRecord.amountMinor;

  const operatorTxnId = genOperatorTxnId();
  const responseBody = {
    operatorTxnId,
    balanceMinor: player.balance,
    currency: player.currency,
    status: 'rolled_back',
  };

  if (body.txnId) {
    idempotencyTable.set(idempotencyKey(opId, body.txnId), { req: body, res: responseBody });
  }

  res.json(responseBody);
});

// 5.6 POST /round-end
app.post('/round-end', signatureMiddleware, (req: Request, res: Response) => {
  roundEndLog.push(req.body as object);
  // 204 has no body; sign with SHA256('') per spec §4.3
  const timestamp = req.headers['x-timestamp'] as string;
  const emptyBodyHash = sha256Hex(Buffer.alloc(0));
  const resSigString = `204\n${timestamp}\n${emptyBodyHash}`;
  const resSig = hmacSha256Hex(SIGNING_KEY, resSigString);
  res.setHeader('X-Signature', resSig);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function startServer(port = PORT) {
  const server = app.listen(port, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          Galaxy Crash — Operator Stub Server                 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Port         : ${port.toString().padEnd(46)}║`);
    console.log(`║  Signing key  : ${SIGNING_KEY_B64.slice(0, 46).padEnd(46)}║`);
    if (SIGNING_KEY_B64.length > 46) {
      console.log(`║               : ${SIGNING_KEY_B64.slice(46, 92).padEnd(46)}║`);
    }
    console.log('║                                                              ║');
    console.log('║  Pre-seeded players:                                         ║');
    console.log('║    tok-pid-1 → pid-1  lucky_falcon_42  EUR 1000.00           ║');
    console.log('║    tok-pid-2 → pid-2  cosmic_otter_7   USD 1000.00           ║');
    console.log('║    tok-pid-3 → pid-3  void_walker_3    BTC 0.01              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  });
  return server;
}

// Only start when run directly (not imported by tests)
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startServer();
}
