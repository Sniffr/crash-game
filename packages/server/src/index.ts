import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateServerSeed,
  commitSeed,
  crashPointFor,
  buildCommit,
  buildReveal,
  verifyRound,
  DEFAULT_CONFIG,
  type GameConfig,
  type Commit,
  type Reveal,
} from '@crash/shared/rng';
import {
  type RoundPhase,
  type RoundState,
  type Bet,
  type RoundHistoryEntry,
} from '@crash/shared/types';
import { GAME_CONFIG } from '@crash/shared/config';
import { generateBotBets, type BotBet } from './bots';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Game config ──────────────────────────────────────────────────────────────
const CONFIG: GameConfig = {
  rtp: GAME_CONFIG.rtp,
  houseEdge: GAME_CONFIG.houseEdge,
  maxMultiplier: GAME_CONFIG.maxMultiplier,
  minMultiplier: GAME_CONFIG.minMultiplier,
  bettingPhaseMs: GAME_CONFIG.bettingPhaseMs,
  resultPhaseMs: GAME_CONFIG.resultPhaseMs,
};

// ─── Game state ───────────────────────────────────────────────────────────────
let roundNumber = 0;
let currentRound: RoundState | null = null;
let serverSeed = generateServerSeed();
let nextServerSeed = generateServerSeed();
let roundHistory: RoundHistoryEntry[] = [];

// Player balances (in-memory)
const playerBalances = new Map<string, number>();
const clients = new Set<WebSocket>();

// ─── HTTP routes ──────────────────────────────────────────────────────────────
// Serve static files (client build or public directory)
const publicDir = path.join(__dirname, '../../client/dist');
const publicDirDev = path.join(__dirname, '../../client/public');

// Try production build first, fall back to dev public
try {
  app.use(express.static(publicDir));
} catch {
  app.use(express.static(publicDirDev));
}

// API routes
app.get('/api/history', (_req, res) => {
  res.json(roundHistory.slice(-50));
});

app.get('/api/verify', (req, res) => {
  const seed = req.query.seed as string;
  const rn = req.query.roundNumber as string;
  if (!seed || !rn) {
    return res.status(400).json({ error: 'Missing seed or roundNumber' });
  }
  const roundNum = parseInt(rn, 10);
  const crashPoint = crashPointFor(seed, roundNum, CONFIG);
  const hashCommit = commitSeed(seed);
  res.json({ roundNumber: roundNum, serverSeed: seed, crashPoint, hashCommit });
});

app.post('/api/verify', (req, res) => {
  const { seed, roundNumber: rn } = req.body as { seed: string; roundNumber: number };
  if (!seed || !rn) {
    return res.status(400).json({ error: 'Missing seed or roundNumber' });
  }
  const commit: Commit = { roundNumber: rn, hashCommit: commitSeed(seed) };
  const reveal: Reveal = {
    roundNumber: rn,
    serverSeed: seed,
    crashPoint: crashPointFor(seed, rn, CONFIG),
  };
  const result = verifyRound(commit, reveal);
  res.json({ ...result, computedCrash: reveal.crashPoint, revealedSeed: seed });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function ensurePlayerBalance(playerId: string): number {
  if (!playerBalances.has(playerId)) {
    playerBalances.set(playerId, 1000);
  }
  return playerBalances.get(playerId) ?? 1000;
}

// ─── Phase transitions ────────────────────────────────────────────────────────
function startBettingPhase() {
  roundNumber++;
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

  // Generate bot bets
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
      countdownMs: CONFIG.bettingPhaseMs,
      countdownStart: Date.now(),
      bets: currentRound.bets,
    },
  });

  // Broadcast live countdown every 100ms during betting phase
  const countdownInterval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'BETTING') {
      clearInterval(countdownInterval);
      return;
    }
    const elapsed = Date.now() - currentRound.startTime;
    const remaining = Math.max(0, CONFIG.bettingPhaseMs - elapsed);
    broadcast({
      type: 'countdown_update',
      data: {
        countdownMs: remaining,
        roundNumber: currentRound.roundNumber,
      },
    });
  }, 100);

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
    },
  });

  const interval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'FLYING') {
      clearInterval(interval);
      return;
    }

    const elapsed = Date.now() - currentRound.startTime;
    const t = elapsed / 1000;
    const multiplier = Math.round((1 + t * 0.05) * 100) / 100;
    currentRound.currentMultiplier = multiplier;

    // Check auto-cashouts
    for (const bet of currentRound.bets) {
      if (!bet.cashedOut && bet.autoCashout && multiplier >= bet.autoCashout) {
        bet.cashedOut = true;
        bet.cashoutMultiplier = bet.autoCashout;
        bet.profit = Math.round(bet.amount * bet.autoCashout * 100) / 100;
        broadcast({
          type: 'cashout',
          data: {
            playerId: bet.playerId,
            multiplier: bet.autoCashout,
            profit: bet.profit,
            isBot: bet.isBot,
            botName: bet.botName,
          },
        });
      }
    }

    broadcast({
      type: 'multiplier_update',
      data: { multiplier, roundNumber: currentRound.roundNumber },
    });

    if (multiplier >= currentRound.crashPoint) {
      clearInterval(interval);
      crashRound();
    }
  }, 50);
}

function crashRound() {
  if (!currentRound) return;

  currentRound.phase = 'CRASHED';
  currentRound.crashTime = Date.now();

  for (const bet of currentRound.bets) {
    if (!bet.cashedOut) {
      bet.profit = -bet.amount;
    }
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

  roundHistory.push({
    roundNumber: currentRound.roundNumber,
    crashPoint: currentRound.crashPoint,
  });

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
      history: roundHistory.slice(-20),
    },
  });

  setTimeout(() => startBettingPhase(), 2000);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);

  if (currentRound) {
    const joinData: Record<string, unknown> = {
      roundNumber: currentRound.roundNumber,
      phase: currentRound.phase,
      currentMultiplier: currentRound.currentMultiplier,
      startTime: currentRound.startTime,
      hashCommit: currentRound.serverSeedHash,
      bets: currentRound.bets,
      history: roundHistory.slice(-20),
    };
    if (currentRound.phase === 'BETTING') {
      const elapsed = Date.now() - currentRound.startTime;
      joinData.countdownMs = Math.max(0, CONFIG.bettingPhaseMs - elapsed);
      joinData.countdownStart = currentRound.startTime;
    }
    ws.send(JSON.stringify({ type: 'join', data: joinData }));
  }

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (e) {
      console.error('Invalid message:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function handleMessage(ws: WebSocket, message: Record<string, unknown>) {
  const type = message.type as string;
  const data = message.data as Record<string, unknown>;

  switch (type) {
    case 'place_bet': {
      if (!currentRound || currentRound.phase !== 'BETTING') return;

      const amount = Number(data.amount);
      const autoCashout = Number(data.autoCashout);
      const playerId = (data.playerId as string) || `player-${Date.now()}`;

      const balance = ensurePlayerBalance(playerId);
      if (amount > balance || amount <= 0) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: amount > balance ? 'Insufficient balance' : 'Invalid bet amount' },
        }));
        return;
      }

      playerBalances.set(playerId, balance - amount);

      const bet: Bet = {
        playerId,
        amount,
        autoCashout: autoCashout || undefined,
        cashedOut: false,
        isBot: false,
      };

      currentRound.bets.push(bet);

      ws.send(JSON.stringify({
        type: 'bet_placed',
        data: { bet, balance: balance - amount },
      }));

      broadcast({
        type: 'new_bet',
        data: { playerId, amount, isBot: false, roundNumber: currentRound.roundNumber },
      });
      break;
    }

    case 'cashout': {
      if (!currentRound || currentRound.phase !== 'FLYING') return;

      const playerId = data.playerId as string;
      const bet = currentRound.bets.find((b: Bet) => b.playerId === playerId);

      if (bet && !bet.cashedOut) {
        bet.cashedOut = true;
        bet.cashoutMultiplier = currentRound.currentMultiplier;
        bet.profit = Math.round(bet.amount * currentRound.currentMultiplier * 100) / 100;

        const currentBalance = playerBalances.get(playerId) || 0;
        playerBalances.set(playerId, currentBalance + bet.profit);

        ws.send(JSON.stringify({
          type: 'cashout_success',
          data: {
            multiplier: currentRound.currentMultiplier,
            profit: bet.profit,
            balance: playerBalances.get(playerId),
          },
        }));

        broadcast({
          type: 'cashout',
          data: {
            playerId,
            multiplier: currentRound.currentMultiplier,
            profit: bet.profit,
            isBot: false,
          },
        });
      }
      break;
    }

    case 'get_balance': {
      const playerId = (data.playerId as string) || `player-${Date.now()}`;
      const balance = ensurePlayerBalance(playerId);
      ws.send(JSON.stringify({
        type: 'balance',
        data: { playerId, balance },
      }));
      break;
    }

    case 'reset_balance': {
      const playerId = (data.playerId as string) || `player-${Date.now()}`;
      playerBalances.set(playerId, 1000);
      ws.send(JSON.stringify({
        type: 'balance',
        data: { playerId, balance: 1000 },
      }));
      break;
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`RTP: ${CONFIG.rtp}, Max multiplier: ${CONFIG.maxMultiplier}`);
  startBettingPhase();
});

export { app, server, wss };
