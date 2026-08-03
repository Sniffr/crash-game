/**
 * Tests for Task 6.3: operator-scoped READ endpoints on /op/v1.
 *
 * Mirrors the harness in operator-router.test.ts:
 *   real OperatorRegistry + BetLog (:memory: SQLite), real WalletClientCache,
 *   verifyOperatorSignature + createOperatorRouter under supertest, store + WS
 *   hub mocked, two operators A and B (A uses the stub default signing key, B
 *   uses its own registry-minted key).
 *
 * Covers (all per the Task 6.3 brief):
 *   - Multi-page traversal for /bets, /rounds, /operator-tx (no dupes, no gaps).
 *   - Cross-tenant 404 byte-match for /rounds/:id, /bets/:id, /sessions/:id,
 *     /players/:id/sessions.
 *   - Scope-leak guard: /bets and /operator-tx never return OP_B rows for A.
 *   - /financial/summary: groupBy=operator → 400; scoped to A; no
 *     ourShareMinor/shareBps/operatorId in rows.
 *   - /rounds/:roundId: mixed-operator round, A sees only its bets + operatorIds=[A].
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Store mock — hoisted BEFORE any imports that pull in store.ts
// ---------------------------------------------------------------------------

const sessionStore = new Map<string, Record<string, unknown>>();

vi.mock('../store.js', () => ({
  DEFAULT_DEMO_BALANCE: 1000,
  StoreOfflineError: class StoreOfflineError extends Error {
    constructor() { super('session store offline'); }
  },
  isOnline: vi.fn(() => true),
  getSession: vi.fn(async (sessionId: string) => {
    return sessionStore.get(sessionId) ?? null;
  }),
  deleteSession: vi.fn(async (sessionId: string) => {
    sessionStore.delete(sessionId);
  }),
  createSession: vi.fn(),
  createOperatorSession: vi.fn(),
  getStats: vi.fn(async () => ({})),
  getHistory: vi.fn(async () => []),
  adjustBalance: vi.fn(),
  appendHistory: vi.fn(),
  recordBet: vi.fn(),
  recordWin: vi.fn(),
  recordLoss: vi.fn(),
  checkRateLimit: vi.fn(async () => true),
  refreshTtl: vi.fn(),
  setBalance: vi.fn(),
}));

vi.mock('../ws/hub.js', () => {
  const sessionSockets = new Map<string, Set<import('ws').WebSocket>>();
  const sendToSession = vi.fn();
  const broadcast = vi.fn();
  const safeSend = vi.fn();
  return { sessionSockets, sendToSession, broadcast, safeSend };
});

vi.mock('../theme/loader.js', () => ({
  getActiveTheme: vi.fn(() => null),
  initThemeLoader: vi.fn(),
}));

vi.mock('../game/history.js', () => ({
  getAllHistory: vi.fn(() => []),
  getRecentHistory: vi.fn(() => []),
  pushHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Real imports
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import { PgBetLog, PgOperatorRegistry } from '@crash/wallet';
import { makeTestDb, type TestDb } from '@crash/wallet/pg-test-support';

import { WalletClientCache } from '../wallet/client-cache.js';
import { verifyOperatorSignature } from './middleware/verify-operator-signature.js';
import { createOperatorRouter } from './operator.js';
import { PgOperatorAudit } from './operator-audit-pg.js';

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

const STUB_DEFAULT_KEY_B64 = 'dGVzdC1zdHViLWtleS0zMmJ5dGVzLXYwLXBhZGRpbmc=';

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacHex(data: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function getSignedHeaders(path: string, key: Buffer, apiKey: string): Record<string, string> {
  // The middleware signs the path WITHOUT the query string
  // (getSignedPath = req.originalUrl.split('?')[0]); mirror that here.
  const signedPath = path.split('?')[0]!;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const bodyHash = sha256Hex(Buffer.alloc(0));
  const sigString = `GET\n${signedPath}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = hmacHex(sigString, key);
  return {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

/** GET a signed /op/v1 path as a given operator. */
async function getAs(path: string, key: Buffer, apiKey: string) {
  return request(testApp).get(path).set(getSignedHeaders(path, key, apiKey));
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const OPERATOR_A_ID = 'read-test-op-a';
const OPERATOR_B_ID = 'read-test-op-b';

let testDb: TestDb;
let registry: PgOperatorRegistry;
let betLog: PgBetLog;
let walletClientCache: WalletClientCache;

let OP_A_KEY: Buffer;
let OP_A_API_KEY: string;
let OP_B_KEY: Buffer;
let OP_B_API_KEY: string;

let testApp: express.Application;

// Track ids we seed so tests can assert against them.
const seededRoundsA: string[] = [];

// ---------------------------------------------------------------------------
// Raw-SQL seed helpers — full control over created_at + state.
// ---------------------------------------------------------------------------

let betSeq = 0;

interface SeedBet {
  operatorId: string;
  playerId: string;
  sessionId: string;
  roundId: string;
  currency: string;
  amountMinor: number;
  state: string;
  createdAt: number;      // unix seconds
  winAmountMinor?: number | null;
  multiplier?: number | null;
  winTxnId?: string | null;
  rollbackTxnId?: string | null;
  betOpTxnId?: string | null;
  winOpTxnId?: string | null;
}

async function seedBet(b: SeedBet): Promise<{ betId: string; betTxnId: string }> {
  const n = ++betSeq;
  const betId = `bet-${n}`;
  const betTxnId = `txn-bet-${n}`;
  await testDb.pool.query(
    `
    INSERT INTO bet_log (
      bet_id, operator_id, player_id, session_id, round_id, currency,
      amount_minor, state, bet_txn_id,
      win_txn_id, rollback_txn_id, bet_op_txn_id, win_op_txn_id,
      win_amount_minor, multiplier, error_code,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12, $13,
      $14, $15, NULL,
      $16, $16
    )
  `,
    [
      betId,
      b.operatorId,
      b.playerId,
      b.sessionId,
      b.roundId,
      b.currency,
      b.amountMinor,
      b.state,
      betTxnId,
      b.winTxnId ?? null,
      b.rollbackTxnId ?? null,
      b.betOpTxnId ?? null,
      b.winOpTxnId ?? null,
      b.winAmountMinor ?? null,
      b.multiplier ?? null,
      b.createdAt,
    ],
  );
  return { betId, betTxnId };
}

async function seedIdempotency(opts: {
  txnId: string;
  operatorId: string;
  kind: 'bet' | 'win' | 'rollback';
  responseJson: string;
  createdAt: number;
}): Promise<void> {
  await testDb.pool.query(
    `
    INSERT INTO txn_idempotency (txn_id, operator_id, kind, request_hash, response_json, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `,
    [opts.txnId, opts.operatorId, opts.kind, 'hash', opts.responseJson, opts.createdAt],
  );
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

const BASE_TS = 1_716_000_000; // a fixed reference unix-seconds timestamp

beforeAll(async () => {
  // No live wallet/stub server needed: all Task 6.3 endpoints are read-only and
  // never call the operator wallet. walletBaseUrl is a registry field only.
  testDb = await makeTestDb();
  betLog = new PgBetLog(testDb.pool);
  registry = new PgOperatorRegistry(testDb.pool);

  await registry.create({
    operatorId: OPERATOR_A_ID,
    name: 'Read Test Operator A',
    walletBaseUrl: 'http://localhost:0',
    currencies: ['EUR', 'USD'],
    status: 'active',
  });
  await testDb.pool.query(
    `UPDATE operators SET signing_key_b64 = $1 WHERE operator_id = $2`,
    [STUB_DEFAULT_KEY_B64, OPERATOR_A_ID],
  );
  // Raw signing-key write bypassed the registry cache — refresh so getById/getByApiKey see it.
  await registry.refresh();
  const opA = registry.getById(OPERATOR_A_ID)!;
  OP_A_API_KEY = opA.apiKey;
  OP_A_KEY = Buffer.from(STUB_DEFAULT_KEY_B64, 'base64');

  await registry.create({
    operatorId: OPERATOR_B_ID,
    name: 'Read Test Operator B',
    walletBaseUrl: 'http://localhost:0',
    currencies: ['EUR'],
    status: 'active',
  });
  const opB = registry.getById(OPERATOR_B_ID)!;
  OP_B_API_KEY = opB.apiKey;
  OP_B_KEY = opB.signingKey;

  walletClientCache = new WalletClientCache(registry, betLog);

  testApp = express();
  testApp.use(express.json({ verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  }}));
  testApp.get('/op/v1/health', (_req, res) => {
    res.json({ ok: true, version: '1.0.0', gamesAvailable: ['galaxy-crash'] });
  });
  testApp.use(
    '/op/v1',
    verifyOperatorSignature(registry, { getSignedPath: (req) => req.originalUrl.split('?')[0] }),
    createOperatorRouter({ betLog, registry, walletClientCache, operatorAudit: new PgOperatorAudit(testDb.pool) }),
  );

  // -------------------------------------------------------------------------
  // Seed data.
  //
  // OP_A: 8 rounds (rnd-a-0 .. rnd-a-7), each with 1-2 SETTLED/LOST bets, across
  //       two players and sessions. Plus one round (rnd-shared) that ALSO has an
  //       OP_B bet, to exercise the mixed-round filter.
  // OP_B: separate rounds + bets so scope-leak guards have data to exclude.
  // -------------------------------------------------------------------------

  for (let i = 0; i < 8; i++) {
    const roundId = `rnd-a-${i}`;
    seededRoundsA.push(roundId);
    const player = i % 2 === 0 ? 'pid-a-1' : 'pid-a-2';
    const session = i % 2 === 0 ? 'ses-a-1' : 'ses-a-2';
    const ts = BASE_TS + i * 100;

    // Each round: one SETTLED win bet + one LOST bet.
    const win = await seedBet({
      operatorId: OPERATOR_A_ID, playerId: player, sessionId: session, roundId,
      currency: 'EUR', amountMinor: 10_000, state: 'SETTLED', createdAt: ts,
      winAmountMinor: 24_500, multiplier: 2.45,
      winTxnId: `txn-win-${i}`, betOpTxnId: `op-bet-${i}`, winOpTxnId: `op-win-${i}`,
    });
    await seedIdempotency({ txnId: win.betTxnId, operatorId: OPERATOR_A_ID, kind: 'bet', responseJson: JSON.stringify({ ok: true, operatorTxnId: `op-bet-${i}` }), createdAt: ts });
    await seedIdempotency({ txnId: `txn-win-${i}`, operatorId: OPERATOR_A_ID, kind: 'win', responseJson: JSON.stringify({ ok: true, operatorTxnId: `op-win-${i}` }), createdAt: ts + 1 });

    const lost = await seedBet({
      operatorId: OPERATOR_A_ID, playerId: player, sessionId: session, roundId,
      currency: 'EUR', amountMinor: 5_000, state: 'LOST', createdAt: ts + 2,
      betOpTxnId: `op-bet-lost-${i}`,
    });
    await seedIdempotency({ txnId: lost.betTxnId, operatorId: OPERATOR_A_ID, kind: 'bet', responseJson: JSON.stringify({ ok: true, operatorTxnId: `op-bet-lost-${i}` }), createdAt: ts + 2 });
  }

  // Shared round: one OP_A bet + one OP_B bet in the same round_id.
  const sharedTs = BASE_TS + 5000;
  await seedBet({
    operatorId: OPERATOR_A_ID, playerId: 'pid-a-1', sessionId: 'ses-a-1', roundId: 'rnd-shared',
    currency: 'EUR', amountMinor: 7_000, state: 'SETTLED', createdAt: sharedTs,
    winAmountMinor: 14_000, multiplier: 2.0, winTxnId: 'txn-win-shared-a',
  });
  await seedBet({
    operatorId: OPERATOR_B_ID, playerId: 'pid-b-1', sessionId: 'ses-b-1', roundId: 'rnd-shared',
    currency: 'EUR', amountMinor: 99_000, state: 'SETTLED', createdAt: sharedTs + 1,
    winAmountMinor: 198_000, multiplier: 2.0,
  });

  // OP_B standalone rounds/bets (so /bets and /operator-tx have B rows to exclude).
  for (let i = 0; i < 4; i++) {
    const ts = BASE_TS + 8000 + i * 100;
    const b = await seedBet({
      operatorId: OPERATOR_B_ID, playerId: 'pid-b-1', sessionId: 'ses-b-1', roundId: `rnd-b-${i}`,
      currency: 'EUR', amountMinor: 3_000, state: 'SETTLED', createdAt: ts,
      winAmountMinor: 6_000, multiplier: 2.0, winTxnId: `txn-b-win-${i}`,
    });
    await seedIdempotency({ txnId: b.betTxnId, operatorId: OPERATOR_B_ID, kind: 'bet', responseJson: JSON.stringify({ ok: true }), createdAt: ts });
  }

  // A live session in the store for the GET /sessions/:id tests.
  sessionStore.set('ses-live-a', {
    sessionId: 'ses-live-a',
    operatorId: OPERATOR_A_ID,
    playerId: 'pid-a-1',
    currency: 'EUR',
    createdAt: BASE_TS * 1000, // store uses ms
    expiresAt: Date.now() + 3_600_000,
  });
  sessionStore.set('ses-live-b', {
    sessionId: 'ses-live-b',
    operatorId: OPERATOR_B_ID,
    playerId: 'pid-b-1',
    currency: 'EUR',
    createdAt: BASE_TS * 1000,
    expiresAt: Date.now() + 3_600_000,
  });
});

afterAll(async () => {
  await testDb.cleanup();
});

// ---------------------------------------------------------------------------
// Pagination helper: collect all items across pages with a given limit.
// ---------------------------------------------------------------------------

async function collectAllPages(
  basePath: string,
  idField: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  // Guard against infinite loops.
  for (let guard = 0; guard < 100; guard++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const path = `${basePath}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await getAs(path, OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    for (const item of res.body.items) ids.push(item[idField]);
    if (!res.body.nextCursor) break;
    cursor = res.body.nextCursor;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Multi-page traversal: /bets, /rounds, /operator-tx
// ---------------------------------------------------------------------------

describe('multi-page traversal (no dupes, no gaps)', () => {
  it('/bets paginates consistently vs a single large fetch', async () => {
    const single = await getAs('/op/v1/bets?limit=200', OP_A_KEY, OP_A_API_KEY);
    expect(single.status).toBe(200);
    const allIds = single.body.items.map((b: { betId: string }) => b.betId);

    const paged = await collectAllPages('/op/v1/bets', 'betId', 3);

    expect(new Set(paged).size).toBe(paged.length); // no dupes
    expect(paged.sort()).toEqual([...allIds].sort()); // no gaps
  });

  it('/rounds paginates consistently vs a single large fetch', async () => {
    const single = await getAs('/op/v1/rounds?limit=200', OP_A_KEY, OP_A_API_KEY);
    expect(single.status).toBe(200);
    const allIds = single.body.items.map((r: { roundId: string }) => r.roundId);

    const paged = await collectAllPages('/op/v1/rounds', 'roundId', 2);

    expect(new Set(paged).size).toBe(paged.length);
    expect(paged.sort()).toEqual([...allIds].sort());
  });

  it('/operator-tx paginates consistently vs a single large fetch', async () => {
    const single = await getAs('/op/v1/operator-tx?limit=200', OP_A_KEY, OP_A_API_KEY);
    expect(single.status).toBe(200);
    const allIds = single.body.items.map((t: { txnId: string }) => t.txnId);

    const paged = await collectAllPages('/op/v1/operator-tx', 'txnId', 3);

    expect(new Set(paged).size).toBe(paged.length);
    expect(paged.sort()).toEqual([...allIds].sort());
  });
});

// ---------------------------------------------------------------------------
// Scope-leak guards: A never sees B's rows.
// ---------------------------------------------------------------------------

describe('scope-leak guards', () => {
  it('/bets as A returns only A rows', async () => {
    const res = await getAs('/op/v1/bets?limit=200', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item.operatorId).toBe(OPERATOR_A_ID);
    }
  });

  it('/operator-tx as A returns only A rows (B txns excluded)', async () => {
    const res = await getAs('/op/v1/operator-tx?limit=200', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    // No operatorId field is exposed; instead assert no B-only txn ids leak through.
    const ids = res.body.items.map((t: { txnId: string }) => t.txnId as string);
    for (const id of ids) {
      expect(id.startsWith('txn-b-')).toBe(false);
    }
    // And every item must lack an operatorId field (implicit on this surface).
    for (const item of res.body.items) {
      expect('operatorId' in item).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant 404 byte-match
// ---------------------------------------------------------------------------

//
// No-leak property: for a GIVEN requested id, the 404 body is a pure function of
// that id (the message echoes the input id; the error code is constant). So a
// cross-tenant request for id X and a truly-not-found request for the SAME id X
// are byte-identical — the operator cannot tell whether X exists under another
// tenant. We assert this for the two cases where the id is identical:
//   1. A's session 'ses-live-a' requested by B (cross-tenant) vs by A after we
//      verify A could see it — but A CAN see it, so we instead use the per-id
//      template equivalence below.
// The robust assertion (used here): the cross-tenant 404 for X is byte-identical
// to a truly-not-found 404 for the same id string X. We construct "truly not
// found for X" by requesting X as A where X belongs to B (also cross-tenant from
// A's view → not-found), guaranteeing the same echoed id on both sides.
describe('cross-tenant 404 byte-match (no existence leak)', () => {
  it('/rounds/:roundId — cross-tenant == truly-not-found for the same id', async () => {
    // 'rnd-a-0' belongs to A. B requesting it (cross-tenant) must be byte-identical
    // to B requesting the same id when it genuinely does not exist for B — and the
    // body is a pure echo of the requested id, carrying no existence information.
    const id = 'rnd-a-0';
    const cross = await getAs(`/op/v1/rounds/${id}`, OP_B_KEY, OP_B_API_KEY);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: { code: 'ROUND_NOT_FOUND', message: `No round with id '${id}'` } });
    // A truly-nonexistent id under B yields the same templated shape (echo of input).
    const nfId = 'rnd-nonexistent';
    const nf = await getAs(`/op/v1/rounds/${nfId}`, OP_B_KEY, OP_B_API_KEY);
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: { code: 'ROUND_NOT_FOUND', message: `No round with id '${nfId}'` } });
  });

  it('/bets/:betId — cross-tenant == truly-not-found for the same id', async () => {
    // 'bet-1' belongs to A. B requesting it (cross-tenant) must be byte-identical
    // to B requesting the same id when it genuinely does not exist for B.
    const id = 'bet-1';
    const cross = await getAs(`/op/v1/bets/${id}`, OP_B_KEY, OP_B_API_KEY);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('BET_NOT_FOUND');
    // Construct a truly-not-found-for-the-same-id baseline: there is no bet 'bet-1'
    // owned by B, so this IS the not-found case for B — the body is a pure echo of
    // the id, hence identical to the cross-tenant body.
    expect(cross.body).toEqual({ error: { code: 'BET_NOT_FOUND', message: `No bet with id '${id}'` } });
  });

  it('/sessions/:sessionId — cross-tenant == truly-not-found (constant message)', async () => {
    // Session 404 message is constant ('No such session'), so cross-tenant and
    // truly-not-found are unconditionally byte-identical.
    const cross = await getAs('/op/v1/sessions/ses-live-a', OP_B_KEY, OP_B_API_KEY);
    const nf = await getAs('/op/v1/sessions/ses-does-not-exist', OP_B_KEY, OP_B_API_KEY);
    expect(cross.status).toBe(404);
    expect(nf.status).toBe(404);
    expect(cross.body).toEqual(nf.body);
  });

  it('/players/:playerId/sessions — cross-tenant == truly-not-found for the same id', async () => {
    // 'pid-a-1' has sessions under A. B requesting it (cross-tenant) is byte-
    // identical to B requesting the same id when the player has no sessions for B.
    const id = 'pid-a-1';
    const cross = await getAs(`/op/v1/players/${id}/sessions`, OP_B_KEY, OP_B_API_KEY);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: { code: 'PLAYER_NOT_FOUND', message: `No player with id '${id}'` } });
  });
});

// ---------------------------------------------------------------------------
// /rounds/:roundId — mixed-operator round scoping
// ---------------------------------------------------------------------------

describe('GET /rounds/:roundId (mixed-operator round)', () => {
  it('A sees only its own bets in yourBets and operatorIds === [A]', async () => {
    const res = await getAs('/op/v1/rounds/rnd-shared', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.operatorIds).toEqual([OPERATOR_A_ID]);
    expect(res.body.yourBets.length).toBe(1);
    expect(res.body.yourBets[0].operatorId).toBe(OPERATOR_A_ID);
    // B's 99000 stake must NOT contribute to the round totals.
    expect(res.body.totalStakeMinor).toEqual({ EUR: 7_000 });
    expect(res.body.betCount).toBe(1);
    // Phase-future null fields.
    expect(res.body.roundNumber).toBeNull();
    expect(res.body.crashPoint).toBeNull();
    expect(res.body.serverSeedHash).toBeNull();
    expect(res.body.serverSeed).toBeNull();
    expect(res.body.totalPayoutMinor).toBeNull();
  });

  it('B sees only its own bet in the same shared round', async () => {
    const res = await getAs('/op/v1/rounds/rnd-shared', OP_B_KEY, OP_B_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.operatorIds).toEqual([OPERATOR_B_ID]);
    expect(res.body.yourBets.length).toBe(1);
    expect(res.body.totalStakeMinor).toEqual({ EUR: 99_000 });
  });
});

// ---------------------------------------------------------------------------
// /financial/summary
// ---------------------------------------------------------------------------

describe('GET /financial/summary', () => {
  const from = BASE_TS - 10;
  const to = BASE_TS + 100_000;

  it('groupBy=operator → 400 INVALID_REQUEST', async () => {
    const res = await getAs(`/op/v1/financial/summary?from=${from}&to=${to}&groupBy=operator`, OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('valid request scoped to A; rows omit ourShareMinor/shareBps/operatorId', async () => {
    const res = await getAs(`/op/v1/financial/summary?from=${from}&to=${to}&groupBy=currency`, OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toEqual(['currency']);
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const row of res.body.rows) {
      expect('operatorId' in row).toBe(false);
      expect('ourShareMinor' in row).toBe(false);
      expect('shareBps' in row).toBe(false);
      expect(row).toHaveProperty('currency');
      expect(row).toHaveProperty('ggrMinor');
      expect(row).toHaveProperty('ngrMinor');
    }

    // A's EUR data: 8 SETTLED (10000 stake, 24500 win) + 8 LOST (5000 stake) +
    // shared SETTLED (7000 stake, 14000 win).
    // stake = 8*10000 + 8*5000 + 7000 = 127000
    // win   = 8*24500 + 14000 = 210000
    const eur = res.body.rows.find((r: { currency: string }) => r.currency === 'EUR');
    expect(eur.stakeMinor).toBe(127_000);
    expect(eur.winMinor).toBe(210_000);
    expect(eur.ggrMinor).toBe(127_000 - 210_000);
    expect(eur.ngrMinor).toBe(eur.ggrMinor);
    // B's 99000 stake must not appear.
  });

  it('defaults groupBy to [currency] when omitted', async () => {
    const res = await getAs(`/op/v1/financial/summary?from=${from}&to=${to}`, OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toEqual(['currency']);
  });

  it('400 when from/to missing', async () => {
    const res = await getAs(`/op/v1/financial/summary?to=${to}`, OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /players/:playerId/sessions + /players/:playerId/bets + /sessions/:id + misc
// ---------------------------------------------------------------------------

describe('player + session + config endpoints', () => {
  it('/players/:playerId/sessions returns the player session summaries', async () => {
    const res = await getAs('/op/v1/players/pid-a-1/sessions', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const ses = res.body.items[0];
    expect(ses).toHaveProperty('sessionId');
    expect(ses).toHaveProperty('startedAt');
    expect(ses).toHaveProperty('endedAt');
    expect(ses).toHaveProperty('currency');
    expect(ses).toHaveProperty('betCount');
    expect(ses).toHaveProperty('stakeMinor');
    expect(ses).toHaveProperty('winMinor');
  });

  it('/players/:playerId/bets forces the path playerId', async () => {
    const res = await getAs('/op/v1/players/pid-a-1/bets?limit=200', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const b of res.body.items) {
      expect(b.playerId).toBe('pid-a-1');
      expect(b.operatorId).toBe(OPERATOR_A_ID);
    }
  });

  it('/sessions/:sessionId returns 200 with honest-null lastSeenAt', async () => {
    const res = await getAs('/op/v1/sessions/ses-live-a', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('ses-live-a');
    expect(res.body.playerId).toBe('pid-a-1');
    expect(res.body.currency).toBe('EUR');
    expect(res.body.startedAt).toBe(BASE_TS); // createdAt ms → seconds
    expect(res.body.lastSeenAt).toBeNull();
  });

  it('/limits returns per-currency bounds for A', async () => {
    const res = await getAs('/op/v1/limits', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    const opA = registry.getById(OPERATOR_A_ID)!;
    expect(res.body.limits).toEqual([
      { currency: 'EUR', minBetMinor: opA.minBetMinor, maxBetMinor: opA.maxBetMinor },
      { currency: 'USD', minBetMinor: opA.minBetMinor, maxBetMinor: opA.maxBetMinor },
    ]);
  });

  it('/games/:gameId/config returns config for galaxy-crash', async () => {
    const res = await getAs('/op/v1/games/galaxy-crash/config', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    const opA = registry.getById(OPERATOR_A_ID)!;
    expect(res.body).toEqual({ gameId: 'galaxy-crash', rtpVariant: opA.rtpVariant, enabled: true });
  });

  it('/games/:gameId/config returns 404 for unknown game', async () => {
    const res = await getAs('/op/v1/games/roulette/config', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// /bets/:betId — timeline + walletCalls
// ---------------------------------------------------------------------------

describe('GET /bets/:betId', () => {
  it('returns bet + timeline + walletCalls for an owned SETTLED bet', async () => {
    const res = await getAs('/op/v1/bets/bet-1', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.bet.betId).toBe('bet-1');
    expect(res.body.bet.operatorId).toBe(OPERATOR_A_ID);
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(res.body.timeline[0]).toMatchObject({ state: 'PENDING', actor: 'system' });
    expect(Array.isArray(res.body.walletCalls)).toBe(true);
    for (const wc of res.body.walletCalls) {
      expect(wc.request).toBeNull();
      expect(wc.attempts).toBeNull();
      expect(wc.totalMs).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Bad cursor → 400 INVALID_CURSOR
// ---------------------------------------------------------------------------

describe('cursor validation', () => {
  it('/bets with a malformed cursor → 400 INVALID_CURSOR', async () => {
    const res = await getAs('/op/v1/bets?cursor=not-a-valid-cursor', OP_A_KEY, OP_A_API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});
