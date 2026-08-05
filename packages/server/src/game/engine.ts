import {
  generateServerSeed,
  commitSeed,
  crashPointFor,
  crashPointForMessage,
  crashMessage,
  DEFAULT_GAME_ID,
} from '@crash/shared/rng';
import { type RoundState, type Bet, type HistoryEntry } from '@crash/shared/types';
import { generateBotBets, type BotBet } from '../bots';
import { broadcast, sendToSession } from '../ws/hub';
import { tryCashoutBet, expireOperatorBetsOnCrash, setRoundRefForGame } from './bets';
import { getOperatorWiringDeps } from './operator-deps';
import { pushHistory, getRecentHistory } from './history';
import { recordLoss, appendHistory, getStats } from '../store';
import { CONFIG, GROWTH_RATE } from './config-consts';

function multiplierAt(elapsedMs: number): number {
  return Math.exp((GROWTH_RATE * Math.max(0, elapsedMs)) / 1000);
}

/**
 * One fully-independent crash game: its own betting → flight → crash → result
 * cycle, its own seed / crash point / multiplier / bots / history / bet pool.
 * Every frame it broadcasts is tagged with `gameId`; clients react only to their
 * own game (see the client's handleMessage filter). Games run concurrently and
 * out of phase — a game's round ends the instant IT crashes, never waiting on
 * any other game.
 */
export class GameEngine {
  readonly gameId: string;
  private rtp: number;
  round: RoundState | null = null;

  private roundNumber = 0;
  private serverSeed = generateServerSeed();
  private nextServerSeed = generateServerSeed();
  private prevServerSeed: string | null = null;
  private prevRoundNumber: number | null = null;

  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(gameId: string, rtp: number) {
    this.gameId = gameId;
    this.rtp = rtp;
  }

  setRtp(rtp: number) { this.rtp = rtp; }

  // Read-only accessors for the join snapshot (prev-round reveal).
  get prevSeed(): string | null { return this.prevServerSeed; }
  get prevRound(): number | null { return this.prevRoundNumber; }

  start(): void { this.stopped = false; this.startBettingPhase(); }
  stop(): void { this.stopped = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  private crashPointForThisGame(): number {
    return this.gameId === DEFAULT_GAME_ID
      ? crashPointFor(this.serverSeed, this.roundNumber, CONFIG)
      : crashPointForMessage(
          this.serverSeed,
          crashMessage(this.roundNumber, this.gameId),
          { rtp: this.rtp, maxMultiplier: CONFIG.maxMultiplier },
        );
  }

  // ── Phases ────────────────────────────────────────────────────────────────
  private startBettingPhase(): void {
    this.roundNumber += 1;
    this.serverSeed = this.nextServerSeed;
    this.nextServerSeed = generateServerSeed();

    const crashPoint = this.crashPointForThisGame();
    const hashCommit = commitSeed(this.serverSeed);

    this.round = {
      roundNumber: this.roundNumber,
      phase: 'BETTING',
      crashPoint,
      currentMultiplier: 1.0,
      startTime: Date.now(),
      bets: [],
      serverSeedHash: hashCommit,
    };
    setRoundRefForGame(this.gameId, this.round);

    const botBets = generateBotBets(this.roundNumber);
    this.round.bets = botBets.map((b: BotBet) => ({
      playerId: b.playerId, amount: b.amount, autoCashout: b.autoCashout,
      cashedOut: false, isBot: true, botName: b.botName, gameId: this.gameId,
    }));

    this.emit({
      type: 'phase_change',
      data: {
        gameId: this.gameId, phase: 'BETTING', roundNumber: this.roundNumber, hashCommit,
        prevServerSeed: this.prevServerSeed, prevRoundNumber: this.prevRoundNumber,
        countdownMs: CONFIG.bettingPhaseMs, countdownStart: this.round.startTime,
        serverTime: this.round.startTime, bets: this.round.bets,
      },
    });

    const countdown = setInterval(() => {
      if (this.stopped || !this.round || this.round.phase !== 'BETTING') { clearInterval(countdown); return; }
      const remaining = Math.max(0, CONFIG.bettingPhaseMs - (Date.now() - this.round.startTime));
      this.emit({ type: 'countdown_update', data: { gameId: this.gameId, countdownMs: remaining, roundNumber: this.roundNumber } });
    }, 200);

    const drip = setInterval(() => {
      if (this.stopped || !this.round || this.round.phase !== 'BETTING') { clearInterval(drip); return; }
      if (Math.random() < 0.5 && this.round.bets.filter((b) => b.isBot).length < 40) {
        for (const b of generateBotBets(this.roundNumber, 1, 3)) {
          const bet: Bet = { playerId: b.playerId, amount: b.amount, autoCashout: b.autoCashout, cashedOut: false, isBot: true, botName: b.botName, gameId: this.gameId };
          this.round.bets.push(bet);
          this.emit({ type: 'new_bet', data: { gameId: this.gameId, playerId: bet.playerId, amount: bet.amount, isBot: true, botName: bet.botName, autoCashout: bet.autoCashout, roundNumber: this.roundNumber } });
        }
      }
    }, 600);

    this.later(() => { clearInterval(countdown); clearInterval(drip); this.startFlightPhase(); }, CONFIG.bettingPhaseMs);
  }

  private startFlightPhase(): void {
    if (!this.round) return;
    this.round.phase = 'FLYING';
    this.round.startTime = Date.now();
    this.emit({ type: 'phase_change', data: { gameId: this.gameId, phase: 'FLYING', roundNumber: this.roundNumber, startTime: this.round.startTime, serverTime: this.round.startTime } });

    const interval = setInterval(() => {
      if (this.stopped || !this.round || this.round.phase !== 'FLYING') { clearInterval(interval); return; }
      const raw = multiplierAt(Date.now() - this.round.startTime);
      if (raw >= this.round.crashPoint) {
        this.round.currentMultiplier = this.round.crashPoint;
        clearInterval(interval);
        this.crash();
        return;
      }
      const multiplier = Math.floor(raw * 100) / 100;
      this.round.currentMultiplier = multiplier;

      for (const bet of this.round.bets) {
        if (bet.cashedOut || !bet.autoCashout) continue;
        if (multiplier < bet.autoCashout || bet.autoCashout > this.round.crashPoint) continue;
        void tryCashoutBet(bet, bet.autoCashout, 'auto');
      }

      this.emit({ type: 'multiplier_update', data: { gameId: this.gameId, multiplier, roundNumber: this.roundNumber } });
    }, 50);
  }

  private crash(): void {
    if (!this.round) return;
    this.round.phase = 'CRASHED';
    this.round.crashTime = Date.now();
    this.round.currentMultiplier = this.round.crashPoint;
    const crashPoint = this.round.crashPoint;

    // Losers (this game's non-cashed human bets). Operator → bet_log; lobby →
    // wallet_ledger (already debited at placement); demo → RocksDB.
    for (const bet of this.round.bets) {
      if (!bet.cashedOut) bet.profit = -bet.amount;
      if (bet.isBot || bet.cashedOut || bet.operatorId || bet.lobbyPlayerId) continue;
      const sessionId = bet.playerId;
      void recordLoss(sessionId).catch(() => {});
      void appendHistory(sessionId, { kind: 'crashed', roundNumber: this.roundNumber, amount: bet.amount, crashPoint, serverSeed: this.serverSeed, at: Date.now() } satisfies HistoryEntry).catch(() => {});
      void getStats(sessionId).then((stats) => sendToSession(sessionId, { type: 'stats_update', data: { stats } })).catch(() => {});
    }

    const deps = getOperatorWiringDeps();
    if (deps) {
      // roundId must match operator placement (`rnd-${roundNumber}` in handlers.ts);
      // the gameId arg narrows expiry to THIS game's bets in the shared bet_log.
      void expireOperatorBetsOnCrash({ betLog: deps.betLog }, `rnd-${this.roundNumber}`, this.gameId).catch((err) => console.error(`[engine:${this.gameId}] expireOperatorBetsOnCrash:`, err));
    }

    this.prevServerSeed = this.serverSeed;
    this.prevRoundNumber = this.roundNumber;

    pushHistory({ roundNumber: this.roundNumber, crashPoint }, this.gameId);
    this.emit({ type: 'crash', data: { gameId: this.gameId, roundNumber: this.roundNumber, crashPoint, serverSeed: this.serverSeed, bets: this.round.bets } });

    this.later(() => this.startResultPhase(), CONFIG.resultPhaseMs);
  }

  private startResultPhase(): void {
    if (!this.round) return;
    this.emit({ type: 'phase_change', data: { gameId: this.gameId, phase: 'RESULT', roundNumber: this.roundNumber, crashPoint: this.round.crashPoint, serverSeed: this.serverSeed, history: getRecentHistory(30, this.gameId), serverTime: Date.now() } });
    this.later(() => this.startBettingPhase(), 1500);
  }

  private emit(msg: { type: string; data: Record<string, unknown> }): void {
    broadcast(msg);
  }
}
