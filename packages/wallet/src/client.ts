// ---------------------------------------------------------------------------
// Wallet HTTP client — spec §5, §8, §9
// Signs requests per §4.2, verifies response signatures per §4.3,
// implements per-endpoint timeout + retry + backoff per §8.
// ---------------------------------------------------------------------------

import { sign, verifyResponse } from './signing.js';
import { type Operator } from './types.js';
import {
  WalletError,
  WalletNetworkError,
  ResponseSignatureError,
  walletErrorFromResponse,
} from './errors.js';

// ---------------------------------------------------------------------------
// Request / Response types (spec §5 — field names follow the spec exactly)
// ---------------------------------------------------------------------------

// §5.1 POST /authenticate
export interface AuthenticateRequest {
  token: string;
  ip: string;
  userAgent: string;
  gameId: string;
}

export interface AuthenticateResponse {
  playerId: string;
  displayName: string;
  currency: string;
  balance: number;         // minor units
  country: string;
  jurisdiction: string;
  language: string;
  rgLimits: {
    maxBetMinor: number;
    sessionEndsAt: number;
  };
}

// §5.2 POST /balance
export interface BalanceRequest {
  playerId: string;
  sessionId: string;
}

export interface BalanceResponse {
  balance: number;   // minor units
  currency: string;
}

// §5.3 POST /bet
export interface BetRequest {
  playerId: string;
  sessionId: string;
  roundId: string;
  betId: string;
  txnId: string;
  amountMinor: number;
  currency: string;
  gameId: string;
  placedAt: number;  // unix seconds
}

export interface BetResponse {
  operatorTxnId: string;
  balanceMinor: number;
  currency: string;
}

// §5.4 POST /win
export interface WinRequest {
  playerId: string;
  sessionId: string;
  roundId: string;
  betId: string;
  betTxnId: string;
  txnId: string;
  amountMinor: number;
  multiplier: number;
  currency: string;
  settledAt: number;  // unix seconds
}

export interface WinResponse {
  operatorTxnId: string;
  balanceMinor: number;
  currency: string;
}

// §5.5 POST /rollback
export interface RollbackRequest {
  playerId: string;
  betTxnId: string;
  txnId: string;
  reason: 'round_voided' | 'game_error' | 'timeout' | 'manual_void';
}

export interface RollbackResponse {
  operatorTxnId: string;
  balanceMinor: number;
  currency: string;
  status: 'rolled_back' | 'noop';
}

// §5.6 POST /round-end
export interface RoundEndRequest {
  roundId: string;
  playerId: string;
  crashPoint: number;
  serverSeedHash: string;
  serverSeed: string;
  bets: Array<{
    betId: string;
    txnId: string;
    amountMinor: number;
    result: string;
    winTxnId?: string;
    winAmountMinor?: number;
    multiplier?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Per-endpoint policy table (spec §8)
// ---------------------------------------------------------------------------

interface EndpointPolicy {
  path: string;
  timeoutMs: number;
  maxAttempts: number;
  /** backoffMs[i] = delay BEFORE attempt i+2 (0-indexed). If sequence is
   *  shorter than needed, reuse the last value. */
  backoffMs: number[];
}

const ENDPOINT_POLICIES = {
  authenticate: {
    path: '/authenticate',
    timeoutMs: 5000,
    maxAttempts: 2,
    backoffMs: [250],
  },
  balance: {
    path: '/balance',
    timeoutMs: 3000,
    maxAttempts: 2,
    backoffMs: [250],
  },
  bet: {
    path: '/bet',
    timeoutMs: 10000,
    maxAttempts: 4,
    backoffMs: [500, 1500, 4000],
  },
  win: {
    path: '/win',
    timeoutMs: 10000,
    maxAttempts: 6,
    backoffMs: [500, 1000, 2000, 5000, 15000],
  },
  rollback: {
    path: '/rollback',
    timeoutMs: 10000,
    maxAttempts: -1,  // replaced at runtime with maxRollbackAttempts
    backoffMs: [1000, 5000, 30000], // 30000 is the cap; reuse last for subsequent retries
  },
  roundEnd: {
    path: '/round-end',
    timeoutMs: 5000,
    maxAttempts: 1,
    backoffMs: [],
  },
} satisfies Record<string, EndpointPolicy>;

type EndpointKey = keyof typeof ENDPOINT_POLICIES;

function backoffForAttempt(policy: EndpointPolicy, attemptNumber: number): number {
  // attemptNumber is 1-based: after attempt 1 fails, we want backoffMs[0], etc.
  const idx = attemptNumber - 1;
  if (policy.backoffMs.length === 0) return 0;
  const clampedIdx = Math.min(idx, policy.backoffMs.length - 1);
  return policy.backoffMs[clampedIdx];
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface WalletClientOptions {
  /** Override the fetch impl (tests inject; default = global fetch). */
  fetchImpl?: typeof fetch;
  /** Override nonce generator (tests inject deterministic). Default = crypto.randomUUID. */
  generateNonce?: () => string;
  /** Override clock for X-Timestamp (unix seconds). Default = () => Math.floor(Date.now()/1000). */
  nowSeconds?: () => number;
  /** Override the sleep used for backoff (tests inject no-op / fake). Default = real setTimeout promise. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Cap rollback attempts.
   * The spec says "until success"; durable re-drive is the recovery worker's job in Task 1.7.
   * The in-process client uses a finite cap. Default 8.
   */
  maxRollbackAttempts?: number;
}

// ---------------------------------------------------------------------------
// WalletClient
// ---------------------------------------------------------------------------

export class WalletClient {
  private readonly operator: Operator;
  private readonly fetchImpl: typeof fetch;
  private readonly generateNonce: () => string;
  private readonly nowSeconds: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRollbackAttempts: number;

  constructor(operator: Operator, opts?: WalletClientOptions) {
    this.operator = operator;
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.generateNonce = opts?.generateNonce ?? (() => crypto.randomUUID());
    this.nowSeconds = opts?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRollbackAttempts = opts?.maxRollbackAttempts ?? 8;
  }

  // -------------------------------------------------------------------------
  // Public endpoint methods
  // -------------------------------------------------------------------------

  authenticate(req: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.executeWithRetry('authenticate', (policy) =>
      this.doRequest<AuthenticateResponse>(policy.path, policy.timeoutMs, req),
    );
  }

  balance(req: BalanceRequest): Promise<BalanceResponse> {
    return this.executeWithRetry('balance', (policy) =>
      this.doRequest<BalanceResponse>(policy.path, policy.timeoutMs, req),
    );
  }

  bet(req: BetRequest): Promise<BetResponse> {
    return this.executeWithRetry('bet', (policy) =>
      this.doRequest<BetResponse>(policy.path, policy.timeoutMs, req),
    );
  }

  win(req: WinRequest): Promise<WinResponse> {
    return this.executeWithRetry('win', (policy) =>
      this.doRequest<WinResponse>(policy.path, policy.timeoutMs, req),
    );
  }

  rollback(req: RollbackRequest): Promise<RollbackResponse> {
    return this.executeWithRetry('rollback', (policy) =>
      this.doRequest<RollbackResponse>(policy.path, policy.timeoutMs, req),
    );
  }

  /** Fire-and-forget per spec §5.6/§8. Never throws to the caller. */
  async roundEnd(req: RoundEndRequest): Promise<void> {
    try {
      await this.doRequest<void>(
        ENDPOINT_POLICIES.roundEnd.path,
        ENDPOINT_POLICIES.roundEnd.timeoutMs,
        req,
        true,  // isRoundEnd — handles 204 empty body
      );
    } catch (err) {
      // Fire-and-forget: swallow all errors. Log as best-effort telemetry.
      console.warn('[WalletClient] roundEnd failed (fire-and-forget):', err);
    }
  }

  // -------------------------------------------------------------------------
  // Retry executor
  // -------------------------------------------------------------------------

  private async executeWithRetry<T>(
    endpointKey: EndpointKey,
    doRequest: (policy: EndpointPolicy) => Promise<T>,
  ): Promise<T> {
    const policy = { ...ENDPOINT_POLICIES[endpointKey] };

    // Override maxAttempts for rollback at runtime
    if (endpointKey === 'rollback') {
      policy.maxAttempts = this.maxRollbackAttempts;
    }

    let lastError: WalletError | undefined;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await doRequest(policy);
      } catch (err) {
        if (!(err instanceof WalletError)) {
          // Unexpected non-WalletError — wrap and rethrow
          throw new WalletNetworkError(err instanceof Error ? err.message : String(err));
        }

        lastError = err;

        // Non-retryable errors stop immediately
        if (!err.retryable) {
          throw err;
        }

        // Retryable: sleep if there are more attempts remaining
        if (attempt < policy.maxAttempts) {
          const delay = backoffForAttempt(policy, attempt);
          if (delay > 0) {
            await this.sleep(delay);
          }
        }
      }
    }

    // Exhausted all attempts
    throw lastError!;
  }

  // -------------------------------------------------------------------------
  // Core HTTP request
  // -------------------------------------------------------------------------

  private async doRequest<T>(
    path: string,
    timeoutMs: number,
    payload: unknown,
    isRoundEnd = false,
  ): Promise<T> {
    // Step 1: Build body bytes
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = Buffer.from(bodyStr);

    // Step 2: Timestamp and nonce
    const timestamp = this.nowSeconds();
    const nonce = this.generateNonce();

    // Step 3: Sign the request per spec §4.2
    const signature = sign(
      { method: 'POST', path, timestamp, nonce, body: bodyBytes },
      this.operator.signingKey,
    );

    // Step 4: Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.operator.apiKey,
      'X-Timestamp': String(timestamp),
      'X-Nonce': nonce,
      'X-Signature': signature,
    };

    // Step 5: Fetch with timeout via AbortController
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(this.operator.walletBaseUrl + path, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
    } catch (err) {
      // Network error or abort (timeout)
      throw new WalletNetworkError(
        err instanceof Error ? err.message : 'Network request failed',
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Step 6: Read response body
    let bodyText: string;
    try {
      bodyText = isRoundEnd && res.status === 204 ? '' : await res.text();
    } catch (err) {
      throw new WalletNetworkError('Failed to read response body');
    }

    // Step 6 cont.: Verify response signature per spec §4.3
    // The response signing string uses the REQUEST's X-Timestamp.
    const responseSig = res.headers.get('X-Signature') ?? '';
    const responseBody = Buffer.from(bodyText);

    const sigValid = verifyResponse(
      { status: res.status, timestamp, body: responseBody, signature: responseSig },
      this.operator.signingKey,
    );

    if (!sigValid) {
      throw new ResponseSignatureError(
        `Response signature verification failed for ${path} (status ${res.status})`,
      );
    }

    // Step 7/8: Parse and return or throw
    if (res.ok) {
      if (isRoundEnd && res.status === 204) {
        return undefined as T;
      }
      try {
        return JSON.parse(bodyText) as T;
      } catch {
        throw new WalletError({
          code: 'MALFORMED_RESPONSE',
          message: `Operator returned non-JSON 2xx response for ${path}`,
          httpStatus: res.status,
          retryable: false,
        });
      }
    }

    // Non-2xx: parse error envelope and throw
    let parsedBody: unknown;
    try {
      parsedBody = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      parsedBody = {};
    }

    throw walletErrorFromResponse(res.status, parsedBody);
  }
}
