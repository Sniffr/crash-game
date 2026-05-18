import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { initThemeLoader } from './theme/loader';
import { registerPublicRoutes } from './http/public';
import { clients, sessionSockets, safeSend } from './ws/hub';
import { handleMessage } from './ws/handlers';
import * as Round from './game/round';
const { CONFIG, startBettingPhase } = Round;
import { getRecentHistory } from './game/history';

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Theme autoload + fs.watch
initThemeLoader();

// HTTP routes
registerPublicRoutes(app);

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
server.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
  console.log(`[server] RTP=${CONFIG.rtp}  maxMultiplier=${CONFIG.maxMultiplier}  growth=${Round.GROWTH_RATE}`);
  startBettingPhase();
});

export { app, server, wss };
