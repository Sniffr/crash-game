// ---------------------------------------------------------------------------
// Wallet HTTP client — spec §5, §8, §9
// Signs requests per §4.2, verifies response signatures per §4.3,
// implements per-endpoint timeout + retry + backoff per §8.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { sign, verifyResponse, sha256Hex } from './signing.js';
import { type Operator } from './types.js';
import {
  WalletError,
  WalletNetworkError,
  ResponseSignatureError,
  walletErrorFromResponse,
} from './errors.js';
import { type IdempotencyEntry, type TxnKind, IdempotencyMismatchError } from './bet-log.js';
import type { PgBetLog } from './bet-log-pg.js';
import type { WalletAdapter, AdapterEndpoint } from './adapter.js';
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  BalanceRequest,
  BalanceResponse,
  BetRequest,
  BetResponse,
  WinRequest,
  WinResponse,
  RollbackRequest,
  RollbackResponse,
  RoundEndRequest,
} from './client-types.js';

// ---------------------------------------------------------------------------
// Idempotency fingerprint helper
// ---------------------------------------------------------------------------

/** Volatile transport/timing fields excluded from the idempotency fingerprint:
 *  they legitimately differ between the original call and a recovery replay of
 *  the SAME logical transaction (operator dedupes on txnId per spec §9). */
const VOLATILE_FINGERPRINT_KEYS = ['placedAt', 'settledAt'] as const;

function idempotencyFingerprint(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    for (const k of VOLATILE_FINGERPRINT_KEYS) delete clone[k];
    return sha256Hex(Buffer.from(JSON.stringify(clone)));
  }
  return sha256Hex(Buffer.from(JSON.stringify(payload)));
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
  /** When supplied, bet/win/rollback become crash-safe idempotent: a prior
   *  recorded outcome for the same txnId short-circuits the HTTP call and
   *  replays the recorded result. Pairs with the Task 1.7 recovery worker. */
  betLog?: PgBetLog;
  /** When supplied, the client delegates the wire request/response translation
   *  to this adapter (foreign protocol) instead of the built-in native path.
   *  Injected by the server composition layer per operator.adapter (Task 7.1).
   *  Undefined = native protocol (spec §4). */
  adapter?: WalletAdapter;
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
  private readonly betLog: PgBetLog | undefined;
  private readonly adapter: WalletAdapter | undefined;

  constructor(operator: Operator, opts?: WalletClientOptions) {
    this.operator = operator;
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.generateNonce = opts?.generateNonce ?? (() => randomUUID());
    this.nowSeconds = opts?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRollbackAttempts = opts?.maxRollbackAttempts ?? 8;
    this.betLog = opts?.betLog;
    this.adapter = opts?.adapter;
  }

  // -------------------------------------------------------------------------
  // Public endpoint methods
  // -------------------------------------------------------------------------

  authenticate(req: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.executeWithRetry('authenticate', (policy) =>
      this.doRequest<AuthenticateResponse>('authenticate', policy.path, policy.timeoutMs, req),
    );
  }

  balance(req: BalanceRequest): Promise<BalanceResponse> {
    return this.executeWithRetry('balance', (policy) =>
      this.doRequest<BalanceResponse>('balance', policy.path, policy.timeoutMs, req),
    );
  }

  bet(req: BetRequest): Promise<BetResponse> {
    return this.withIdempotency('bet', req.txnId, req, () =>
      this.executeWithRetry('bet', (policy) =>
        this.doRequest<BetResponse>('bet', policy.path, policy.timeoutMs, req)));
  }

  win(req: WinRequest): Promise<WinResponse> {
    return this.withIdempotency('win', req.txnId, req, () =>
      this.executeWithRetry('win', (policy) =>
        this.doRequest<WinResponse>('win', policy.path, policy.timeoutMs, req)));
  }

  rollback(req: RollbackRequest): Promise<RollbackResponse> {
    return this.withIdempotency('rollback', req.txnId, req, () =>
      this.executeWithRetry('rollback', (policy) =>
        this.doRequest<RollbackResponse>('rollback', policy.path, policy.timeoutMs, req)));
  }

  /** Fire-and-forget per spec §5.6/§8. Never throws to the caller. */
  async roundEnd(req: RoundEndRequest): Promise<void> {
    try {
      await this.doRequest<void>(
        'roundEnd',
        ENDPOINT_POLICIES.roundEnd.path,
        ENDPOINT_POLICIES.roundEnd.timeoutMs,
        req,
        true,  // isRoundEnd — handles 204 empty body
      );
    } catch (err) {
      if (err instanceof WalletError) {
        console.warn('[WalletClient] roundEnd failed (fire-and-forget):', err.code, err.message);
        return;
      }
      throw err; // programming bug — do not hide
    }
  }

  // -------------------------------------------------------------------------
  // Idempotency wrapper (bet/win/rollback only)
  // -------------------------------------------------------------------------

  private async withIdempotency<T>(
    kind: TxnKind,
    txnId: string,
    requestPayload: unknown,
    exec: () => Promise<T>,
  ): Promise<T> {
    // Pure passthrough when no betLog supplied — preserves existing behavior exactly
    if (!this.betLog) return exec();

    const requestHash = idempotencyFingerprint(requestPayload);

    const existing = await this.betLog.getIdempotency(this.operator.operatorId, txnId);

    if (existing) {
      if (existing.requestHash === requestHash) {
        // Short-circuit: replay the recorded result without any HTTP call
        const envelope = JSON.parse(existing.responseJson) as { ok: boolean; value?: unknown; error?: { code: string; message: string; httpStatus: number; retryable: boolean; balanceMinor?: number } };
        if (envelope.ok) {
          return envelope.value as T;
        }
        // Confirmed rejection — reconstruct and rethrow the same WalletError
        throw new WalletError(envelope.error!);
      }
      // Same txnId, different body — caller bug; do not send
      throw new IdempotencyMismatchError(txnId);
    }

    // No existing record — execute the call
    let result: T;
    try {
      result = await exec();
    } catch (err) {
      // Discriminate confirmed rejections using the EXACT same predicate as
      // placeOperatorBet in packages/server/src/game/bets.ts
      const isConfirmedRejection =
        err instanceof WalletError
        && !(err instanceof WalletNetworkError)
        && !(err instanceof ResponseSignatureError)
        && err.httpStatus >= 400 && err.httpStatus < 500;

      if (isConfirmedRejection) {
        const walletErr = err as WalletError;
        const responseJson = JSON.stringify({
          ok: false,
          error: {
            code: walletErr.code,
            message: walletErr.message,
            httpStatus: walletErr.httpStatus,
            retryable: walletErr.retryable,
            balanceMinor: walletErr.balanceMinor,
          },
        });
        try {
          await this.betLog.putIdempotency({
            txnId,
            operatorId: this.operator.operatorId,
            kind,
            requestHash,
            responseJson,
            createdAt: this.nowSeconds(),
          } satisfies IdempotencyEntry);
        } catch (persistErr) {
          console.error('[WalletClient] putIdempotency failed recording confirmed rejection (safe; original error still thrown):', persistErr);
        }
      }
      // Non-confirmed (network / 5xx / signature): do NOT persist — leave no row
      // so recovery can retry freely; operator §9 dedupes server-side.
      throw err;
    }

    // Success: persist then return (best-effort; operator dedupes on replay per spec §9)
    try {
      await this.betLog.putIdempotency({
        txnId,
        operatorId: this.operator.operatorId,
        kind,
        requestHash,
        responseJson: JSON.stringify({ ok: true, value: result }),
        createdAt: this.nowSeconds(),
      } satisfies IdempotencyEntry);
    } catch (persistErr) {
      // Operator call succeeded; idempotency persistence is best-effort. A miss
      // here means a recovery replay will re-send (operator dedupes by txnId
      // per spec §9, so safe). Never convert a real success into a caller error.
      console.error('[WalletClient] putIdempotency failed after success (safe; operator deduped on replay):', persistErr);
    }
    return result;
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
    endpoint: AdapterEndpoint,
    path: string,
    timeoutMs: number,
    payload: unknown,
    isRoundEnd = false,
  ): Promise<T> {
    // Timestamp and nonce — shared by both paths (same clock WalletClient uses).
    const timestamp = this.nowSeconds();
    const nonce = this.generateNonce();

    // Adapter path: delegate wire encode + response decode to the foreign
    // protocol. The fetch+timeout+network-error step is shared with native.
    if (this.adapter) {
      const wire = this.adapter.encodeRequest({
        endpoint,
        payload,
        operator: this.operator,
        timestamp,
        nonce,
      });

      const res = await this.fetchWithTimeout(wire.url, {
        method: wire.method,
        headers: wire.headers,
        // GET requests must not carry a body; otherwise send the foreign body.
        body: wire.method === 'GET' ? undefined : wire.body,
        timeoutMs,
      });

      const bodyText = await this.readBody(res, isRoundEnd);

      // The adapter owns signature verification + canonical mapping + error
      // throwing (WalletError subtypes), matching native semantics so the
      // retry/idempotency layers behave identically.
      return this.adapter.decodeResponse({
        endpoint,
        status: res.status,
        headers: res.headers,
        bodyText,
        requestTimestamp: timestamp,
        requestNonce: nonce,
        operator: this.operator,
      }) as T;
    }

    // ---- Native path (spec §4) — observably identical to pre-7.1 behavior ----

    // Step 1: Build body bytes
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = Buffer.from(bodyStr);

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
    const res = await this.fetchWithTimeout(this.operator.walletBaseUrl + path, {
      method: 'POST',
      headers,
      body: bodyStr,
      timeoutMs,
    });

    // Step 6: Read response body
    const bodyText = await this.readBody(res, isRoundEnd);

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
        res.status,
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

  // -------------------------------------------------------------------------
  // Shared transport primitives (native + adapter paths use the same ones, so
  // timeout / network-error / empty-body behavior is identical across both).
  // -------------------------------------------------------------------------

  /** Fetch with an AbortController timeout. Network errors / aborts (timeout)
   *  are wrapped as a retryable WalletNetworkError. */
  private async fetchWithTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string | undefined; timeoutMs: number },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
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
  }

  /** Read the response body as text, honoring the roundEnd 204 empty-body rule.
   *  A read failure is a retryable WalletNetworkError. */
  private async readBody(res: Response, isRoundEnd: boolean): Promise<string> {
    try {
      return isRoundEnd && res.status === 204 ? '' : await res.text();
    } catch {
      throw new WalletNetworkError('Failed to read response body');
    }
  }
}
