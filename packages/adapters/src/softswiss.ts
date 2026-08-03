// ---------------------------------------------------------------------------
// SoftSwiss-style wallet adapter (Task 7.2)
// ---------------------------------------------------------------------------
// IMPORTANT — REPRESENTATIVE MODEL DISCLAIMER:
//   This models a SoftSwiss-style seamless-wallet protocol for integration
//   scaffolding; field names and the signature scheme are representative, not
//   copied from SoftSwiss production. A real onboarding would reconcile these
//   against the operator's live spec. Real SoftSwiss uses RSA-signed callbacks;
//   this representative adapter uses HMAC-SHA256 with the platform's shared
//   `operator.signingKey` to fit this platform's key model.
//
// The full contract this file implements is documented in
//   doc/integrations/softswiss.md
//
// Shape of the dialect (the contract):
//   - Single action-routed callback endpoint: POST {walletBaseUrl}/callback.
//   - JSON body, snake_case fields, amounts in integer MINOR units.
//   - Request signature: header `X-Sign` = lowercase hex
//       HMAC-SHA256(rawBodyString, operator.signingKey).
//     Also sends `X-Api-Key: operator.apiKey` and Content-Type: application/json.
//   - Business errors come back as HTTP 200 with a `status` string in the body
//     (a SoftSwiss trait). The response is HMAC-signed in the `X-Sign` header
//     over the raw response body.
//
// Determinism: uses ONLY ctx inputs (timestamp/nonce/operator/payload). No
// Date.now(), no global state. Never logs secret material.
// ---------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import {
  WalletError,
  ResponseSignatureError,
  type WalletAdapter,
  type AdapterRequestContext,
  type AdapterResponseContext,
  type AdapterEndpoint,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type BalanceRequest,
  type BetRequest,
  type WinRequest,
  type RollbackRequest,
  type RoundEndRequest,
} from '@crash/wallet';

// ---------------------------------------------------------------------------
// Signature primitive — HMAC-SHA256(rawBodyString, signingKey) → lowercase hex
// ---------------------------------------------------------------------------

function hmacHex(body: string, key: Buffer): string {
  return createHmac('sha256', key).update(body, 'utf8').digest('hex');
}

/** Constant-time-ish hex compare (length-checked, then per-char). Both inputs
 *  are lowercase hex strings; a simple compare is acceptable here since the
 *  values are not attacker-tunable to learn timing — but we still avoid early
 *  return shortcuts on content beyond the length check. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// encodeRequest — canonical → SoftSwiss-style wire body (per endpoint)
// ---------------------------------------------------------------------------

const CALLBACK_PATH = '/callback';

function buildBody(ctx: AdapterRequestContext): Record<string, unknown> {
  const { endpoint, payload, timestamp, nonce } = ctx;

  switch (endpoint) {
    case 'bet': {
      const p = payload as BetRequest;
      return {
        action: 'bet',
        request_uuid: p.txnId,
        timestamp,
        user: p.playerId,
        session_id: p.sessionId,
        game: p.gameId,
        game_round: p.roundId,
        bet_id: p.betId,
        amount: p.amountMinor,
        currency: p.currency,
      };
    }
    case 'win': {
      const p = payload as WinRequest;
      return {
        action: 'win',
        request_uuid: p.txnId,
        timestamp,
        reference_transaction_uuid: p.betTxnId,
        user: p.playerId,
        game_round: p.roundId,
        bet_id: p.betId,
        amount: p.amountMinor,
        multiplier: p.multiplier,
        currency: p.currency,
      };
    }
    case 'rollback': {
      const p = payload as RollbackRequest;
      return {
        action: 'rollback',
        request_uuid: p.txnId,
        timestamp,
        reference_transaction_uuid: p.betTxnId,
        user: p.playerId,
        reason: p.reason,
      };
    }
    case 'balance': {
      const p = payload as BalanceRequest;
      // No native txnId — derive a deterministic request_uuid from the nonce.
      return {
        action: 'balance',
        request_uuid: nonce,
        timestamp,
        user: p.playerId,
        session_id: p.sessionId,
      };
    }
    case 'authenticate': {
      const p = payload as AuthenticateRequest;
      // No native txnId — derive a deterministic request_uuid from the nonce.
      return {
        action: 'authenticate',
        request_uuid: nonce,
        timestamp,
        token: p.token,
        ip: p.ip,
        user_agent: p.userAgent,
        game: p.gameId,
      };
    }
    case 'roundEnd': {
      const p = payload as RoundEndRequest;
      // Fire-and-forget; minimal snake_case passthrough of the bets array.
      return {
        action: 'round_end',
        request_uuid: nonce,
        timestamp,
        game_round: p.roundId,
        user: p.playerId,
        bets: p.bets.map((b) => ({
          bet_id: b.betId,
          request_uuid: b.txnId,
          amount: b.amountMinor,
          result: b.result,
          win_request_uuid: b.winTxnId,
          win_amount: b.winAmountMinor,
          multiplier: b.multiplier,
        })),
      };
    }
    default: {
      // Exhaustiveness guard.
      const _never: never = endpoint;
      throw new WalletError({
        code: 'UNSUPPORTED_ENDPOINT',
        message: `softswiss adapter: unsupported endpoint ${String(_never)}`,
        httpStatus: 400,
        retryable: false,
      });
    }
  }
}

function encodeRequest(ctx: AdapterRequestContext) {
  const body = JSON.stringify(buildBody(ctx));
  const sign = hmacHex(body, ctx.operator.signingKey);
  return {
    method: 'POST' as const,
    url: ctx.operator.walletBaseUrl + CALLBACK_PATH,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': ctx.operator.apiKey,
      'X-Sign': sign,
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Response decoding
// ---------------------------------------------------------------------------

/** Parsed SoftSwiss-style response body (all fields optional except status). */
interface SsResponseBody {
  status: string;
  user?: string;
  currency?: string;
  balance?: number;
  transaction_uuid?: string;
  request_uuid?: string;
}

/** Table-driven mapping for the RS_ERROR_* business statuses (HTTP 200 body).
 *  Returns the canonical WalletError fields. For the special cases handled
 *  out-of-band (insufficient funds carries balanceMinor; transaction-not-found
 *  is rollback-idempotent), see decodeResponse. */
interface ErrorMapEntry {
  code: string;
  httpStatus: number;
}

const RS_ERROR_MAP: Record<string, ErrorMapEntry> = {
  RS_ERROR_INSUFFICIENT_FUNDS: { code: 'INSUFFICIENT_FUNDS', httpStatus: 402 },
  RS_ERROR_DUPLICATE_TRANSACTION: { code: 'DUPLICATE_TRANSACTION', httpStatus: 409 },
  RS_ERROR_TOKEN_EXPIRED: { code: 'TOKEN_INVALID', httpStatus: 401 },
  RS_ERROR_TOKEN_INVALID: { code: 'TOKEN_INVALID', httpStatus: 401 },
  RS_ERROR_TRANSACTION_DOES_NOT_EXIST: { code: 'TRANSACTION_NOT_FOUND', httpStatus: 404 },
};

function isRetryable(httpStatus: number): boolean {
  return httpStatus === 429 || httpStatus >= 500;
}

/** Map an RS_OK body to the canonical response value for the endpoint. */
function mapSuccess(endpoint: AdapterEndpoint, body: SsResponseBody): unknown {
  switch (endpoint) {
    case 'bet':
    case 'win':
      return {
        operatorTxnId: body.transaction_uuid ?? '',
        balanceMinor: body.balance ?? 0,
        currency: body.currency ?? '',
      };
    case 'rollback':
      return {
        operatorTxnId: body.transaction_uuid ?? '',
        balanceMinor: body.balance ?? 0,
        currency: body.currency ?? '',
        status: 'rolled_back' as const,
      };
    case 'balance':
      return {
        balance: body.balance ?? 0,
        currency: body.currency ?? '',
      };
    case 'authenticate': {
      // SYNTHESIZED FIELDS — the SoftSwiss-style authenticate response carries
      // only user/balance/currency. Our canonical AuthenticateResponse requires
      // richer player metadata. We synthesize HONEST, clearly-marked defaults so
      // a real onboarding can wire these to the operator's real fields. These are
      // NOT operator-supplied values; documented in doc/integrations/softswiss.md.
      const resp: AuthenticateResponse = {
        playerId: body.user ?? '',
        displayName: body.user ?? '',     // synthesized: falls back to the user id
        currency: body.currency ?? '',
        balance: body.balance ?? 0,
        country: '',                       // synthesized: not provided by dialect
        jurisdiction: '',                  // synthesized: not provided by dialect
        language: 'en',                    // synthesized: neutral default
        rgLimits: {
          maxBetMinor: 0,                  // synthesized: 0 = no adapter-side limit
          sessionEndsAt: 0,                // synthesized: 0 = no session expiry hint
        },
      };
      return resp;
    }
    case 'roundEnd':
      // Fire-and-forget; the client discards the value.
      return undefined;
    default: {
      const _never: never = endpoint;
      return _never;
    }
  }
}

function decodeResponse(ctx: AdapterResponseContext): unknown {
  const { status, headers, bodyText, operator, endpoint } = ctx;

  // 1. Verify the response signature FIRST (over the raw body bytes).
  const provided = headers.get('X-Sign') ?? '';
  const expected = hmacHex(bodyText, operator.signingKey);
  if (!provided || !hexEqual(provided.toLowerCase(), expected)) {
    throw new ResponseSignatureError(
      `softswiss: response X-Sign verification failed (status ${status})`,
      status,
    );
  }

  // 2. Transport-level non-2xx (the dialect surfaces BUSINESS errors as 200, so
  //    a non-2xx here is a true transport fault).
  if (status >= 500) {
    throw new WalletError({
      code: 'UPSTREAM_ERROR',
      message: `softswiss: upstream returned HTTP ${status}`,
      httpStatus: status,
      retryable: true,
    });
  }
  if (status === 429) {
    throw new WalletError({
      code: 'RATE_LIMITED',
      message: 'softswiss: upstream returned HTTP 429',
      httpStatus: 429,
      retryable: true,
    });
  }

  // 3. Parse the body as JSON.
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    // Malformed JSON: on a 2xx → MALFORMED_RESPONSE; on other non-2xx (4xx with
    // unparseable body) → MALFORMED_ERROR_BODY. Both non-retryable.
    if (status >= 200 && status < 300) {
      throw new WalletError({
        code: 'MALFORMED_RESPONSE',
        message: `softswiss: non-JSON 2xx response (status ${status})`,
        httpStatus: status,
        retryable: false,
      });
    }
    throw new WalletError({
      code: 'MALFORMED_ERROR_BODY',
      message: `softswiss: non-2xx HTTP ${status} with non-JSON body`,
      httpStatus: status,
      retryable: isRetryable(status),
    });
  }

  // A non-2xx (other than 5xx/429 handled above) with no usable status string.
  if ((status < 200 || status >= 300) && (!parsed || typeof parsed !== 'object')) {
    throw new WalletError({
      code: 'MALFORMED_ERROR_BODY',
      message: `softswiss: non-2xx HTTP ${status} with no parseable body`,
      httpStatus: status,
      retryable: isRetryable(status),
    });
  }

  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>)['status'] !== 'string') {
    throw new WalletError({
      code: 'MALFORMED_RESPONSE',
      message: `softswiss: response body missing string 'status' (HTTP ${status})`,
      httpStatus: status,
      retryable: false,
    });
  }

  const body = parsed as SsResponseBody;
  const rsStatus = body.status;

  // 4. Success.
  if (rsStatus === 'RS_OK') {
    return mapSuccess(endpoint, body);
  }

  // 4b. RS_ERROR_TRANSACTION_DOES_NOT_EXIST: idempotent no-op SUCCESS for
  //     rollback ONLY (a rollback of an unknown txn is a no-op per RollbackResponse).
  if (rsStatus === 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST' && endpoint === 'rollback') {
    return {
      operatorTxnId: body.request_uuid ?? '',
      balanceMinor: body.balance ?? 0,
      currency: body.currency ?? '',
      status: 'noop' as const,
    };
  }

  // 4c. Table-driven RS_ERROR_* mapping.
  const mapped = RS_ERROR_MAP[rsStatus];
  if (mapped) {
    const shape = {
      code: mapped.code,
      message: `softswiss: ${rsStatus}`,
      httpStatus: mapped.httpStatus,
      retryable: false,
    } as const;
    // INSUFFICIENT_FUNDS carries the operator's current balance.
    if (rsStatus === 'RS_ERROR_INSUFFICIENT_FUNDS') {
      throw new WalletError({ ...shape, balanceMinor: body.balance });
    }
    throw new WalletError(shape);
  }

  // 4d. Any other RS_ERROR_* → generic unprocessable (422), non-retryable.
  throw new WalletError({
    code: rsStatus,
    message: `softswiss: business error ${rsStatus}`,
    httpStatus: 422,
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const softswissAdapter: WalletAdapter = {
  name: 'softswiss',
  encodeRequest,
  decodeResponse,
};
