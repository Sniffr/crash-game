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
} from '@crash/shared/types';
import { GAME_CONFIG } from '@crash/shared/config';
import { generateBotBets, sampleBotAutoCashout, type BotBet } from './bots';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Game config ──────────────────────────────────────────────────────────────
const CONFIG: GameConfig = { ...GAME_CONFIG };

// Multiplier curve: m(t) = e^(GROWTH_RATE * t_seconds).
// 0.06 → 2x at ~11.5s, 5x at ~27s, 10x at ~38s, 100x at ~77s.
// Matches the spec's `~e^(0.06 * t_seconds)` comment in §4.4.
const GROWTH_RATE = 0.06;
const STARTING_BALANCE = 1000;

function multiplierAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  return Math.exp(GROWTH_RATE * t);
}

// ─── Game state ───────────────────────────────────────────────────────────────
let roundNumber = 0;
let currentRound: RoundState | null = null;
let serverSeed = generateServerSeed();
let nextServerSeed = generateServerSeed();
let prevServerSeed: string | null = null; // revealed seed of the round JUST finished
let prevRoundNumber: number | null = null;
const roundHistory: RoundHistoryEntry[] = [];

// Player balances (in-memory) + ws lookup so auto-cashout can notify the player
const playerBalances = new Map<string, number>();
const playerSockets = new Map<string, Set<WebSocket>>(); // many tabs per player
const clients = new Set<WebSocket>();

// ─── HTTP routes ──────────────────────────────────────────────────────────────
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// ─── Theme autoload ───────────────────────────────────────────────────────────
// Drop a theme JSON at <repo>/config/active-theme.json to have the server
// serve it as the default theme for every client that boots.
const THEME_PATH = path.join(__dirname, '../../../config/active-theme.json');
let activeTheme: unknown | null = null;

function loadActiveTheme() {
  try {
    if (fs.existsSync(THEME_PATH)) {
      const raw = fs.readFileSync(THEME_PATH, 'utf-8');
      activeTheme = JSON.parse(raw);
      console.log(`Theme loaded from ${THEME_PATH}`);
    } else {
      activeTheme = null;
    }
  } catch (e) {
    console.error('Failed to load active theme:', (e as Error).message);
    activeTheme = null;
  }
}
loadActiveTheme();

// Watch for theme file changes (added/edited) so reloads are picked up
// without restarting the server. fs.watch can be flaky on macOS so we use
// a simple debounced re-read.
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
  console.warn('Theme file watcher disabled:', (e as Error).message);
}

app.get('/api/theme', (_req, res) => {
  if (activeTheme == null) {
    res.status(204).end();
    return;
  }
  res.json(activeTheme);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, roundNumber, hasTheme: activeTheme != null }));

app.get('/api/history', (_req, res) => {
  res.json(roundHistory.slice(-50));
});

app.get('/api/verify', (req, res) => {
  const seed = String(req.query.seed ?? '');
  const rn = String(req.query.roundNumber ?? '');
  if (!seed || !rn) {
    return res.status(400).json({ error: 'Missing seed or roundNumber' });
  }
  const roundNum = parseInt(rn, 10);
  if (!Number.isFinite(roundNum)) {
    return res.status(400).json({ error: 'roundNumber must be an integer' });
  }
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
  if (!seed || rn == null) {
    return res.status(400).json({ error: 'Missing seed or roundNumber' });
  }
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendToPlayer(playerId: string, message: Record<string, unknown>) {
  const sockets = playerSockets.get(playerId);
  if (!sockets) return;
  const data = JSON.stringify(message);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function ensurePlayerBalance(playerId: string): number {
  if (!playerBalances.has(playerId)) {
    playerBalances.set(playerId, STARTING_BALANCE);
  }
  return playerBalances.get(playerId)!;
}

function publicBets(round: RoundState): Bet[] {
  // Same shape; included as a helper in case we ever want to redact fields.
  return round.bets;
}

// ─── Phase transitions ────────────────────────────────────────────────────────
function startBettingPhase() {
  roundNumber += 1;
  // Rotate seeds: the seed for THIS round is the one we generated last round.
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

  // Pre-fill bot bets immediately so the player list has activity.
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

  // Tick out the countdown every 200ms so clients can show 5..4..3..2..1
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
  }, 200);

  // Drip more bot bets in during the betting window — feels alive
  const dripInterval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'BETTING') {
      clearInterval(dripInterval);
      return;
    }
    if (Math.random() < 0.5 && currentRound.bets.filter((b) => b.isBot).length < 40) {
      const more = generateBotBets(roundNumber, 1, 3);
      for (const b of more) {
        const bet: Bet = {
          playerId: b.playerId,
          amount: b.amount,
          autoCashout: b.autoCashout,
          cashedOut: false,
          isBot: true,
          botName: b.botName,
        };
        currentRound.bets.push(bet);
        broadcast({
          type: 'new_bet',
          data: {
            playerId: bet.playerId,
            amount: bet.amount,
            isBot: true,
            botName: bet.botName,
            autoCashout: bet.autoCashout,
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

  // 50ms tick = 20 broadcasts/s — plenty smooth, the client interpolates
  // between ticks via its own animation frame.
  const interval = setInterval(() => {
    if (!currentRound || currentRound.phase !== 'FLYING') {
      clearInterval(interval);
      return;
    }

    const elapsed = Date.now() - currentRound.startTime;
    const raw = multiplierAt(elapsed);

    // Did we crash?
    if (raw >= currentRound.crashPoint) {
      currentRound.currentMultiplier = currentRound.crashPoint;
      clearInterval(interval);
      crashRound();
      return;
    }

    const multiplier = Math.floor(raw * 100) / 100;
    currentRound.currentMultiplier = multiplier;

    // Auto-cashouts. Important: target may be BETWEEN the previous tick and
    // this one. We honor the target value exactly (the player gets paid at
    // their requested multiplier, not the inflated current tick).
    for (const bet of currentRound.bets) {
      if (bet.cashedOut || !bet.autoCashout) continue;
      if (multiplier < bet.autoCashout) continue;
      // Also guard: if autoCashout > the predetermined crash point, this
      // shouldn't fire — but the crash check above handles that path.
      if (bet.autoCashout > currentRound.crashPoint) continue;

      cashOutBet(bet, bet.autoCashout, 'auto');
    }

    broadcast({
      type: 'multiplier_update',
      data: { multiplier, roundNumber: currentRound.roundNumber },
    });
  }, 50);
}

function cashOutBet(bet: Bet, atMultiplier: number, source: 'manual' | 'auto') {
  if (bet.cashedOut) return;
  bet.cashedOut = true;
  bet.cashoutMultiplier = atMultiplier;
  bet.profit = Math.round(bet.amount * atMultiplier * 100) / 100;

  // Credit real players (bots aren't tracked in playerBalances)
  if (!bet.isBot) {
    const bal = ensurePlayerBalance(bet.playerId);
    const newBal = Math.round((bal + bet.profit) * 100) / 100;
    playerBalances.set(bet.playerId, newBal);
    sendToPlayer(bet.playerId, {
      type: 'cashout_success',
      data: {
        multiplier: atMultiplier,
        profit: bet.profit,
        balance: newBal,
        source,
      },
    });
  }

  broadcast({
    type: 'cashout',
    data: {
      playerId: bet.playerId,
      multiplier: atMultiplier,
      profit: bet.profit,
      isBot: bet.isBot,
      botName: bet.botName,
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
    if (!bet.cashedOut) {
      bet.profit = -bet.amount; // already deducted, just bookkeeping
    }
  }

  // Reveal the seed for THIS round so anyone can verify.
  prevServerSeed = serverSeed;
  prevRoundNumber = currentRound.roundNumber;

  broadcast({
    type: 'crash',
    data: {
      roundNumber: currentRound.roundNumber,
      crashPoint: currentRound.crashPoint,
      serverSeed,
      bets: publicBets(currentRound),
    },
  });

  roundHistory.push({
    roundNumber: currentRound.roundNumber,
    crashPoint: currentRound.crashPoint,
  });
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

  // Short delay then start the next betting phase.
  setTimeout(() => startBettingPhase(), 1500);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  let claimedPlayerId: string | null = null;

  function attachPlayer(playerId: string) {
    if (claimedPlayerId === playerId) return;
    if (claimedPlayerId) {
      // Detach from old slot
      const old = playerSockets.get(claimedPlayerId);
      old?.delete(ws);
      if (old && old.size === 0) playerSockets.delete(claimedPlayerId);
    }
    claimedPlayerId = playerId;
    if (!playerSockets.has(playerId)) playerSockets.set(playerId, new Set());
    playerSockets.get(playerId)!.add(ws);
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
    ws.send(JSON.stringify({ type: 'join', data: joinData }));
  }

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message, attachPlayer);
    } catch (e) {
      console.error('Invalid message:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (claimedPlayerId) {
      const set = playerSockets.get(claimedPlayerId);
      set?.delete(ws);
      if (set && set.size === 0) playerSockets.delete(claimedPlayerId);
    }
  });
});

function handleMessage(
  ws: WebSocket,
  message: Record<string, unknown>,
  attachPlayer: (playerId: string) => void,
) {
  const type = message.type as string;
  const data = (message.data as Record<string, unknown>) ?? {};

  switch (type) {
    case 'hello':
    case 'get_balance': {
      const playerId = String(data.playerId ?? '');
      if (!playerId) return;
      attachPlayer(playerId);
      const balance = ensurePlayerBalance(playerId);
      ws.send(JSON.stringify({ type: 'balance', data: { playerId, balance } }));
      return;
    }

    case 'place_bet': {
      if (!currentRound || currentRound.phase !== 'BETTING') {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Betting is closed for this round' },
        }));
        return;
      }
      const playerId = String(data.playerId ?? '');
      if (!playerId) return;
      attachPlayer(playerId);

      const amountRaw = Number(data.amount);
      const amount = Math.round(amountRaw * 100) / 100;
      const autoCashoutRaw = data.autoCashout == null ? undefined : Number(data.autoCashout);
      const autoCashout =
        autoCashoutRaw != null && Number.isFinite(autoCashoutRaw) && autoCashoutRaw > 1
          ? Math.round(autoCashoutRaw * 100) / 100
          : undefined;

      const balance = ensurePlayerBalance(playerId);
      if (!Number.isFinite(amount) || amount <= 0) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Invalid bet amount' },
        }));
        return;
      }
      if (amount > balance) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Insufficient balance' },
        }));
        return;
      }
      // One active bet per player per round
      if (currentRound.bets.some((b) => b.playerId === playerId)) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'You already have a bet this round' },
        }));
        return;
      }

      const newBalance = Math.round((balance - amount) * 100) / 100;
      playerBalances.set(playerId, newBalance);

      const bet: Bet = {
        playerId,
        amount,
        autoCashout,
        cashedOut: false,
        isBot: false,
      };
      currentRound.bets.push(bet);

      ws.send(JSON.stringify({
        type: 'bet_placed',
        data: { bet, balance: newBalance },
      }));
      broadcast({
        type: 'new_bet',
        data: {
          playerId,
          amount,
          autoCashout,
          isBot: false,
          roundNumber: currentRound.roundNumber,
        },
      });
      return;
    }

    case 'cashout': {
      if (!currentRound || currentRound.phase !== 'FLYING') return;
      const playerId = String(data.playerId ?? '');
      const bet = currentRound.bets.find((b) => b.playerId === playerId);
      if (!bet || bet.cashedOut) return;
      const at = currentRound.currentMultiplier;
      cashOutBet(bet, at, 'manual');
      return;
    }

    case 'reset_balance': {
      const playerId = String(data.playerId ?? '');
      if (!playerId) return;
      playerBalances.set(playerId, STARTING_BALANCE);
      ws.send(JSON.stringify({
        type: 'balance',
        data: { playerId, balance: STARTING_BALANCE },
      }));
      return;
    }
  }
}

// Silence unused warnings — keep for future helper use
void sampleBotAutoCashout;

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => {
  console.log(`Crash game server listening on :${PORT}`);
  console.log(`RTP=${CONFIG.rtp}  maxMultiplier=${CONFIG.maxMultiplier}  growth=${GROWTH_RATE}`);
  startBettingPhase();
});

export { app, server, wss };
