// ---------------------------------------------------------------------------
// Wallet conformance harness — core engine (Task 7.3)
// ---------------------------------------------------------------------------
// Drives the REAL @crash/wallet WalletClient against any operator wallet so
// signing + retry/backoff behave exactly as in production, and asserts a
// declarative YAML suite of cases (responses, error codes, retry counts).
//
// Never logs secrets (signingKey / apiKey).
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { WalletClient, WalletError } from '@crash/wallet';
import type { Operator, OperatorAdapter } from '@crash/wallet';
import { getAdapter } from '@crash/adapters';

import type {
  AuthenticateRequest,
  BalanceRequest,
  BetRequest,
  WinRequest,
  RollbackRequest,
  RoundEndRequest,
} from '@crash/wallet';

// ---------------------------------------------------------------------------
// Case + result shapes
// ---------------------------------------------------------------------------

export type ConformanceEndpoint =
  | 'authenticate'
  | 'balance'
  | 'bet'
  | 'win'
  | 'rollback'
  | 'roundEnd';

export interface ConformanceCase {
  name: string;
  endpoint: ConformanceEndpoint;
  request: Record<string, unknown>;
  /** Only meaningful against a co-located/in-process stub (see runSuite). */
  faultInjection?: 'failNextWin';
  expect: {
    ok: boolean;
    /** SUBSET match against the actual success response (only provided keys). */
    response?: Record<string, unknown>;
    /** Exact match against thrown WalletError.code. */
    errorCode?: string;
    /** Exact match against thrown WalletError.httpStatus. */
    httpStatus?: number;
    /** Exact match against the counted fetch attempts. */
    attempts?: number;
  };
}

export interface RunResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  attempts: number;
  detail?: string;
}

const VALID_ENDPOINTS: ReadonlySet<string> = new Set([
  'authenticate',
  'balance',
  'bet',
  'win',
  'rollback',
  'roundEnd',
]);

// ---------------------------------------------------------------------------
// Suite loading
// ---------------------------------------------------------------------------

/** Parse all `*.yaml` files in `dir` (each a YAML sequence of cases), flatten,
 *  and validate the shape of each case. Throws on a malformed case. */
export function loadSuite(dir: string): ConformanceCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const cases: ConformanceCase[] = [];
  for (const file of files) {
    const full = join(dir, file);
    const parsed = parseYaml(readFileSync(full, 'utf8'));
    if (parsed === null || parsed === undefined) continue; // empty file
    if (!Array.isArray(parsed)) {
      throw new Error(`Suite file ${file} must be a YAML sequence of cases`);
    }
    parsed.forEach((raw, i) => {
      cases.push(validateCase(raw, `${file}[${i}]`));
    });
  }
  return cases;
}

function validateCase(raw: unknown, where: string): ConformanceCase {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Case ${where} must be a mapping`);
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.name !== 'string' || c.name.length === 0) {
    throw new Error(`Case ${where} is missing a string "name"`);
  }
  if (typeof c.endpoint !== 'string' || !VALID_ENDPOINTS.has(c.endpoint)) {
    throw new Error(`Case "${c.name}" has invalid endpoint "${String(c.endpoint)}"`);
  }
  if (typeof c.request !== 'object' || c.request === null) {
    throw new Error(`Case "${c.name}" is missing a "request" mapping`);
  }
  if (typeof c.expect !== 'object' || c.expect === null) {
    throw new Error(`Case "${c.name}" is missing an "expect" mapping`);
  }
  const expect = c.expect as Record<string, unknown>;
  if (typeof expect.ok !== 'boolean') {
    throw new Error(`Case "${c.name}" expect.ok must be a boolean`);
  }
  if (c.faultInjection !== undefined && c.faultInjection !== 'failNextWin') {
    throw new Error(`Case "${c.name}" has unsupported faultInjection "${String(c.faultInjection)}"`);
  }

  return {
    name: c.name,
    endpoint: c.endpoint as ConformanceEndpoint,
    request: c.request as Record<string, unknown>,
    faultInjection: c.faultInjection as 'failNextWin' | undefined,
    expect: {
      ok: expect.ok,
      response: (expect.response as Record<string, unknown> | undefined) ?? undefined,
      errorCode: (expect.errorCode as string | undefined) ?? undefined,
      httpStatus: (expect.httpStatus as number | undefined) ?? undefined,
      attempts: (expect.attempts as number | undefined) ?? undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Operator builder
// ---------------------------------------------------------------------------

function buildOperator(opts: {
  baseUrl: string;
  signingKeyB64: string;
  apiKey: string;
  adapterName: OperatorAdapter;
}): Operator {
  const now = Math.floor(Date.now() / 1000);
  return {
    operatorId: opts.apiKey,
    name: 'conformance',
    walletBaseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    signingKey: Buffer.from(opts.signingKeyB64, 'base64'),
    adapter: opts.adapterName,
    currencies: ['EUR', 'USD', 'BTC'],
    minBetMinor: 10,
    maxBetMinor: 500000,
    rtpVariant: 97.0,
    jurisdictions: [],
    status: 'sandbox',
    shareBps: 1500,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Subset matching
// ---------------------------------------------------------------------------

/** Returns a mismatch description, or null if `expected` is a subset of `actual`. */
function subsetMismatch(
  expected: Record<string, unknown>,
  actual: unknown,
): string | null {
  if (typeof actual !== 'object' || actual === null) {
    return `expected an object response, got ${JSON.stringify(actual)}`;
  }
  const a = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const nested = subsetMismatch(v as Record<string, unknown>, a[k]);
      if (nested) return `${k}.${nested}`;
      continue;
    }
    if (a[k] !== v) {
      return `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(a[k])}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Suite runner
// ---------------------------------------------------------------------------

export interface RunSuiteOptions {
  baseUrl: string;
  signingKeyB64: string;
  apiKey: string;
  adapterName?: OperatorAdapter;
  cases: ConformanceCase[];
  /** Arm fault injection (only valid against a co-located/in-process stub).
   *  When false, fault-injection cases are skipped (cannot fault a remote). */
  armFaultInjection?: boolean;
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunResult[]> {
  const adapterName: OperatorAdapter = opts.adapterName ?? 'native';
  const operator = buildOperator({
    baseUrl: opts.baseUrl,
    signingKeyB64: opts.signingKeyB64,
    apiKey: opts.apiKey,
    adapterName,
  });

  // Per-case attempt counter incremented by the wrapped fetch impl. The
  // WalletClient calls fetchImpl once per HTTP attempt, so this exactly counts
  // retries (proving e.g. a 500 → retry → success becomes 2 attempts).
  let attemptCounter = 0;
  const countingFetch: typeof fetch = (input, init) => {
    attemptCounter += 1;
    return globalThis.fetch(input, init);
  };

  const client = new WalletClient(operator, {
    fetchImpl: countingFetch,
    sleep: () => Promise.resolve(), // no real backoff wait — deterministic & fast
    generateNonce: () => randomUUID(), // unique per request (stub rejects reuse)
    adapter: getAdapter(adapterName),
  });

  const results: RunResult[] = [];

  for (const c of opts.cases) {
    // Cannot inject a fault against a remote operator — record skip and move on.
    if (c.faultInjection && !opts.armFaultInjection) {
      results.push({
        name: c.name,
        status: 'skip',
        attempts: 0,
        detail: 'fault-injection case skipped (no co-located stub armed)',
      });
      continue;
    }

    attemptCounter = 0;

    // Arm the in-process stub's one-shot fault flag immediately before the call.
    if (c.faultInjection === 'failNextWin' && opts.armFaultInjection) {
      process.env.STUB_FAIL_NEXT_WIN = '1';
    }

    try {
      const response = await invoke(client, c);
      const detail = assertSuccess(c, response, attemptCounter);
      results.push({
        name: c.name,
        status: detail ? 'fail' : 'pass',
        attempts: attemptCounter,
        ...(detail ? { detail } : {}),
      });
    } catch (err) {
      const detail = assertFailure(c, err, attemptCounter);
      results.push({
        name: c.name,
        status: detail ? 'fail' : 'pass',
        attempts: attemptCounter,
        ...(detail ? { detail } : {}),
      });
    }
  }

  return results;
}

async function invoke(client: WalletClient, c: ConformanceCase): Promise<unknown> {
  const req = c.request;
  switch (c.endpoint) {
    case 'authenticate':
      return client.authenticate(req as unknown as AuthenticateRequest);
    case 'balance':
      return client.balance(req as unknown as BalanceRequest);
    case 'bet':
      return client.bet(req as unknown as BetRequest);
    case 'win':
      return client.win(req as unknown as WinRequest);
    case 'rollback':
      return client.rollback(req as unknown as RollbackRequest);
    case 'roundEnd':
      // Fire-and-forget: returns void, never throws on operator errors.
      await client.roundEnd(req as unknown as RoundEndRequest);
      return undefined;
  }
}

/** Returns a failure detail, or null if the success case matched expectations. */
function assertSuccess(
  c: ConformanceCase,
  response: unknown,
  attempts: number,
): string | null {
  if (c.expect.ok !== true) {
    return `expected failure (ok:false) but the call succeeded`;
  }
  if (c.expect.response) {
    const mismatch = subsetMismatch(c.expect.response, response);
    if (mismatch) return `response subset mismatch — ${mismatch}`;
  }
  if (c.expect.attempts !== undefined && c.expect.attempts !== attempts) {
    return `expected ${c.expect.attempts} attempt(s), counted ${attempts}`;
  }
  return null;
}

/** Returns a failure detail, or null if the thrown error matched expectations. */
function assertFailure(
  c: ConformanceCase,
  err: unknown,
  attempts: number,
): string | null {
  if (!(err instanceof WalletError)) {
    return `unexpected non-WalletError thrown: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (c.expect.ok !== false) {
    return `expected success (ok:true) but the call threw ${err.code} (HTTP ${err.httpStatus})`;
  }
  if (c.expect.errorCode !== undefined && c.expect.errorCode !== err.code) {
    return `expected errorCode ${c.expect.errorCode}, got ${err.code}`;
  }
  if (c.expect.httpStatus !== undefined && c.expect.httpStatus !== err.httpStatus) {
    return `expected httpStatus ${c.expect.httpStatus}, got ${err.httpStatus}`;
  }
  if (c.expect.attempts !== undefined && c.expect.attempts !== attempts) {
    return `expected ${c.expect.attempts} attempt(s), counted ${attempts}`;
  }
  return null;
}
