import { config as loadEnv } from 'dotenv';
import { fileURLToPath as _fileURLToPath } from 'node:url';
import path$ from 'node:path';
// Load the repo-root .env regardless of cwd (server runs from packages/server).
loadEnv({ path: path$.join(path$.dirname(_fileURLToPath(import.meta.url)), '../../../.env') });
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgBetLog, PgOperatorRegistry, PgGamesRepo, PgReconciler, runRecovery, consoleAlerter, getPool, bootstrapCasinoSchema } from '@crash/wallet';
import { PlayersRepo } from '@crash/wallet/players-repo';
import { WalletLedger } from '@crash/wallet/wallet-ledger';
import { createLobbyRouter } from './http/lobby';
import { createLobbyPlayRouter } from './http/lobby-play';
import { createLobbyDepositRouter } from './http/lobby-deposit';
import { createDepositWebhookRouter } from './http/deposit-webhook';
import { MapleradClient } from './maplerad/client';
import { FincraClient } from './fincra/client';
import type { PayInProvider } from './payments/types';
import { MapleradFx } from './maplerad/fx';
import { PgDepositsRepo, SUPPORTED_CURRENCIES } from '@crash/wallet';
import { createAssetsRouter } from './http/assets';
import { setLobbyWiringDeps } from './game/lobby-deps';
import type { OperatorLedgerSource } from '@crash/wallet';
import { scheduleDailyReconciliation } from './reconciliation/scheduler';
import { initThemeLoader, getActiveTheme } from './theme/loader';
import { registerPublicRoutes } from './http/public';
import { createSimulateRouter } from './http/simulate';
import { createStoreEconomy } from './simulate/economy';
import { verifyOperatorSignature } from './http/middleware/verify-operator-signature';
import { createOperatorRouter } from './http/operator';
import { PgOperatorAudit } from './http/operator-audit-pg';
import { createAdminRouter } from './http/admin';
import { PgAdminAudit, PgAdminUsers } from './admin/admin-store-pg';
import { isAdminRole } from './admin/admin-store';
import * as bcrypt from 'bcryptjs';
import type { AdminRole } from './admin/admin-store';
import { WalletClientCache } from './wallet/client-cache';
import { setOperatorWiringDeps } from './game/operator-deps';
import { clients, sessionSockets, safeSend, sendToSession } from './ws/hub';
import { handleMessage } from './ws/handlers';
import * as Round from './game/round';
const { CONFIG, startAllEngines, getRoundForGame, getEngine } = Round;
import { getRecentHistory } from './game/history';
import { bindSessionGame, getSession } from './store';
import { DEFAULT_GAME_ID } from '@crash/shared/rng';

// ---------------------------------------------------------------------------
// Database + crash-recovery
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Everything durable lives in the casino Postgres DB (Wave A + Wave B). The only
// remaining on-disk store is RocksDB for hot session cache (see store.ts).
const pool = getPool();
const betLog = new PgBetLog(pool);
const adminAudit = new PgAdminAudit(pool);
const operatorAudit = new PgOperatorAudit(pool);
const adminUsers = new PgAdminUsers(pool);
const revoked = new Set<string>();
const registry = new PgOperatorRegistry(pool);
const walletClientCache = new WalletClientCache(registry, betLog);
const games = new PgGamesRepo(pool);
// How often the round loop re-reads the games catalogue from Postgres (picks up
// games created by another process/replica or inserted directly).
const GAMES_SNAPSHOT_REFRESH_MS = 10_000;
const players = new PlayersRepo(pool);
const wallet = new WalletLedger(pool);
setOperatorWiringDeps({ walletClientCache, betLog, alerter: consoleAlerter, games });

// ─── Pay-in processors (deposits) ───────────────────────────────────────────
// Maplerad and Fincra both collect mobile money in the Eastern/Southern
// African corridors listed in RAILS. The deposit route tries them in
// PAYIN_PROVIDER_ORDER and uses whichever one is configured, supports the
// player's currency, and accepts the charge. FX is only exercised if a non-KES
// lobby bet occurs, so FX_RATES is an acceptable static config fallback until
// a live rate endpoint is wired.
const maplerad = new MapleradClient({
  baseUrl: process.env.MAPLERAD_BASE_URL ?? 'https://api.maplerad.com/v1',
  secretKey: process.env.MAPLERAD_SECRET_KEY ?? '',
  webhookSecret: process.env.MAPLERAD_WEBHOOK_SECRET ?? '',
});
const fincra = new FincraClient({
  baseUrl: process.env.FINCRA_BASE_URL ?? 'https://api.fincra.com',
  secretKey: process.env.FINCRA_SECRET_KEY ?? '',
  businessId: process.env.FINCRA_BUSINESS_ID ?? '',
  publicKey: process.env.FINCRA_PUBLIC_KEY ?? '',
  webhookSecret: process.env.FINCRA_WEBHOOK_SECRET ?? '',
  ...(process.env.FINCRA_REDIRECT_URL ? { redirectUrl: process.env.FINCRA_REDIRECT_URL } : {}),
  ...(process.env.FINCRA_CURRENCIES ? { currencies: process.env.FINCRA_CURRENCIES.split(',').map((c) => c.trim()) } : {}),
});
const payInByName: Record<string, PayInProvider> = { maplerad, fincra };
const payInProviders = (process.env.PAYIN_PROVIDER_ORDER ?? 'maplerad,fincra')
  .split(',')
  .map((n) => n.trim())
  .map((n) => payInByName[n])
  .filter((p): p is PayInProvider => !!p);
console.log(
  `[payin] order: ${payInProviders.map((p) => p.name).join(' → ')}; configured: ` +
    (SUPPORTED_CURRENCIES.map((c) => `${c}=${payInProviders.filter((p) => p.supports(c)).map((p) => p.name).join('/') || 'none'}`).join(' ')),
);
const deposits = new PgDepositsRepo(pool);
const fx = new MapleradFx(async (from) => {
  const rates = JSON.parse(process.env.FX_RATES ?? '{}');
  const r = rates[from];
  if (typeof r !== 'number') throw new Error('no FX rate for ' + from);
  return r;
});

setLobbyWiringDeps({ wallet, fx });

// Reconciliation (Task 8.1, spec §9).
//
// The Reconciler diffs OUR txn_idempotency records against an operator's ledger,
// supplied by an injected OperatorLedgerSource. This is the SINGLE injection
// point for a real per-operator reconciliation feed.
//
// HONEST DEFAULT: there is no real operator-side ledger HTTP contract in this
// repo yet, so the default source returns an empty ledger. As a result, runs
// surface every one of OUR txns as `missing_on_operator`. This is deliberate —
// it is the correct, non-fabricated behaviour absent a real feed. Wiring each
// operator's reconciliation feed here is a Phase-future task.
const defaultLedgerSource: OperatorLedgerSource = async () => [];
console.log(
  '[reconciliation] no operator ledger source configured — runs will report our txns as missing_on_operator (Phase-future: wire to each operator\'s reconciliation feed).',
);
const reconciler = new PgReconciler(pool, { source: defaultLedgerSource, betLog });

const app = express();
// Capture raw body bytes for HMAC signing (verifyOperatorSignature §4.2).
// Behaviour-neutral for all other routes: JSON still parsed identically.
// 30mb limit: the Creator uploads base64 `data:` asset URLs (gifs/audio) to
// /api/assets/upload, which blow past Express's 100kb default. The server
// compresses large images before storing to S3 (see s3.ts), but the raw upload
// still arrives at full size, so the parser must accept it.
app.use(express.json({ limit: '30mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Theme autoload + fs.watch
initThemeLoader();

// Postgres bootstrap (Wave A): ensure schema, seed the default game, prime the
// games snapshot the hot round loop reads. Runs AFTER initThemeLoader so the
// seed can copy the active theme.
try {
  await bootstrapCasinoSchema(pool);
  await registry.refresh(); // prime the operator cache (sync reads on hot paths)
  console.log(`[operators] loaded ${registry.list().length} operators from Postgres`);
  if (!(await games.getById('galaxy-crash'))) {
    const seededTheme = getActiveTheme() ?? {};
    const gt = (seededTheme as { gameType?: string }).gameType === 'gif' ? 'gif' : 'sprite';
    await games.create({ gameId: 'galaxy-crash', name: 'Galaxy Crash', gameType: gt, rtp: CONFIG.rtp, theme: seededTheme });
    console.log('[games] seeded galaxy-crash into the catalogue');
  }
  await games.refreshSnapshot();
  console.log(`[games] catalogue ready (${games.snapshot().length} active on Postgres)`);

  // Periodically re-read the catalogue so games created out-of-band — by another
  // process (a Creator hitting a different backend), a second replica, or a direct
  // DB insert — appear in the round loop within seconds, without a pod restart.
  // The snapshot is per-process, so boot + local-mutation refreshes alone miss them.
  setInterval(() => {
    void games
      .refreshSnapshot()
      .then(() => startAllEngines()) // spin up engines for any newly-appeared games
      .catch((err) => console.error('[games] snapshot refresh failed:', err));
  }, GAMES_SNAPSHOT_REFRESH_MS);
} catch (err) {
  console.error('[games] Postgres bootstrap failed:', err);
  throw err; // games catalogue is required — fail fast rather than run half-wired
}

// /api/health — PUBLIC liveness probe (Task 8.3 Dockerfile HEALTHCHECK target).
// Mounted BEFORE any auth middleware. Deliberately minimal — no version/branch/
// build metadata that would leak deployment info to unauthenticated scanners.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// ─── Operator API (must be BEFORE registerPublicRoutes, which adds the SPA * fallback) ──

// /op/v1/health is PUBLIC per spec §3.1 — mounted BEFORE verifyOperatorSignature
// so it bypasses the auth middleware entirely. It must live here in index.ts
// (not inside createOperatorRouter) because the auth is wired at the mount level
// with app.use('/op/v1', verifyOperatorSignature(...), router) — any route inside
// the router is behind that middleware. A separate app.get() registered first
// takes priority.
app.get('/op/v1/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0', gamesAvailable: ['galaxy-crash'] });
});

// getSignedPath uses req.originalUrl (full external path) because this router is
// sub-mounted at /op/v1 — req.path would be router-relative and would NOT match
// the path the operator signed (per the Task 2.1 TODO/spec §4.2 note).
app.use(
  '/op/v1',
  verifyOperatorSignature(registry, { getSignedPath: (req) => req.originalUrl.split('?')[0] }),
  createOperatorRouter({ betLog, registry, walletClientCache, operatorAudit }),
);

// ─── Admin API (Phase-5.2 JWT; must be BEFORE registerPublicRoutes SPA * fallback) ──
// Auth is internal to the router: /auth/login is public; router.use(requireAdminJwt)
// gates everything else. No top-level auth middleware here.
app.use('/admin/v1', createAdminRouter({ walletClientCache, betLog, adminAudit, adminUsers, registry, games, revoked, reconciler }));

// ─── Personal lobby: player accounts + wallet + asset uploads (Wave A) ──────────
// Mounted BEFORE registerPublicRoutes (SPA * fallback). Player-facing auth is
// internal to the lobby router; asset uploads are admin-JWT protected.
app.use('/api/lobby', createLobbyRouter({ players, wallet }));
app.use('/api/lobby', createLobbyPlayRouter({ games, players, wallet }));
app.use('/api/lobby', createLobbyDepositRouter({ players, deposits, providers: payInProviders }));
app.use('/api/assets', createAssetsRouter());

// ─── Collection webhooks (one signed endpoint per processor) ────────────────
// notifyBalance is best-effort: it scans currently-connected sessions for one
// bound to the deposited lobby player (via lobbyPlayerId) and pushes a live
// balance update over the socket. If the player has no live session (or the
// store is offline) this is a harmless no-op — the client re-reads its
// balance on its next action regardless, so Phase 1 doesn't depend on this.
async function notifyBalance(playerId: string, balanceMinor: number, currency: string): Promise<void> {
  try {
    for (const sessionId of sessionSockets.keys()) {
      const session = await getSession(sessionId).catch(() => null);
      if (session?.lobbyPlayerId === playerId) {
        sendToSession(sessionId, { type: 'balance', data: { balanceMinor, currency } });
      }
    }
  } catch (err) {
    console.debug('[payin] notifyBalance best-effort push failed (non-fatal):', err);
  }
}

for (const provider of payInProviders) {
  app.use('/api/webhooks', createDepositWebhookRouter({ path: `/${provider.name}`, provider, deposits, wallet, notifyBalance }));
}

// ─── Simulate game (harvested odds + provably-fair RNG) ─────────────────────
// Play-money casino game: build a bet slip from real harvested fixtures and
// simulate the outcome. Mounted BEFORE registerPublicRoutes (SPA * fallback).
app.use('/api/simulate', createSimulateRouter({ economy: createStoreEconomy() }));

// HTTP routes (SPA * fallback is inside; must come AFTER /op/v1 and /admin/v1)
registerPublicRoutes(app, { walletClientCache, games });

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  clients.add(ws);
  let claimedSession: string | null = null;
  // Which game this socket is playing (from the /ws?game=<id> query), so the
  // join snapshot below reflects THIS game's live round, not the default game's.
  let joinGameId = DEFAULT_GAME_ID;
  try {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('game');
    if (q) joinGameId = q;
  } catch { /* keep default */ }

  function attachSession(sessionId: string) {
    if (claimedSession === sessionId) return;
    if (claimedSession) {
      const old = sessionSockets.get(claimedSession);
      old?.delete(ws);
      if (old && old.size === 0) sessionSockets.delete(claimedSession);
    }
    claimedSession = sessionId;
    if (!sessionSockets.has(sessionId)) sessionSockets.set(sessionId, new Set());
    sessionSockets.get(sessionId)!.add(ws);
    // Reconcile the session's game to the one this socket is playing (?game=),
    // so a legacy/mis-bound session doesn't bet against the wrong game's round.
    if (joinGameId !== DEFAULT_GAME_ID) void bindSessionGame(sessionId, joinGameId).catch(() => {});
  }

  const joinRound = getRoundForGame(joinGameId);
  if (joinRound) {
    const joinEngine = getEngine(joinGameId);
    const joinData: Record<string, unknown> = {
      gameId: joinGameId,
      roundNumber: joinRound.roundNumber,
      phase: joinRound.phase,
      currentMultiplier: joinRound.currentMultiplier,
      startTime: joinRound.startTime,
      serverTime: Date.now(),
      hashCommit: joinRound.serverSeedHash,
      bets: joinRound.bets,
      history: getRecentHistory(30, joinGameId),
      prevServerSeed: joinEngine?.prevSeed ?? null,
      prevRoundNumber: joinEngine?.prevRound ?? null,
    };
    if (joinRound.phase === 'BETTING') {
      const elapsed = Date.now() - joinRound.startTime;
      joinData.countdownMs = Math.max(0, CONFIG.bettingPhaseMs - elapsed);
      joinData.countdownStart = joinRound.startTime;
    }
    safeSend(ws, { type: 'join', data: joinData });
  }

  ws.on('message', (data) => {
    let message: Record<string, unknown> | null = null;
    try { message = JSON.parse(data.toString()); } catch (e) { console.error('[ws] invalid message:', e); return; }
    if (message) void handleMessage(ws, message, attachSession);
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (claimedSession) {
      const set = sessionSockets.get(claimedSession);
      set?.delete(ws);
      if (set && set.size === 0) sessionSockets.delete(claimedSession);
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST ?? '0.0.0.0';

// Run crash-recovery before accepting connections.
// Failure is non-fatal — log and continue.
let recoveryReport: unknown = null;
try {
  recoveryReport = await runRecovery({ betLog, registry, alerter: consoleAlerter });
} catch (err) {
  console.error('[recovery] error during startup sweep (continuing):', err);
}
console.log('[recovery] report', JSON.stringify(recoveryReport));

// Start the daily reconciliation sweep (00:15 UTC). Gated: never auto-starts
// under test (the engine + on-demand endpoint are the tested core; this timer
// is thin glue). It also never throws out of the timer (catch + log per operator).
if (process.env['NODE_ENV'] !== 'test') {
  scheduleDailyReconciliation(reconciler, registry, { hourUtc: 0, minuteUtc: 15 });
  console.log('[reconciliation] daily sweep scheduled for 00:15 UTC');
}

// ─── Bootstrap first admin from env ──────────────────────────────────────────
// ADMIN_BOOTSTRAP_USER=username:password:role1,role2
// Idempotent: skipped if admin table already has any users, or env is unset.
try {
  const bootstrapEnv = process.env['ADMIN_BOOTSTRAP_USER'];
  if (bootstrapEnv && (await adminUsers.count()) === 0) {
    const colonIdx1 = bootstrapEnv.indexOf(':');
    const colonIdx2 = bootstrapEnv.indexOf(':', colonIdx1 + 1);
    if (colonIdx1 < 0 || colonIdx2 < 0) {
      throw new Error('ADMIN_BOOTSTRAP_USER must be "username:password:role1,role2"');
    }
    const u = bootstrapEnv.slice(0, colonIdx1);
    const p = bootstrapEnv.slice(colonIdx1 + 1, colonIdx2);
    const rolesStr = bootstrapEnv.slice(colonIdx2 + 1);
    const parsedRoles = (rolesStr || 'admin').split(',').map((r) => r.trim());
    const invalidRoles = parsedRoles.filter((r) => !isAdminRole(r));
    if (invalidRoles.length > 0) {
      console.error(
        `[admin] bootstrap skipped: ADMIN_BOOTSTRAP_USER has invalid role(s) ${invalidRoles.join(', ')}; expected admin|finance|support|viewer`,
      );
    } else {
      const roles = parsedRoles as AdminRole[];
      const hash = await bcrypt.hash(p, 10);
      await adminUsers.create(u, hash, roles);
      console.log(`[admin] bootstrapped initial admin '${u}'`);
    }
  }
} catch (err) {
  console.error('[admin] bootstrap failed (continuing):', err);
}

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
  console.log(`[server] RTP=${CONFIG.rtp}  maxMultiplier=${CONFIG.maxMultiplier}  growth=${Round.GROWTH_RATE}`);
  startAllEngines();
});

export { app, server, wss };
