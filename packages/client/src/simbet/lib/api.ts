/**
 * Fetch wrapper for the SimBet API. Every error comes back as an ApiError with
 * the server's `{error: {code, message}}` unpacked, so screens can branch on
 * `code` and show `message` as-is (the server writes player-facing copy).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The full `error` object, e.g. `until` on SELF_EXCLUDED, `resendInSec` on PHONE_NOT_VERIFIED. */
    readonly details: Record<string, unknown> = {},
    /** The whole response body, for endpoints that return data alongside an error. */
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** Codes meaning the signed-in session can't continue: sign the player out. */
const SESSION_ENDING = new Set(['INVALID_JWT', 'SESSION_REVOKED', 'SELF_EXCLUDED', 'ACCOUNT_DEACTIVATED']);

let getToken: () => string | null = () => null;
let onSessionEnded: (err: ApiError) => void = () => {};

export function configureApi(opts: { getToken: () => string | null; onSessionEnded: (err: ApiError) => void }): void {
  getToken = opts.getToken;
  onSessionEnded = opts.onSessionEnded;
}

export async function api<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; auth?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = opts.auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Network error — check your connection and try again.');
  }

  const body = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
  if (!res.ok) {
    const error = (body?.error ?? {}) as Record<string, unknown>;
    const err = new ApiError(
      res.status,
      typeof error.code === 'string' ? error.code : `HTTP_${res.status}`,
      typeof error.message === 'string' ? error.message : 'Something went wrong — please try again.',
      error,
      body,
    );
    if (token && SESSION_ENDING.has(err.code)) onSessionEnded(err);
    throw err;
  }
  return body as T;
}
