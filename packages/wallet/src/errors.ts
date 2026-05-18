// ---------------------------------------------------------------------------
// WalletError hierarchy — maps spec §7 error codes to typed errors
// ---------------------------------------------------------------------------

export interface WalletErrorShape {
  code: string;          // spec §7 code, e.g. 'INSUFFICIENT_FUNDS'
  message: string;
  httpStatus: number;    // the HTTP status that produced it (0 for network/timeout)
  retryable: boolean;
  balanceMinor?: number; // present on INSUFFICIENT_FUNDS per spec §5.3/§7
}

export class WalletError extends Error implements WalletErrorShape {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly balanceMinor?: number;

  constructor(shape: WalletErrorShape) {
    super(shape.message);
    this.name = 'WalletError';
    this.code = shape.code;
    this.httpStatus = shape.httpStatus;
    this.retryable = shape.retryable;
    if (shape.balanceMinor !== undefined) {
      this.balanceMinor = shape.balanceMinor;
    }
  }
}

/**
 * Network failure / timeout / aborted — retryable, httpStatus 0.
 */
export class WalletNetworkError extends WalletError {
  constructor(message: string) {
    super({ code: 'NETWORK_ERROR', message, httpStatus: 0, retryable: true });
    this.name = 'WalletNetworkError';
  }
}

/**
 * Operator returned a response but the X-Signature was missing or invalid.
 * Protocol violation — NON-retryable, alert-worthy. code = 'RESPONSE_SIGNATURE_INVALID'.
 */
export class ResponseSignatureError extends WalletError {
  constructor(message: string) {
    super({
      code: 'RESPONSE_SIGNATURE_INVALID',
      message,
      httpStatus: 0,
      retryable: false,
    });
    this.name = 'ResponseSignatureError';
  }
}

// ---------------------------------------------------------------------------
// Retryability classification (spec §7/§8)
// ---------------------------------------------------------------------------
// Retryable: HTTP 429 (RATE_LIMITED), HTTP 5xx (UPSTREAM_ERROR / any 5xx),
//            network/timeout (httpStatus 0).
// Non-retryable: 400, 401, 403, 404, 409, 422 and everything else.

function isRetryable(httpStatus: number): boolean {
  return httpStatus === 429 || httpStatus >= 500;
}

// ---------------------------------------------------------------------------
// Error envelope parser (spec §7)
// ---------------------------------------------------------------------------

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    balanceMinor?: number;
  };
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b['error'] !== 'object' || b['error'] === null) return false;
  const err = b['error'] as Record<string, unknown>;
  return typeof err['code'] === 'string' && typeof err['message'] === 'string';
}

/**
 * Build a WalletError from an operator error envelope
 * { error: { code, message, balanceMinor? } } + http status.
 *
 * If the body doesn't match the envelope, synthesises a WalletError with
 * code 'MALFORMED_ERROR_BODY' (non-retryable for 4xx, retryable for 5xx).
 */
export function walletErrorFromResponse(httpStatus: number, body: unknown): WalletError {
  const retryable = isRetryable(httpStatus);

  if (isErrorEnvelope(body)) {
    const { code, message, balanceMinor } = body.error;
    return new WalletError({ code, message, httpStatus, retryable, balanceMinor });
  }

  return new WalletError({
    code: 'MALFORMED_ERROR_BODY',
    message: `Operator returned HTTP ${httpStatus} with non-standard body`,
    httpStatus,
    retryable,
  });
}
