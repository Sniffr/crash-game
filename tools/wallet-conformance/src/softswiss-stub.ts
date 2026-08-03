/**
 * SoftSwiss-format operator stub — conformance fixture (Task 7.4 / 7.2 DoD)
 *
 * Implements the operator side of the SoftSwiss-style seamless-wallet dialect
 * that `packages/adapters/src/softswiss.ts` speaks, so the conformance harness
 * can drive the REAL WalletClient + softswissAdapter end-to-end against it.
 *
 * Dialect (mirrors softswiss.ts EXACTLY):
 *   - Single action-routed endpoint: POST /callback. JSON body, snake_case,
 *     integer MINOR-unit amounts. `action` discriminates
 *     (bet|win|rollback|balance|authenticate|round_end).
 *   - Inbound request signature: header `X-Sign` = lowercase-hex
 *       HMAC-SHA256(rawBodyString, SIGNING_KEY). Also sends `X-Api-Key`.
 *   - Response: HTTP 200 with a `status` string body
 *       ({ status:'RS_OK'|'RS_ERROR_*', user?, currency?, balance?,
 *          transaction_uuid?, request_uuid? }).
 *     Business errors ride in the 200 body as RS_ERROR_* (a SoftSwiss trait),
 *     NOT non-2xx. Transport faults (the armed /win fault) are real non-2xx.
 *   - EVERY response (success AND error, 2xx AND non-2xx) is signed with
 *     `X-Sign` = HMAC-SHA256(rawResponseBody, SIGNING_KEY) — because the adapter
 *     verifies the response signature FIRST, before inspecting status.
 *
 * All state is in-memory and deterministic; reset via resetStubState().
 * Never logs secret material.
 */

import crypto from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env['PORT'] ?? '4100', 10);

// 32-byte key — SAME default as the native stub. Override via STUB_SIGNING_KEY.
const DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc='; // "test-stub-key-32bytes-v0-padding"
const SIGNING_KEY_B64 = process.env['STUB_SIGNING_KEY'] ?? DEFAULT_KEY_B64;
const SIGNING_KEY = Buffer.from(SIGNING_KEY_B64, 'base64');

// Per-bet limit (mirrors native stub's 500000 cap).
const MAX_BET_MINOR = 500000;

// When truthy, the next /win (action: win) returns 500 once (cleared after use).
let pendingForceFailWin = false;

function shouldFailNextWin(): boolean {
  // Arm lazily on each call so tests can set the env var at runtime (mirrors native).
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
// In-memory state (same seed data as the native stub)
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

// Idempotency by request_uuid → stored RS_OK response body (replayed on repeat).
const idempotencyTable = new Map<string, SsBody>();

// Bets by their request_uuid (the bet's transaction_uuid we hand back equals it),
// for rollback lookup. reference_transaction_uuid points back at the bet.
interface BetRecord {
  playerId: string;
  amountMinor: number;
  rolledBack: boolean;
}
const betByTxn = new Map<string, BetRecord>();

// Round-end events (append-only log).
const roundEndLog: object[] = [];

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function hmacHex(data: string): string {
  return crypto.createHmac('sha256', SIGNING_KEY).update(data, 'utf8').digest('hex');
}

function verifySign(rawBody: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = hmacHex(rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided.toLowerCase());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Response shape + signed-send
// ---------------------------------------------------------------------------

interface SsBody {
  status: string;
  user?: string;
  currency?: string;
  balance?: number;
  transaction_uuid?: string;
  request_uuid?: string;
}

/**
 * Serialize + sign + send. Signs over the EXACT bytes written so the adapter's
 * response-signature check (HMAC over res.text()) passes. Applies to every
 * response, success or error, 2xx or non-2xx.
 */
function sendSigned(res: Response, status: number, body: SsBody): void {
  const bodyStr = JSON.stringify(body);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Sign', hmacHex(bodyStr));
  res.status(status).send(bodyStr);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

declare module 'express-serve-static-core' {
  interface Request {
    rawBody: Buffer;
  }
}

export const app = express();

// Capture raw body bytes (for inbound HMAC verification) then parse JSON.
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  }),
);

// Minimal request log — action + outcome, never secrets.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.on('finish', () => {
    const action = (req.body as { action?: string } | undefined)?.action ?? '?';
    console.log(`[${new Date().toISOString()}] POST ${req.path} action=${action} → ${res.statusCode}`);
  });
  next();
});

// ---------------------------------------------------------------------------
// The single action-routed callback endpoint
// ---------------------------------------------------------------------------

interface CallbackBody {
  action?: string;
  request_uuid?: string;
  user?: string;
  token?: string;
  currency?: string;
  amount?: number;
  reference_transaction_uuid?: string;
}

app.post('/callback', (req: Request, res: Response) => {
  const rawBody = (req.rawBody ?? Buffer.alloc(0)).toString('utf8');
  const provided = req.headers['x-sign'] as string | undefined;

  // 1. Verify inbound signature. On mismatch return a SIGNED non-2xx error so
  //    the adapter's response-signature check still passes (it verifies sig
  //    FIRST); the adapter maps the unknown RS_ERROR_SIGNATURE to a 422-class
  //    business error / or surfaces the 401. We sign so the adapter never
  //    throws ResponseSignatureError for a body we control.
  if (!verifySign(rawBody, provided)) {
    sendSigned(res, 401, { status: 'RS_ERROR_SIGNATURE' });
    return;
  }

  const body = (req.body ?? {}) as CallbackBody;

  switch (body.action) {
    case 'authenticate':
      return handleAuthenticate(res, body);
    case 'balance':
      return handleBalance(res, body);
    case 'bet':
      return handleBet(res, body);
    case 'win':
      return handleWin(res, body);
    case 'rollback':
      return handleRollback(res, body);
    case 'round_end':
      return handleRoundEnd(res, body, req.body as object);
    default:
      sendSigned(res, 200, { status: 'RS_ERROR_UNKNOWN_ACTION' });
      return;
  }
});

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleAuthenticate(res: Response, body: CallbackBody): void {
  const playerId = body.token ? launchTokens.get(body.token) : undefined;
  if (!playerId) {
    sendSigned(res, 200, { status: 'RS_ERROR_TOKEN_INVALID' });
    return;
  }
  const player = players.get(playerId)!;
  sendSigned(res, 200, {
    status: 'RS_OK',
    user: playerId,
    currency: player.currency,
    balance: player.balance,
  });
}

function handleBalance(res: Response, body: CallbackBody): void {
  const player = players.get(body.user ?? '');
  if (!player) {
    sendSigned(res, 200, { status: 'RS_ERROR_USER_NOT_FOUND' });
    return;
  }
  sendSigned(res, 200, {
    status: 'RS_OK',
    user: body.user,
    currency: player.currency,
    balance: player.balance,
  });
}

function handleBet(res: Response, body: CallbackBody): void {
  // Idempotency by request_uuid: replay stored RS_OK response.
  if (body.request_uuid) {
    const cached = idempotencyTable.get(body.request_uuid);
    if (cached) {
      sendSigned(res, 200, cached);
      return;
    }
  }

  const player = players.get(body.user ?? '');
  if (!player) {
    sendSigned(res, 200, { status: 'RS_ERROR_USER_NOT_FOUND' });
    return;
  }

  const amount = body.amount;
  if (amount === undefined || amount <= 0) {
    sendSigned(res, 200, { status: 'RS_ERROR_INVALID_AMOUNT' });
    return;
  }
  // Over-limit BEFORE funds (the request value > limit is a hard reject).
  if (amount > MAX_BET_MINOR) {
    sendSigned(res, 200, { status: 'RS_ERROR_BET_LIMIT' });
    return;
  }
  if (player.balance < amount) {
    // INSUFFICIENT_FUNDS carries the current balance (adapter maps → 402 + balance).
    sendSigned(res, 200, {
      status: 'RS_ERROR_INSUFFICIENT_FUNDS',
      user: body.user,
      currency: player.currency,
      balance: player.balance,
    });
    return;
  }

  player.balance -= amount;
  // The bet's transaction_uuid we return is the request_uuid (deterministic).
  const txnUuid = body.request_uuid ?? `ss-tx-${player.balance}`;
  const responseBody: SsBody = {
    status: 'RS_OK',
    user: body.user,
    currency: player.currency,
    balance: player.balance,
    transaction_uuid: txnUuid,
  };

  if (body.request_uuid) {
    idempotencyTable.set(body.request_uuid, responseBody);
    // Record the bet keyed by its transaction_uuid for rollback lookup.
    betByTxn.set(txnUuid, { playerId: body.user!, amountMinor: amount, rolledBack: false });
  }

  sendSigned(res, 200, responseBody);
}

function handleWin(res: Response, body: CallbackBody): void {
  // Armed one-shot transport fault BEFORE idempotency (mirrors native). A signed
  // 500 → adapter throws retryable UPSTREAM_ERROR → WalletClient retries.
  if (shouldFailNextWin()) {
    sendSigned(res, 500, { status: 'RS_ERROR_UPSTREAM' });
    return;
  }

  if (body.request_uuid) {
    const cached = idempotencyTable.get(body.request_uuid);
    if (cached) {
      sendSigned(res, 200, cached);
      return;
    }
  }

  const player = players.get(body.user ?? '');
  if (!player) {
    sendSigned(res, 200, { status: 'RS_ERROR_USER_NOT_FOUND' });
    return;
  }

  const amount = body.amount;
  if (amount === undefined || amount < 0) {
    sendSigned(res, 200, { status: 'RS_ERROR_INVALID_AMOUNT' });
    return;
  }

  player.balance += amount;
  const txnUuid = body.request_uuid ?? `ss-tx-${player.balance}`;
  const responseBody: SsBody = {
    status: 'RS_OK',
    user: body.user,
    currency: player.currency,
    balance: player.balance,
    transaction_uuid: txnUuid,
  };

  if (body.request_uuid) {
    idempotencyTable.set(body.request_uuid, responseBody);
  }

  sendSigned(res, 200, responseBody);
}

function handleRollback(res: Response, body: CallbackBody): void {
  // Idempotency by the rollback's own request_uuid.
  if (body.request_uuid) {
    const cached = idempotencyTable.get(body.request_uuid);
    if (cached) {
      sendSigned(res, 200, cached);
      return;
    }
  }

  const ref = body.reference_transaction_uuid;
  const bet = ref ? betByTxn.get(ref) : undefined;

  if (!bet) {
    // Unknown reference → TRANSACTION_DOES_NOT_EXIST. The adapter maps this to a
    // noop-success for rollback (RollbackResponse status:'noop').
    sendSigned(res, 200, { status: 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST' });
    return;
  }

  const player = players.get(bet.playerId)!;
  if (!bet.rolledBack) {
    bet.rolledBack = true;
    player.balance += bet.amountMinor;
  }

  const responseBody: SsBody = {
    status: 'RS_OK',
    user: bet.playerId,
    currency: player.currency,
    balance: player.balance,
    transaction_uuid: body.request_uuid,
  };

  if (body.request_uuid) {
    idempotencyTable.set(body.request_uuid, responseBody);
  }

  sendSigned(res, 200, responseBody);
}

function handleRoundEnd(res: Response, _body: CallbackBody, raw: object): void {
  roundEndLog.push(raw);
  sendSigned(res, 200, { status: 'RS_OK' });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all in-memory state to initial conditions (for test beforeEach). */
export function resetStubState(): void {
  players.set('pid-1', { currency: 'EUR', balance: 100000, displayName: 'lucky_falcon_42' });
  players.set('pid-2', { currency: 'USD', balance: 100000, displayName: 'cosmic_otter_7' });
  players.set('pid-3', { currency: 'BTC', balance: 1000000, displayName: 'void_walker_3' });

  idempotencyTable.clear();
  betByTxn.clear();
  roundEndLog.length = 0;

  pendingForceFailWin = false;
  delete process.env['STUB_FAIL_NEXT_WIN'];
}

/** Read a player's current balance (test assertions on the debit side-effect). */
export function getPlayerBalance(playerId: string): number | undefined {
  return players.get(playerId)?.balance;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`SoftSwiss-format operator stub listening on :${port}`);
  });
}

// Only start when run directly (not when imported by tests).
if (process.argv[1]?.endsWith('softswiss-stub.ts') || process.argv[1]?.endsWith('softswiss-stub.js')) {
  startServer();
}
