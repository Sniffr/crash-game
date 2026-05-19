import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BetLog, OperatorRegistry, runRecovery, consoleAlerter } from '@crash/wallet';
import { initThemeLoader } from './theme/loader';
import { registerPublicRoutes } from './http/public';
import { verifyOperatorSignature } from './http/middleware/verify-operator-signature';
import { createOperatorRouter } from './http/operator';
import { WalletClientCache } from './wallet/client-cache';
import { setOperatorWiringDeps } from './game/operator-deps';
import { clients, sessionSockets, safeSend } from './ws/hub';
import { handleMessage } from './ws/handlers';
import * as Round from './game/round';
const { CONFIG, startBettingPhase } = Round;
import { getRecentHistory } from './game/history';

// ---------------------------------------------------------------------------
// Database + crash-recovery
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env['DB_PATH'] ?? path.join(__dirname, '../../../data/galaxy-crash.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
const betLog = new BetLog(db);
const registry = new OperatorRegistry(db);
const walletClientCache = new WalletClientCache(registry, betLog);
setOperatorWiringDeps({ walletClientCache, betLog, alerter: consoleAlerter });

const app = express();
// Capture raw body bytes for HMAC signing (verifyOperatorSignature §4.2).
// Behaviour-neutral for all other routes: JSON still parsed identically.
app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Theme autoload + fs.watch
initThemeLoader();

// ─── Operator API (must be BEFORE registerPublicRoutes, which adds the SPA * fallback) ──
// getSignedPath uses req.originalUrl (full external path) because this router is
// sub-mounted at /op/v1 — req.path would be router-relative and would NOT match
// the path the operator signed (per the Task 2.1 TODO/spec §4.2 note).
app.use(
  '/op/v1',
  verifyOperatorSignature(registry, { getSignedPath: (req) => req.originalUrl.split('?')[0] }),
  createOperatorRouter(),
);

// HTTP routes (SPA * fallback is inside; must come AFTER /op/v1)
registerPublicRoutes(app, { walletClientCache });

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  let claimedSession: string | null = null;

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
  }

  if (Round.currentRound) {
    const joinData: Record<string, unknown> = {
      roundNumber: Round.currentRound.roundNumber,
      phase: Round.currentRound.phase,
      currentMultiplier: Round.currentRound.currentMultiplier,
      startTime: Round.currentRound.startTime,
      serverTime: Date.now(),
      hashCommit: Round.currentRound.serverSeedHash,
      bets: Round.currentRound.bets,
      history: getRecentHistory(30),
      prevServerSeed: Round.prevServerSeed,
      prevRoundNumber: Round.prevRoundNumber,
    };
    if (Round.currentRound.phase === 'BETTING') {
      const elapsed = Date.now() - Round.currentRound.startTime;
      joinData.countdownMs = Math.max(0, CONFIG.bettingPhaseMs - elapsed);
      joinData.countdownStart = Round.currentRound.startTime;
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

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
  console.log(`[server] RTP=${CONFIG.rtp}  maxMultiplier=${CONFIG.maxMultiplier}  growth=${Round.GROWTH_RATE}`);
  startBettingPhase();
});

export { app, server, wss };
