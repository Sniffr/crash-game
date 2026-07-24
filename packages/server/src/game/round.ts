import {
  generateServerSeed,
  commitSeed,
  crashPointFor,
  crashPointForMessage,
  crashMessage,
  DEFAULT_GAME_ID,
} from '@crash/shared/rng';
import { type RoundState, type Bet, type GameConfig, type HistoryEntry } from '@crash/shared/types';
import { GAME_CONFIG } from '@crash/shared/config';
import { generateBotBets, type BotBet } from '../bots';
import { broadcast } from '../ws/hub';
import { cashOutBet, tryCashoutBet, expireOperatorBetsOnCrash, setCurrentRoundRef } from './bets';
import { getOperatorWiringDeps } from './operator-deps';
import { pushHistory, getRecentHistory } from './history';
import {
  recordLoss,
  appendHistory,
  getStats,
  StoreOfflineError,
} from '../store';
import { sendToSession } from '../ws/hub';

// ─── Game config ──────────────────────────────────────────────────────────────
export const CONFIG: GameConfig = { ...GAME_CONFIG };

// Multiplier curve: m(t) = e^(GROWTH_RATE * t_seconds).
export const GROWTH_RATE = 0.06;

export function multiplierAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  return Math.exp(GROWTH_RATE * t);
}

// ─── Game state ───────────────────────────────────────────────────────────────
export let roundNumber = 0;
export let currentRound: RoundState | null = null;
export let serverSeed = generateServerSeed();
export let nextServerSeed = generateServerSeed();
export let prevServerSeed: string | null = null;
export let prevRoundNumber: number | null = null;

/**
 * @internal — testing only.
 * Directly set currentRound without running the full phase transition.
 * Allows unit tests to inject a synthetic BETTING round without the
 * timer/broadcast side-effects of startBettingPhase().
 */
export function _internal__setCurrentRoundForTesting(round: RoundState | null): void {
  currentRound = round;
  setCurrentRoundRef(round);
}

// ─── Phase transitions ────────────────────────────────────────────────────────
export function startBettingPhase() {
  roundNumber += 1;
  serverSeed = nextServerSeed;
  nextServerSeed = generateServerSeed();

  const crashPoint = crashPointFor(serverSeed, roundNumber, CONFIG);
  const hashCommit = commitSeed(serverSeed);

  // Multi-game: compute an independent crash point per active catalogue game
  // (domain-separated by gameId). The default game keeps the legacy crash point.
  // The round's `crashPoint` becomes the MAX so the flight covers every game;
  // each game crashes at its own value mid-flight. Absent when the catalogue is
  // not wired (tests) → the round stays single-game and behaves exactly as before.
  // ponytail: live crash points key on each game's BASE rtp (games.rtp), not on
  // per-operator operator_games.rtp_override — one shared round can't fork the
  // stream per operator. The override is stored + honoured at reporting; wire it
  // into the live stream only if per-operator-per-game crash divergence is needed.
  const games = getOperatorWiringDeps()?.games;
  let gameCrashPoints: Record<string, number> | undefined;
  let roundCrashPoint = crashPoint;
  if (games) {
    gameCrashPoints = { [DEFAULT_GAME_ID]: crashPoint };
    for (const g of games.list()) {
      if (g.gameId === DEFAULT_GAME_ID) continue;
      gameCrashPoints[g.gameId] = crashPointForMessage(
        serverSeed,
        crashMessage(roundNumber, g.gameId),
        { rtp: g.rtp, maxMultiplier: CONFIG.maxMultiplier },
      );
    }
    roundCrashPoint = Math.max(...Object.values(gameCrashPoints));
  }

  currentRound = {
    roundNumber,
    phase: 'BETTING',
    crashPoint: roundCrashPoint,
    currentMultiplier: 1.0,
    startTime: Date.now(),
    bets: [],
    serverSeedHash: hashCommit,
    ...(gameCrashPoints ? { gameCrashPoints, gameCrashedAt: {} } : {}),
  };

  // Keep bets.ts in sync with the current round ref
  setCurrentRoundRef(currentRound);

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
      if (currentRound.gameCrashPoints) finalizeMultiGameCrash();
      else crashRound(); // legacy single-game path — byte-unchanged
      return;
    }
    const multiplier = Math.floor(raw * 100) / 100;
    currentRound.currentMultiplier = multiplier;

    for (const bet of currentRound.bets) {
      if (bet.cashedOut || !bet.autoCashout) continue;
      if (multiplier < bet.autoCashout) continue;
      const gcp = gameCrashPointFor(bet.gameId);
      if (bet.autoCashout > gcp) continue;
      // Skip if this bet's game already crashed this round.
      if (currentRound.gameCrashedAt?.[bet.gameId ?? DEFAULT_GAME_ID] != null) continue;
      // Auto-cashouts are awaited but we don't block the tick on them
      void tryCashoutBet(bet, bet.autoCashout, 'auto');
    }

    // Multi-game: crash each game as the climbing multiplier reaches its point.
    if (currentRound.gameCrashPoints) {
      for (const [gid, gcp] of Object.entries(currentRound.gameCrashPoints)) {
        if (currentRound.gameCrashedAt![gid] != null) continue;
        if (multiplier >= gcp) crashOneGame(gid, gcp);
      }
    }

    broadcast({ type: 'multiplier_update', data: { multiplier, roundNumber: currentRound.roundNumber } });
  }, 50);
}

/** This bet's game crash point, or the round crash point (single-game fallback). */
function gameCrashPointFor(gameId: string | undefined): number {
  if (!currentRound) return Infinity;
  return currentRound.gameCrashPoints?.[gameId ?? DEFAULT_GAME_ID] ?? currentRound.crashPoint;
}

/**
 * Crash a SINGLE game mid-flight (multi-game rounds only): record losses for
 * that game's players, expire its operator bets, and broadcast a crash frame
 * tagged with gameId. The server seed is NOT revealed here — revealing it would
 * let players compute sibling games' crash points before those games crash. The
 * reveal happens once at round end (RESULT phase, as always).
 */
function crashOneGame(gameId: string, atCrashPoint: number): void {
  if (!currentRound || !currentRound.gameCrashedAt) return;
  if (currentRound.gameCrashedAt[gameId] != null) return;
  currentRound.gameCrashedAt[gameId] = Date.now();

  for (const bet of currentRound.bets) {
    if ((bet.gameId ?? DEFAULT_GAME_ID) !== gameId) continue;
    if (bet.cashedOut) continue;
    bet.profit = -bet.amount;
    if (bet.isBot || bet.operatorId) continue; // operator losses → bet_log below
    const sessionId = bet.playerId;
    void recordLoss(sessionId).catch(() => {});
    void appendHistory(sessionId, {
      kind: 'crashed',
      roundNumber: currentRound!.roundNumber,
      amount: bet.amount,
      crashPoint: atCrashPoint,
      serverSeed,
      at: Date.now(),
    } satisfies HistoryEntry).catch(() => {});
    void getStats(sessionId).then((stats) => {
      sendToSession(sessionId, { type: 'stats_update', data: { stats } });
    }).catch(() => {});
  }

  const roundId = `rnd-${currentRound.roundNumber}`;
  const wiringDeps = getOperatorWiringDeps();
  if (wiringDeps) {
    void expireOperatorBetsOnCrash({ betLog: wiringDeps.betLog }, roundId, gameId).catch((err) => {
      console.error('[crashOneGame] expireOperatorBetsOnCrash error:', err);
    });
  }

  // Per-game history strip: record this game's crash in its own series.
  pushHistory({ roundNumber: currentRound.roundNumber, crashPoint: atCrashPoint }, gameId);

  broadcast({
    type: 'crash',
    data: {
      roundNumber: currentRound.roundNumber,
      gameId,
      crashPoint: atCrashPoint,
      bets: currentRound.bets.filter((b) => (b.gameId ?? DEFAULT_GAME_ID) === gameId),
    },
  });
}

/**
 * End a multi-game round: crash any games that haven't hit their point yet
 * (the max-crash game[s]), then do the global round-end bookkeeping and reveal.
 */
function finalizeMultiGameCrash(): void {
  if (!currentRound || !currentRound.gameCrashPoints) return;
  currentRound.phase = 'CRASHED';
  currentRound.crashTime = Date.now();
  currentRound.currentMultiplier = currentRound.crashPoint;

  for (const [gid, gcp] of Object.entries(currentRound.gameCrashPoints)) {
    crashOneGame(gid, gcp);
  }

  prevServerSeed = serverSeed;
  prevRoundNumber = currentRound.roundNumber;

  // Per-game history is recorded inside crashOneGame (called above for every game).
  setTimeout(() => startResultPhase(), CONFIG.resultPhaseMs);
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

  // Persist losses for sessions that didn't cash out (best-effort, fire and forget).
  // Operator-backed bets are skipped here — their loss state is recorded in bet_log
  // by expireOperatorBetsOnCrash below (no RocksDB/wallet call needed).
  for (const bet of currentRound.bets) {
    if (bet.isBot || bet.cashedOut) continue;
    if (bet.operatorId) continue; // operator bets handled by expireOperatorBetsOnCrash
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

  // Expire operator-backed bets on crash: marks ARMED/FLYING → LOST in bet_log
  const roundId = `rnd-${currentRound.roundNumber}`;
  const wiringDeps = getOperatorWiringDeps();
  if (wiringDeps) {
    void expireOperatorBetsOnCrash({ betLog: wiringDeps.betLog }, roundId).catch((err) => {
      console.error('[crashRound] expireOperatorBetsOnCrash error:', err);
    });
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

  pushHistory({ roundNumber: currentRound.roundNumber, crashPoint: currentRound.crashPoint });

  setTimeout(() => startResultPhase(), CONFIG.resultPhaseMs);
}

function startResultPhase() {
  if (!currentRound) return;
  broadcast({
    type: 'phase_change',
    data: {
      phase: 'RESULT',
      roundNumber: currentRound.roundNumber,
      // Multi-game: omit crashPoint so each client keeps its own game's value
      // (set at that game's crash frame). Single-game: reveal it as before.
      ...(currentRound.gameCrashPoints ? {} : { crashPoint: currentRound.crashPoint }),
      serverSeed,
      history: getRecentHistory(30),
      serverTime: Date.now(),
    },
  });
  setTimeout(() => startBettingPhase(), 1500);
}
