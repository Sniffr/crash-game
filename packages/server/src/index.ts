import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  generateServerSeed,
  commitSeed,
  crashPointFor,
  verifyRound,
  type Commit,
  type Reveal,
} from '@crash/shared/rng';
import {
  type RoundState,
  type Bet,
  type RoundHistoryEntry,
  type GameConfig,
  type HistoryEntry,
} from '@crash/shared/types';
import { GAME_CONFIG, MAX_STAKE, STARTING_BALANCE } from '@crash/shared/config';
import { generateBotBets, type BotBet } from './bots';
import {
  appendHistory,
  adjustBalance,
  checkRateLimit,
  createSession,
  getHistory,
  getSession,
  getStats,
  isOnline as storeOnline,
  recordBet,
  recordLoss,
  recordWin,
  setBalance,
  StoreOfflineError,
} from './store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Game config ──────────────────────────────────────────────────────────────
const CONFIG: GameConfig = { ...GAME_CONFIG };

// Multiplier curve: m(t) = e^(GROWTH_RATE * t_seconds).
const GROWTH_RATE = 0.06;

function multiplierAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  return Math.exp(GROWTH_RATE * t);
}

// ─── Game state ───────────────────────────────────────────────────────────────
let roundNumber = 0;
let currentRound: RoundState | null = null;
let serverSeed = generateServerSeed();
let nextServerSeed = generateServerSeed();
let prevServerSeed: string | null = null;
let prevRoundNumber: number | null = null;
const roundHistory: RoundHistoryEntry[] = [];

/** Per-session metadata for real-player bets (display name lookup). */
const sessionMeta = new Map<string, { displayName: string }>();
/** ws lookup by sessionId so auto-cashout can notify the right tabs. */
const sessionSockets = new Map<string, Set<WebSocket>>();
const clients = new Set<WebSocket>();

// ─── HTTP routes ──────────────────────────────────────────────────────────────
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// ─── Theme autoload ───────────────────────────────────────────────────────────
const THEME_PATH = path.join(__dirname, '../../../config/active-theme.json');
let activeTheme: unknown | null = null;

function loadActiveTheme() {
  try {
    if (fs.existsSync(THEME_PATH)) {
      const raw = fs.readFileSync(THEME_PATH, 'utf-8');
      activeTheme = JSON.parse(raw);
      console.log(`[theme] loaded from ${THEME_PATH}`);
    } else {
      activeTheme = null;
    }
  } catch (e) {
    console.error('[theme] failed to load:', (e as Error).message);
    activeTheme = null;
  }
}
loadActiveTheme();

try {
  const themeDir = path.dirname(THEME_PATH);
  if (fs.existsSync(themeDir)) {
    let pending: NodeJS.Timeout | null = null;
    fs.watch(themeDir, { persistent: false }, (_event, filename) => {
      if (filename !== path.basename(THEME_PATH)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = null; loadActiveTheme(); }, 250);
    });
  }
} catch (e) {
  console.warn('[theme] file watcher disabled:', (e as Error).message);
}

app.get('/api/theme', (_req, res) => {
  if (activeTheme == null) { res.status(204).end(); return; }
  res.json(activeTheme);
});

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  roundNumber,
  hasTheme: activeTheme != null,
  storeOnline: storeOnline(),
}));

app.get('/api/history', (_req, res) => res.json(roundHistory.slice(-50)));

app.get('/api/verify', (req, res) => {
  const seed = String(req.query.seed ?? '');
  const rn = String(req.query.roundNumber ?? '');
  if (!seed || !rn) return res.status(400).json({ error: 'Missing seed or roundNumber' });
  const roundNum = parseInt(rn, 10);
  if (!Number.isFinite(roundNum)) return res.status(400).json({ error: 'roundNumber must be an integer' });
  try {
    const crashPoint = crashPointFor(seed, roundNum, CONFIG);
    const hashCommit = commitSeed(seed);
    res.json({ roundNumber: roundNum, serverSeed: seed, crashPoint, hashCommit });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/verify', (req, res) => {
  const { seed, roundNumber: rn } = (req.body ?? {}) as { seed?: string; roundNumber?: number };
  if (!seed || rn == null) return res.status(400).json({ error: 'Missing seed or roundNumber' });
  try {
    const commit: Commit = { roundNumber: rn, hashCommit: commitSeed(seed) };
    const reveal: Reveal = {
      roundNumber: rn,
      serverSeed: seed,
      crashPoint: crashPointFor(seed, rn, CONFIG),
    };
    const result = verifyRound(commit, reveal);
    res.json({ ...result, computedCrash: reveal.crashPoint, revealedSeed: seed });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Session API ──────────────────────────────────────────────────────────────

/** Create a fresh anonymous session. Returns the session id + URL hint. */
app.post('/api/session', async (req, res) => {
  try {
    const { displayName, balance } = (req.body ?? {}) as { displayName?: string; balance?: number };
    const safeBalance = balance != null && Number.isFinite(balance) && balance > 0
      ? Math.min(balance, 100_000)
      : undefined;
    const session = await createSession({ displayName, balance: safeBalance });
    res.json(session);
  } catch (err) {
    return sendStoreError(res, err);
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const stats = await getStats(req.params.id);
    res.json({ session, stats });
  } catch (err) {
    return sendStoreError(res, err);
  }
});

app.get('/api/sessions/:id/history', async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50)));
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const history = await getHistory(req.params.id, limit);
    res.json({ history });
  } catch (err) {
    return sendStoreError(res, err);
  }
});

function sendStoreError(res: express.Response, err: unknown) {
  if (err instanceof StoreOfflineError) {
    return res.status(503).json({ error: 'session store offline — start Dragonfly: docker compose up -d dragonfly' });
  }
  console.error('[api] error:', err);
  return res.status(500).json({ error: (err as Error).message });
}

// ─── WS broadcast helpers ────────────────────────────────────────────────────
function broadcast(message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function sendToSession(sessionId: string, message: Record<string, unknown>) {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  const data = JSON.stringify(message);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function safeSend(ws: WebSocket, message: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// ─── Phase transitions ────────────────────────────────────────────────────────
function startBettingPhase() {
  roundNumber += 1;
  serverSeed = nextServerSeed;
  nextServerSeed = generateServerSeed();

  const crashPoint = crashPointFor(serverSeed, roundNumber, CONFIG);
  const hashCommit = commitSeed(serverSeed);

  currentRound = {
    roundNumber,
    phase: 'BETTING',
    crashPoint,
    currentMultiplier: 1.0,
    startTime: Date.now(),
    bets: [],
    serverSeedHash: hashCommit,
  };

  const botBets = generateBotBets(roundNumber);
  currentRound.bets = botBets.map((b: BotBet) => ({
    playerId: b.playerId,
    amount: b.amount,
    autoCashout: b.autoCashout,
    cashedOut: false,
    isBot: true,
    botName: b.botName,
  }));

  broadcast({
    type: 'phase_change',
    data: {
      phase: 'BETTING',
      roundNumber,
      hashCommit,
      prevServerSeed,
      prevRoundNumber,
      countdownMs: CONFIG.bettingPhaseMs,
      countdownStart: currentRound.startTime,
      serverTime: currentRound.startTime,
      bets: currentRound.bets,
    },
  });

  const countdownInterval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'BETTING') {
      clearInterval(countdownInterval); return;
    }
    const elapsed = Date.now() - currentRound.startTime;
    const remaining = Math.max(0, CONFIG.bettingPhaseMs - elapsed);
    broadcast({ type: 'countdown_update', data: { countdownMs: remaining, roundNumber: currentRound.roundNumber } });
  }, 200);

  const dripInterval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'BETTING') { clearInterval(dripInterval); return; }
    if (Math.random() < 0.5 && currentRound.bets.filter((b) => b.isBot).length < 40) {
      const more = generateBotBets(roundNumber, 1, 3);
      for (const b of more) {
        const bet: Bet = {
          playerId: b.playerId, amount: b.amount, autoCashout: b.autoCashout,
          cashedOut: false, isBot: true, botName: b.botName,
        };
        currentRound.bets.push(bet);
        broadcast({
          type: 'new_bet',
          data: {
            playerId: bet.playerId, amount: bet.amount, isBot: true,
            botName: bet.botName, autoCashout: bet.autoCashout,
            roundNumber: currentRound.roundNumber,
          },
        });
      }
    }
  }, 600);

  setTimeout(() => startFlightPhase(), CONFIG.bettingPhaseMs);
}

function startFlightPhase() {
  if (!currentRound) return;
  currentRound.phase = 'FLYING';
  currentRound.startTime = Date.now();

  broadcast({
    type: 'phase_change',
    data: {
      phase: 'FLYING',
      roundNumber: currentRound.roundNumber,
      startTime: currentRound.startTime,
      serverTime: currentRound.startTime,
    },
  });

  const interval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'FLYING') { clearInterval(interval); return; }
    const elapsed = Date.now() - currentRound.startTime;
    const raw = multiplierAt(elapsed);
    if (raw >= currentRound.crashPoint) {
      currentRound.currentMultiplier = currentRound.crashPoint;
      clearInterval(interval);
      crashRound();
      return;
    }
    const multiplier = Math.floor(raw * 100) / 100;
    currentRound.currentMultiplier = multiplier;

    for (const bet of currentRound.bets) {
      if (bet.cashedOut || !bet.autoCashout) continue;
      if (multiplier < bet.autoCashout) continue;
      if (bet.autoCashout > currentRound.crashPoint) continue;
      // Auto-cashouts are awaited but we don't block the tick on them
      void cashOutBet(bet, bet.autoCashout, 'auto');
    }

    broadcast({ type: 'multiplier_update', data: { multiplier, roundNumber: currentRound.roundNumber } });
  }, 50);
}

async function cashOutBet(bet: Bet, atMultiplier: number, source: 'manual' | 'auto') {
  if (bet.cashedOut) return;
  bet.cashedOut = true;
  bet.cashoutMultiplier = atMultiplier;
  bet.profit = Math.round(bet.amount * atMultiplier * 100) / 100;

  if (!bet.isBot && currentRound) {
    const sessionId = bet.playerId;
    try {
      const newBal = await adjustBalance(sessionId, bet.profit);
      const stats = await recordWin(sessionId, bet.amount, bet.profit, atMultiplier);
      await appendHistory(sessionId, {
        kind: 'cashout',
        roundNumber: currentRound.roundNumber,
        amount: bet.amount,
        multiplier: atMultiplier,
        payout: bet.profit,
        auto: source === 'auto',
        at: Date.now(),
      } satisfies HistoryEntry);
      sendToSession(sessionId, {
        type: 'cashout_success',
        data: { multiplier: atMultiplier, profit: bet.profit, balance: newBal, source, stats },
      });
    } catch (err) {
      if (err instanceof StoreOfflineError) {
        sendToSession(sessionId, { type: 'error', data: { message: 'Session store offline — balance not updated' } });
      } else {
        console.error('[cashout] error:', err);
      }
    }
  }

  broadcast({
    type: 'cashout',
    data: {
      playerId: bet.playerId,
      multiplier: atMultiplier,
      profit: bet.profit,
      isBot: bet.isBot,
      botName: bet.botName,
      displayName: bet.displayName,
      source,
    },
  });
}

function crashRound() {
  if (!currentRound) return;
  currentRound.phase = 'CRASHED';
  currentRound.crashTime = Date.now();
  currentRound.currentMultiplier = currentRound.crashPoint;

  for (const bet of currentRound.bets) {
    if (!bet.cashedOut) bet.profit = -bet.amount;
  }

  prevServerSeed = serverSeed;
  prevRoundNumber = currentRound.roundNumber;

  // Persist losses for sessions that didn't cash out (best-effort, fire and forget)
  for (const bet of currentRound.bets) {
    if (bet.isBot || bet.cashedOut) continue;
    const sessionId = bet.playerId;
    void recordLoss(sessionId).catch(() => {});
    void appendHistory(sessionId, {
      kind: 'crashed',
      roundNumber: currentRound!.roundNumber,
      amount: bet.amount,
      crashPoint: currentRound!.crashPoint,
      serverSeed: serverSeed,
      at: Date.now(),
    } satisfies HistoryEntry).catch(() => {});
    void getStats(sessionId).then((stats) => {
      sendToSession(sessionId, { type: 'stats_update', data: { stats } });
    }).catch(() => {});
  }

  broadcast({
    type: 'crash',
    data: {
      roundNumber: currentRound.roundNumber,
      crashPoint: currentRound.crashPoint,
      serverSeed,
      bets: currentRound.bets,
    },
  });

  roundHistory.push({ roundNumber: currentRound.roundNumber, crashPoint: currentRound.crashPoint });
  if (roundHistory.length > 200) roundHistory.shift();

  setTimeout(() => startResultPhase(), CONFIG.resultPhaseMs);
}

function startResultPhase() {
  if (!currentRound) return;
  broadcast({
    type: 'phase_change',
    data: {
      phase: 'RESULT',
      roundNumber: currentRound.roundNumber,
      crashPoint: currentRound.crashPoint,
      serverSeed,
      history: roundHistory.slice(-30),
      serverTime: Date.now(),
    },
  });
  setTimeout(() => startBettingPhase(), 1500);
}

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

  if (currentRound) {
    const joinData: Record<string, unknown> = {
      roundNumber: currentRound.roundNumber,
      phase: currentRound.phase,
      currentMultiplier: currentRound.currentMultiplier,
      startTime: currentRound.startTime,
      serverTime: Date.now(),
      hashCommit: currentRound.serverSeedHash,
      bets: currentRound.bets,
      history: roundHistory.slice(-30),
      prevServerSeed,
      prevRoundNumber,
    };
    if (currentRound.phase === 'BETTING') {
      const elapsed = Date.now() - currentRound.startTime;
      joinData.countdownMs = Math.max(0, CONFIG.bettingPhaseMs - elapsed);
      joinData.countdownStart = currentRound.startTime;
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

async function handleMessage(
  ws: WebSocket,
  message: Record<string, unknown>,
  attachSession: (sessionId: string) => void,
) {
  const type = message.type as string;
  const data = (message.data as Record<string, unknown>) ?? {};
  const sessionId = String(data.sessionId ?? data.playerId ?? '');

  switch (type) {
    case 'hello': {
      if (!sessionId) {
        safeSend(ws, { type: 'session_invalid', data: { reason: 'sessionId required' } });
        return;
      }
      try {
        const session = await getSession(sessionId);
        if (!session) {
          safeSend(ws, { type: 'session_invalid', data: { sessionId, reason: 'not found' } });
          return;
        }
        attachSession(sessionId);
        sessionMeta.set(sessionId, { displayName: session.displayName });
        const stats = await getStats(sessionId);
        safeSend(ws, {
          type: 'session_hello',
          data: { session, stats },
        });
      } catch (err) {
        if (err instanceof StoreOfflineError) {
          safeSend(ws, { type: 'error', data: { message: 'Session store offline. Start Dragonfly: docker compose up -d dragonfly' } });
        } else {
          console.error('[hello] error:', err);
        }
      }
      return;
    }

    case 'place_bet': {
      if (!currentRound || currentRound.phase !== 'BETTING') {
        safeSend(ws, { type: 'error', data: { message: 'Betting is closed for this round' } });
        return;
      }
      if (!sessionId) { safeSend(ws, { type: 'error', data: { message: 'No session' } }); return; }

      const amountRaw = Number(data.amount);
      const amount = Math.round(amountRaw * 100) / 100;
      const autoCashoutRaw = data.autoCashout == null ? undefined : Number(data.autoCashout);
      const autoCashout =
        autoCashoutRaw != null && Number.isFinite(autoCashoutRaw) && autoCashoutRaw > 1
          ? Math.round(autoCashoutRaw * 100) / 100
          : undefined;

      if (!Number.isFinite(amount) || amount <= 0) {
        safeSend(ws, { type: 'error', data: { message: 'Invalid bet amount' } }); return;
      }
      if (amount > MAX_STAKE) {
        safeSend(ws, { type: 'error', data: { message: `Max stake is $${MAX_STAKE}` } }); return;
      }
      if (currentRound.bets.some((b) => b.playerId === sessionId)) {
        safeSend(ws, { type: 'error', data: { message: 'You already have a bet this round' } }); return;
      }

      try {
        const okRate = await checkRateLimit(sessionId);
        if (!okRate) {
          safeSend(ws, { type: 'error', data: { message: 'Slow down — too many bets per minute' } });
          return;
        }
        const session = await getSession(sessionId);
        if (!session) {
          safeSend(ws, { type: 'session_invalid', data: { sessionId, reason: 'expired or missing' } });
          return;
        }
        if (amount > session.balance) {
          safeSend(ws, { type: 'error', data: { message: 'Insufficient balance' } });
          return;
        }

        const newBalance = await adjustBalance(sessionId, -amount);
        const stats = await recordBet(sessionId, amount);
        await appendHistory(sessionId, {
          kind: 'bet', roundNumber: currentRound.roundNumber, amount, autoCashout, at: Date.now(),
        } satisfies HistoryEntry);

        attachSession(sessionId);
        sessionMeta.set(sessionId, { displayName: session.displayName });

        const bet: Bet = {
          playerId: sessionId,
          amount,
          autoCashout,
          cashedOut: false,
          isBot: false,
          displayName: session.displayName,
        };
        currentRound.bets.push(bet);

        safeSend(ws, { type: 'bet_placed', data: { bet, balance: newBalance, stats } });
        broadcast({
          type: 'new_bet',
          data: {
            playerId: sessionId,
            amount,
            autoCashout,
            isBot: false,
            displayName: session.displayName,
            roundNumber: currentRound.roundNumber,
          },
        });
      } catch (err) {
        if (err instanceof StoreOfflineError) {
          safeSend(ws, { type: 'error', data: { message: 'Session store offline — bet rejected' } });
        } else {
          console.error('[place_bet] error:', err);
          safeSend(ws, { type: 'error', data: { message: 'Bet failed' } });
        }
      }
      return;
    }

    case 'cashout': {
      if (!currentRound || currentRound.phase !== 'FLYING') return;
      if (!sessionId) return;
      const bet = currentRound.bets.find((b) => b.playerId === sessionId);
      if (!bet || bet.cashedOut) return;
      const at = currentRound.currentMultiplier;
      await cashOutBet(bet, at, 'manual');
      return;
    }

    case 'reset_balance': {
      if (!sessionId) return;
      try {
        await setBalance(sessionId, STARTING_BALANCE);
        safeSend(ws, { type: 'balance', data: { sessionId, balance: STARTING_BALANCE } });
      } catch (err) {
        if (err instanceof StoreOfflineError) {
          safeSend(ws, { type: 'error', data: { message: 'Session store offline — reset failed' } });
        }
      }
      return;
    }
  }
}

// ─── SPA fallback ────────────────────────────────────────────────────────────
// Anything that isn't an /api/* route nor a static asset hands back index.html
// so the SPA can render. Direct loads of /?session=abc and similar work.
// Must come AFTER express.static and all /api routes.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws') return next();
  const indexHtml = path.join(clientDist, 'index.html');
  if (!fs.existsSync(indexHtml)) return next();
  res.sendFile(indexHtml);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`[server] listening on ${HOST}:${PORT}`);
  console.log(`[server] RTP=${CONFIG.rtp}  maxMultiplier=${CONFIG.maxMultiplier}  growth=${GROWTH_RATE}`);
  startBettingPhase();
});

export { app, server, wss };
