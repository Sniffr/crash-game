/**
 * RocksDB-backed session store for Galaxy Crash.
 *
 * Embedded — no separate server, no docker. Data lives on disk at
 * ROCKSDB_PATH (default ./data/rocksdb relative to repo root).
 *
 * Keys:
 *   session:<id>             Session JSON
 *   session:<id>:stats       SessionStats JSON
 *   session:<id>:history     HistoryEntry[] JSON (newest first, trimmed to HISTORY_LIMIT)
 *
 * Sessions carry their own `expiresAt`; we expire lazily on read.
 * Rate-limit tokens live in-process (not persisted) since they reset every
 * minute and lose nothing on restart.
 *
 * RocksDB only allows ONE process to hold the database lock at a time, so
 * we serialize per-session read-modify-write through an async lock map to
 * avoid lost updates inside this process.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rocksdb from 'rocksdb';
import levelup, { type LevelUp } from 'levelup';
import encoding from 'encoding-down';
import { customAlphabet } from 'nanoid';
import type { HistoryEntry, Session, SessionStats } from '@crash/shared/types';
import { ZERO_STATS } from '@crash/shared/types';
import {
  ANON_ADJ, ANON_NOUN, BETS_PER_MINUTE, HISTORY_LIMIT,
  SESSION_TTL_SEC, DEFAULT_CURRENCY,
} from '@crash/shared/config';

// TEMP demo seed; Task 3.1 replaces this with the operator authenticate balance.
export const DEFAULT_DEMO_BALANCE = 1000;

// ─── Boot ────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default: <repo>/data/rocksdb (server runs from packages/server/src)
const DB_PATH = process.env.ROCKSDB_PATH ?? path.join(__dirname, '../../../data/rocksdb');

export class StoreOfflineError extends Error {
  constructor() { super('session store offline'); this.name = 'StoreOfflineError'; }
}

let db: LevelUp | null = null;
let online = false;

function ensureDirExists(p: string) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
}

async function openDb(): Promise<void> {
  ensureDirExists(DB_PATH);
  const inst = levelup(encoding(rocksdb(DB_PATH), { valueEncoding: 'json' }));
  await new Promise<void>((resolve, reject) => {
    inst.open((err: Error | undefined) => err ? reject(err) : resolve());
  });
  db = inst;
  online = true;
  console.log(`[store] RocksDB opened at ${DB_PATH}`);
}

openDb().catch((err) => {
  online = false;
  console.warn(`[store] failed to open RocksDB at ${DB_PATH}: ${err.message}`);
});

export function isOnline(): boolean { return online; }

export async function closeStore(): Promise<void> {
  if (db && online) {
    try { await db.close(); } catch { /* ignore */ }
  }
  online = false;
}

// ─── Async lock per session to make read-modify-write safe ───────────────────
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const safe = next.catch(() => undefined);
  locks.set(key, safe);
  void safe.finally(() => { if (locks.get(key) === safe) locks.delete(key); });
  return next;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────
const sessKey    = (id: string) => `session:${id}`;
const statsKey   = (id: string) => `session:${id}:stats`;
const historyKey = (id: string) => `session:${id}:history`;

function ensureOnline(): LevelUp {
  if (!online || !db) throw new StoreOfflineError();
  return db;
}

// ─── Low-level helpers ──────────────────────────────────────────────────────
async function jget<T>(key: string): Promise<T | null> {
  const d = ensureOnline();
  try {
    const v = await d.get(key);
    return v as T;
  } catch (err) {
    // levelup throws when key is missing
    if ((err as { notFound?: boolean }).notFound) return null;
    throw err;
  }
}

async function jput<T>(key: string, value: T): Promise<void> {
  const d = ensureOnline();
  await d.put(key, value as unknown as Buffer);
}

async function jdel(key: string): Promise<void> {
  const d = ensureOnline();
  try { await d.del(key); } catch { /* ignore missing */ }
}

const newId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 14);

function randomDisplayName(): string {
  const a = ANON_ADJ[Math.floor(Math.random() * ANON_ADJ.length)];
  const n = ANON_NOUN[Math.floor(Math.random() * ANON_NOUN.length)];
  return `${a} ${n}`;
}

function quantize(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

/** 8-hour TTL for operator-backed iframe sessions (spec §3). */
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Mint a new operator-backed session from a wallet authenticate response (Task 3.1a). */
export async function createOperatorSession(opts: {
  operatorId: string;
  playerId: string;
  currency: string;
  balanceMinor: number;
  displayName: string;
  rgLimits?: { maxBetMinor?: number; sessionEndsAt?: number };
  gameId?: string;
}): Promise<Session> {
  ensureOnline();
  const sessionId = newId();
  const now = Date.now();
  const session: Session = {
    sessionId,
    displayName: opts.displayName,
    // Populate the legacy `balance` field with balanceMinor so the existing
    // WS/stats code keeps working. Task 3.2 will teach the client to prefer balanceMinor.
    balance: opts.balanceMinor,
    createdAt: now,
    expiresAt: now + OPERATOR_SESSION_TTL_MS,
    operatorId: opts.operatorId,
    playerId: opts.playerId,
    currency: opts.currency,
    balanceMinor: opts.balanceMinor,
    rgLimits: opts.rgLimits,
    gameId: opts.gameId ?? 'galaxy-crash',
  };
  await jput(sessKey(sessionId), session);
  await jput(statsKey(sessionId), { ...ZERO_STATS });
  return session;
}

/**
 * Mint a personal-lobby REAL-money session bound to a casino player. Balance is
 * mirrored from the Postgres wallet at start; the wallet_ledger stays the source
 * of truth (bets/wins settle against it, the session balance is just the last
 * value we pushed to the client).
 */
export async function createPlayerSession(opts: {
  lobbyPlayerId: string;
  username: string;
  gameId: string;
  balanceMinor: number;
  currency?: string;
}): Promise<Session> {
  ensureOnline();
  const sessionId = newId();
  const now = Date.now();
  const session: Session = {
    sessionId,
    displayName: opts.username,
    balance: opts.balanceMinor,
    createdAt: now,
    expiresAt: now + OPERATOR_SESSION_TTL_MS,
    currency: opts.currency ?? DEFAULT_CURRENCY,
    balanceMinor: opts.balanceMinor,
    gameId: opts.gameId,
    lobbyPlayerId: opts.lobbyPlayerId,
  };
  await jput(sessKey(sessionId), session);
  await jput(statsKey(sessionId), { ...ZERO_STATS });
  return session;
}

export async function createSession(opts: { displayName?: string; balance?: number; gameId?: string } = {}): Promise<Session> {
  ensureOnline();
  const sessionId = newId();
  const now = Date.now();
  const session: Session = {
    sessionId,
    displayName: (opts.displayName ?? '').trim() || randomDisplayName(),
    balance: opts.balance ?? DEFAULT_DEMO_BALANCE,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SEC * 1000,
    // Which game this session plays — so bets are gated against THIS game's
    // round, not the default game's (otherwise a matwinner player gets "betting
    // closed" whenever galaxy-crash is mid-flight). Absent → default game.
    ...(opts.gameId ? { gameId: opts.gameId } : {}),
  };
  await jput(sessKey(sessionId), session);
  await jput(statsKey(sessionId), { ...ZERO_STATS });
  return session;
}

/**
 * Backfill a session's game when it has none (legacy demo sessions created before
 * gameId was threaded). No-op if already set — never overrides an operator/lobby
 * session's authoritative gameId.
 */
export async function bindSessionGame(sessionId: string, gameId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.gameId) return;
  await jput(sessKey(sessionId), { ...session, gameId });
}

export async function getSession(sessionId: string): Promise<Session | null> {
  ensureOnline();
  const s = await jget<Session>(sessKey(sessionId));
  if (!s) return null;
  // Lazy expiry
  if (s.expiresAt && s.expiresAt < Date.now()) {
    await deleteSession(sessionId);
    return null;
  }
  return s;
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!online) return;
  await Promise.all([
    jdel(sessKey(sessionId)),
    jdel(statsKey(sessionId)),
    jdel(historyKey(sessionId)),
  ]);
}

/** Refresh the session's expiresAt so active sessions don't lapse. */
export async function refreshTtl(sessionId: string): Promise<void> {
  if (!online) return;
  await withLock(sessionId, async () => {
    const s = await jget<Session>(sessKey(sessionId));
    if (!s) return;
    s.expiresAt = Date.now() + SESSION_TTL_SEC * 1000;
    await jput(sessKey(sessionId), s);
  });
}

export async function adjustBalance(sessionId: string, delta: number): Promise<number> {
  ensureOnline();
  return withLock(sessionId, async () => {
    const s = await jget<Session>(sessKey(sessionId));
    if (!s) throw new Error('session not found');
    s.balance = quantize(s.balance + delta);
    s.expiresAt = Date.now() + SESSION_TTL_SEC * 1000;
    await jput(sessKey(sessionId), s);
    return s.balance;
  });
}

export async function setBalance(sessionId: string, balance: number): Promise<void> {
  ensureOnline();
  await withLock(sessionId, async () => {
    const s = await jget<Session>(sessKey(sessionId));
    if (!s) throw new Error('session not found');
    s.balance = quantize(balance);
    s.expiresAt = Date.now() + SESSION_TTL_SEC * 1000;
    await jput(sessKey(sessionId), s);
  });
}

// ─── History audit log ───────────────────────────────────────────────────────

export async function appendHistory(sessionId: string, entry: HistoryEntry): Promise<void> {
  if (!online) return;
  await withLock(`${sessionId}:hist`, async () => {
    const list = (await jget<HistoryEntry[]>(historyKey(sessionId))) ?? [];
    list.unshift(entry);
    if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
    await jput(historyKey(sessionId), list);
  });
}

export async function getHistory(sessionId: string, limit = 50): Promise<HistoryEntry[]> {
  ensureOnline();
  const list = (await jget<HistoryEntry[]>(historyKey(sessionId))) ?? [];
  return list.slice(0, Math.min(limit, HISTORY_LIMIT));
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getStats(sessionId: string): Promise<SessionStats> {
  ensureOnline();
  const s = await jget<SessionStats>(statsKey(sessionId));
  return s ?? { ...ZERO_STATS };
}

/**
 * `currency` marks the record as money-session stats, whose monetary fields are
 * integer minor units. It is stamped on the first write and never changed — a
 * session's type is fixed at creation, so a record can't legitimately switch
 * scales, and refusing to overwrite keeps a stray call from corrupting one.
 */
async function mutateStats(
  sessionId: string,
  fn: (s: SessionStats) => void,
  currency?: string,
): Promise<SessionStats> {
  return withLock(`${sessionId}:stats`, async () => {
    const s = (await jget<SessionStats>(statsKey(sessionId))) ?? { ...ZERO_STATS };
    if (currency && !s.currency) s.currency = currency;
    fn(s);
    // Minor units are integers already; quantizing them to 2dp is meaningless
    // and loses precision on large values. Demo credits stay at 2dp.
    const norm = s.currency ? Math.round : quantize;
    s.totalWagered = norm(s.totalWagered);
    s.totalWon = norm(s.totalWon);
    s.netProfit = norm(s.netProfit);
    s.biggestWin = norm(s.biggestWin);
    await jput(statsKey(sessionId), s);
    return s;
  });
}

/**
 * @param stake  demo: decimal credits. Money session: integer minor units.
 * @param currency  set for money sessions; omit for the legacy demo path.
 */
export async function recordBet(sessionId: string, stake: number, currency?: string): Promise<SessionStats> {
  ensureOnline();
  return mutateStats(sessionId, (s) => {
    s.bets += 1;
    s.totalWagered += stake;
    s.netProfit -= stake;
  }, currency);
}

/** Cashout: player gets back `payout` (= stake × multiplier). Adjusts stats accordingly. */
export async function recordWin(
  sessionId: string, stake: number, payout: number, multiplier: number, currency?: string,
): Promise<SessionStats> {
  ensureOnline();
  return mutateStats(sessionId, (s) => {
    s.wins += 1;
    s.totalWon += payout;
    // netProfit was already decremented by `stake` in recordBet
    s.netProfit += payout;
    s.biggestCashout = Math.max(s.biggestCashout, multiplier);
    s.biggestWin = Math.max(s.biggestWin, payout - stake);
    s.currentStreak = s.currentStreak >= 0 ? s.currentStreak + 1 : 1;
    s.bestStreak = Math.max(s.bestStreak, s.currentStreak);
  }, currency);
}

/**
 * Run a stats mutation without letting it break a money flow.
 *
 * Stats are a display convenience; the wallet ledger is the record of truth. A
 * store outage must never turn an already-settled bet or credit into a
 * user-visible failure, so this swallows the error and the frame simply ships
 * without a `stats` field (the client leaves its last values in place).
 */
export async function recordStatsSafely(
  fn: () => Promise<SessionStats>,
): Promise<SessionStats | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error('[stats] record failed (non-fatal — money flow already settled):', err);
    return undefined;
  }
}

export async function recordLoss(sessionId: string, currency?: string): Promise<SessionStats> {
  ensureOnline();
  return mutateStats(sessionId, (s) => {
    s.losses += 1;
    s.currentStreak = s.currentStreak <= 0 ? s.currentStreak - 1 : -1;
    // netProfit already decremented in recordBet — nothing more to subtract
  }, currency);
}

// ─── Rate limiting (in-memory) ───────────────────────────────────────────────

interface BucketEntry { count: number; resetAt: number; }
const rateBuckets = new Map<string, BucketEntry>();

export async function checkRateLimit(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const entry = rateBuckets.get(sessionId);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(sessionId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= BETS_PER_MINUTE;
}

// Sweep stale buckets every 5 min so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
}, 5 * 60_000).unref?.();
