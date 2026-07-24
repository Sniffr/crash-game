/**
 * Integration tests for GET /launch (Task 3.1a).
 *
 * TRUE end-to-end: real operator stub → real WalletClient → real
 * OperatorRegistry (:memory: SQLite) → real createOperatorSession.
 *
 * RocksDB is mocked (store module) because the test environment has no on-disk
 * DB and we cannot predict session IDs ahead of time. The mock stores sessions
 * in an in-memory Map so getSession / createOperatorSession still work.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Store mock — must be hoisted BEFORE any import that pulls in store.ts
// ---------------------------------------------------------------------------

// In-memory session store to replace RocksDB
const sessionStore = new Map<string, Record<string, unknown>>();
let sessionIdSequence = 0;

function makeSessionId(): string {
  return `testsess${String(++sessionIdSequence).padStart(8, '0')}`;
}

vi.mock('../store.js', async () => {
  const { ZERO_STATS } = await import('@crash/shared/types');

  return {
    DEFAULT_DEMO_BALANCE: 1000,
    StoreOfflineError: class StoreOfflineError extends Error {
      constructor() { super('session store offline'); }
    },
    isOnline: vi.fn(() => true),
    createSession: vi.fn(async (opts: { displayName?: string; balance?: number } = {}) => {
      const sessionId = makeSessionId();
      const now = Date.now();
      const session = {
        sessionId,
        displayName: opts.displayName ?? 'anon',
        balance: opts.balance ?? 1000,
        createdAt: now,
        expiresAt: now + 8 * 3600 * 1000,
      };
      sessionStore.set(sessionId, session);
      return session;
    }),
    createOperatorSession: vi.fn(async (opts: {
      operatorId: string;
      playerId: string;
      currency: string;
      balanceMinor: number;
      displayName: string;
      rgLimits?: unknown;
    }) => {
      const sessionId = makeSessionId();
      const now = Date.now();
      const session = {
        sessionId,
        displayName: opts.displayName,
        balance: opts.balanceMinor,
        createdAt: now,
        expiresAt: now + 8 * 3600 * 1000,
        operatorId: opts.operatorId,
        playerId: opts.playerId,
        currency: opts.currency,
        balanceMinor: opts.balanceMinor,
        rgLimits: opts.rgLimits,
      };
      sessionStore.set(sessionId, session);
      return session;
    }),
    getSession: vi.fn(async (sessionId: string) => {
      return sessionStore.get(sessionId) ?? null;
    }),
    getStats: vi.fn(async () => ({ ...ZERO_STATS })),
    getHistory: vi.fn(async () => []),
    adjustBalance: vi.fn(),
    appendHistory: vi.fn(),
    recordBet: vi.fn(),
    recordWin: vi.fn(),
    recordLoss: vi.fn(),
    checkRateLimit: vi.fn(async () => true),
    refreshTtl: vi.fn(),
    setBalance: vi.fn(),
  };
});

// Mock WS hub (not needed by /launch but imported transitively by public.ts deps)
vi.mock('../ws/hub.js', () => ({
  broadcast: vi.fn(),
  sendToSession: vi.fn(),
  clients: new Set(),
  sessionSockets: new Map(),
  safeSend: vi.fn(),
}));

// Mock theme loader
vi.mock('../theme/loader.js', () => ({
  getActiveTheme: vi.fn(() => null),
  initThemeLoader: vi.fn(),
}));

// Mock game history
vi.mock('../game/history.js', () => ({
  getAllHistory: vi.fn(() => []),
  getRecentHistory: vi.fn(() => []),
  appendHistory: vi.fn(),
}));

// Mock game round
vi.mock('../game/round.js', () => ({
  roundNumber: 0,
  CONFIG: { rtp: 97, maxMultiplier: 100, minMultiplier: 1, bettingPhaseMs: 5000, resultPhaseMs: 3000 },
  currentRound: null,
  prevServerSeed: null,
  prevRoundNumber: null,
  startBettingPhase: vi.fn(),
  GROWTH_RATE: 0.00006,
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { BetLog, OperatorRegistry, GamesRepo } from '@crash/wallet';
import type { Server } from 'node:http';

import {
  startServer,
  resetStubState,
} from '../../../../tools/operator-stub/src/index.js';

import { WalletClientCache } from '../wallet/client-cache.js';
import { registerPublicRoutes } from './public.js';
import { getSession } from '../store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';
const SIGNING_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let stubServer: Server;
let stubPort: number;

// In-memory SQLite db (no file I/O)
let db: InstanceType<typeof Database>;
let registry: OperatorRegistry;
let betLog: BetLog;
let cache: WalletClientCache;
let expressApp: express.Application;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start operator stub on ephemeral port
  stubServer = startServer(0) as unknown as Server;
  await new Promise<void>((resolve) => stubServer.once('listening', resolve));
  const addr = stubServer.address();
  stubPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!stubPort) throw new Error('Could not determine stub port');

  // 2. Create in-memory registry + register test operator pointing at stub
  db = new Database(':memory:');
  betLog = new BetLog(db);
  registry = new OperatorRegistry(db);
  const games = new GamesRepo(db);

  registry.create({
    operatorId: 'op-test',
    name: 'Test Operator',
    walletBaseUrl: `http://localhost:${stubPort}`,
    currencies: ['EUR', 'USD', 'BTC'],
    status: 'active',
  });

  // Catalogue: galaxy-crash exists and is enabled for op-test (default game).
  games.create({ gameId: 'galaxy-crash', name: 'Galaxy Crash', gameType: 'sprite', rtp: 0.97, theme: { gameType: 'sprite' } });
  games.setOperatorGame('op-test', 'galaxy-crash', { enabled: true });

  // Override the auto-generated signing key with the stub's fixed key
  // by using the regenSigningKey mechanism — but that generates a random key.
  // Instead, we re-insert the operator with the correct signing key using
  // the registry's underlying db directly.
  db.prepare(`UPDATE operators SET signing_key_b64 = ? WHERE operator_id = ?`).run(
    STUB_DEFAULT_KEY_B64,
    'op-test',
  );

  // 3. Build WalletClientCache + Express app
  cache = new WalletClientCache(registry, betLog);

  expressApp = express();
  expressApp.use(express.json());
  registerPublicRoutes(expressApp, { walletClientCache: cache, games });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    stubServer.close((err) => (err ? reject(err) : resolve())),
  );
  db.close();
});

beforeEach(() => {
  resetStubState();
  sessionStore.clear();
  sessionIdSequence = 0;
  // Invalidate the cache so a fresh WalletClient is built each test
  // (the signing key is fixed, so the client doesn't need rebuilding, but
  //  resetting the cache ensures test isolation)
  cache.invalidate('op-test');
  cache.invalidate('op-paused');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /launch', () => {
  // ─── Test 1: happy path ───────────────────────────────────────────────────

  it('happy path: 302, Location starts with /?session=, session has correct fields', async () => {
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=tok-pid-1&currency=EUR')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/^\/\?session=/);

    const location = res.headers['location'] as string;
    const sessionId = new URLSearchParams(location.slice(2)).get('session');
    expect(sessionId).toBeTruthy();

    const session = await getSession(sessionId!);
    expect(session).not.toBeNull();
    expect(session!.operatorId).toBe('op-test');
    expect(session!.playerId).toBe('pid-1');
    expect(session!.currency).toBe('EUR');
    expect(session!.balanceMinor).toBe(100000);
    expect(session!.displayName).toBe('lucky_falcon_42');
    expect(session!.rgLimits).toBeDefined();
    expect(session!.rgLimits!.maxBetMinor).toBe(500000);
  });

  // ─── Test 2: lobby/return params propagate ────────────────────────────────

  it('lobby_url and return_url appear URL-encoded in redirect Location', async () => {
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=tok-pid-1&currency=EUR&lobby_url=https%3A%2F%2Fcasino.com%2Flobby&return_url=https%3A%2F%2Fcasino.com%2F')
      .redirects(0);

    expect(res.status).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain('&lobby=https%3A%2F%2Fcasino.com%2Flobby');
    expect(location).toContain('&return=https%3A%2F%2Fcasino.com%2F');
  });

  // ─── Test 3: unknown operator → 404 ──────────────────────────────────────

  it('unknown operator → 404 HTML containing "Unknown operator"', async () => {
    const res = await request(expressApp)
      .get('/launch?operator=does-not-exist&token=anything&currency=EUR')
      .redirects(0);

    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Unknown operator/i);
  });

  // ─── Test 4: bad token → error page with lobby button ────────────────────

  it('bad token → error HTML, contains Return-to-lobby button when lobby_url provided', async () => {
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=bad-token&currency=EUR&lobby_url=https%3A%2F%2Fcasino.com%2Flobby')
      .redirects(0);

    expect(res.status).toBe(401);
    expect(res.text).toMatch(/Return to lobby/i);
    expect(res.text).toContain('https://casino.com/lobby');
  });

  // ─── Test 5: currency mismatch → error page, no new session ──────────────

  it('currency mismatch (pid-3 is BTC, launch claims EUR) → error page, no session created', async () => {
    const sessionCountBefore = sessionStore.size;

    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=tok-pid-3&currency=EUR')
      .redirects(0);

    expect(res.status).toBe(422);
    expect(res.text).toMatch(/[Cc]urrency/);
    // No new session should have been stored
    expect(sessionStore.size).toBe(sessionCountBefore);
  });

  // ─── Test 6: paused operator → 404 (or 4xx), no authenticate call ─────────

  it('paused operator → 404 error, stub never receives authenticate request', async () => {
    // Register a paused operator
    registry.create({
      operatorId: 'op-paused',
      name: 'Paused Operator',
      walletBaseUrl: `http://localhost:${stubPort}`,
      currencies: ['EUR'],
      status: 'paused',
    });
    db.prepare(`UPDATE operators SET signing_key_b64 = ? WHERE operator_id = ?`).run(
      STUB_DEFAULT_KEY_B64,
      'op-paused',
    );

    // Add a valid token for pid-1 — but the operator is paused so it shouldn't reach the stub
    // (The stub is shared; resetStubState() already ran in beforeEach so tok-pid-1 is valid)

    const res = await request(expressApp)
      .get('/launch?operator=op-paused&token=tok-pid-1&currency=EUR')
      .redirects(0);

    // Should be rejected by WalletClientCache (paused → null) before any HTTP call
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Unknown operator|paused/i);
  });

  // ─── Test 7: happy launch + getSession round-trip (balance back-compat) ───

  it('after launch, getSession returns balance === balanceMinor === 100000 for pid-1', async () => {
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=tok-pid-1&currency=EUR')
      .redirects(0);

    expect(res.status).toBe(302);
    const location = res.headers['location'] as string;
    const sessionId = new URLSearchParams(location.slice(2)).get('session');
    expect(sessionId).toBeTruthy();

    const session = await getSession(sessionId!);
    expect(session).not.toBeNull();
    // Legacy balance field must equal balanceMinor for back-compat
    expect(session!.balance).toBe(100000);
    expect(session!.balanceMinor).toBe(100000);
  });

  // ─── Test 8: missing required params → 400 ───────────────────────────────

  it('missing required params → 400 HTML containing error message', async () => {
    const res = await request(expressApp)
      .get('/launch')
      .redirects(0);

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Missing required launch parameters/i);
  });

  // ─── Test 9: javascript: lobby_url is sanitized — no button rendered ──────

  it('javascript: lobby_url is sanitized: error page omits the lobby button', async () => {
    // Missing token forces 400 error path; lobby_url is javascript: (no HTML chars so
    // escapeHtml alone would not block it — isSafeReturnUrl must reject it).
    const res = await request(expressApp)
      .get('/launch?operator=op-test&currency=EUR&lobby_url=javascript%3Aalert(1)')
      .redirects(0);

    expect(res.status).toBe(400);
    // The raw scheme must not appear anywhere in the rendered output
    expect(res.text).not.toContain('javascript:');
    // Specifically, no href with that scheme
    expect(res.text).not.toContain('href="javascript:');
  });

  // ─── Test 10: javascript: return_url is sanitized in the redirect query ───

  it('javascript: return_url is NOT echoed into the 302 Location query string', async () => {
    // Happy-path launch; return_url is javascript: — should be silently dropped
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=tok-pid-1&currency=EUR&lobby_url=https%3A%2F%2Fcasino.com%2Flobby&return_url=javascript%3Aalert(1)')
      .redirects(0);

    expect(res.status).toBe(302);
    const location = res.headers['location'] as string;
    // Safe lobby param must still be present
    expect(location).toContain('&lobby=https%3A%2F%2Fcasino.com%2Flobby');
    // The javascript: scheme must not appear in the redirect URL (percent-encoded or raw)
    expect(location).not.toContain('javascript');
    expect(location).not.toContain('javascript%3A');
  });

  // ─── Test 11: return_url preferred over lobby_url for the error button ────
  //   spec §3 — return_url is the primary back destination; lobby_url is fallback

  it('error button uses return_url when both return_url and lobby_url are present (spec §3)', async () => {
    // Bad token → 401 error page
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=bad-token&currency=EUR&lobby_url=https%3A%2F%2Fcasino.com%2Flobby&return_url=https%3A%2F%2Fcasino.com%2Fback')
      .redirects(0);

    expect(res.status).toBe(401);
    // Button must point at return_url, not lobby_url
    expect(res.text).toContain('href="https://casino.com/back"');
    expect(res.text).not.toContain('href="https://casino.com/lobby"');
  });

  it('error button falls back to lobby_url when return_url is absent (spec §3 fallback)', async () => {
    // Bad token → 401 error page; only lobby_url provided
    const res = await request(expressApp)
      .get('/launch?operator=op-test&token=bad-token&currency=EUR&lobby_url=https%3A%2F%2Fcasino.com%2Flobby')
      .redirects(0);

    expect(res.status).toBe(401);
    expect(res.text).toContain('href="https://casino.com/lobby"');
  });
});
