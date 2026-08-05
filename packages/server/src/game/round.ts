import { DEFAULT_GAME_ID } from '@crash/shared/rng';
import { type RoundState, type Bet } from '@crash/shared/types';
import { GameEngine } from './engine';
import { getOperatorWiringDeps } from './operator-deps';
import { setCurrentRoundRef } from './bets';
import { CONFIG, GROWTH_RATE, multiplierAt } from './config-consts';

// Re-exported so existing importers (index.ts, http/public.ts, tests) keep working.
export { CONFIG, GROWTH_RATE, multiplierAt };

// ─── Engine manager ─────────────────────────────────────────────────────────
// One fully-independent GameEngine per catalogue game. Each runs its own
// betting → flight → crash → result loop, its own seed/crash-point/multiplier,
// and tags every frame with its gameId. Games never wait on one another.
const engines = new Map<string, GameEngine>();

/**
 * Test override — when set, getRoundForGame / findBetForSession return it for
 * every game, so the WS handlers operate on the synthetic round a unit test
 * injected via _internal__setCurrentRoundForTesting (no engine timers involved).
 */
let testRound: RoundState | null = null;

export function getEngine(gameId: string): GameEngine | undefined {
  return engines.get(gameId);
}

/** The live round for a game (or the test override), or null if not running. */
export function getRoundForGame(gameId: string | undefined): RoundState | null {
  if (testRound) return testRound;
  return engines.get(gameId ?? DEFAULT_GAME_ID)?.round ?? null;
}

/** Find a session's active bet for a slot across all engines (for cashout). */
export function findBetForSession(
  sessionId: string,
  slot: number,
): { round: RoundState; bet: Bet } | null {
  const scan = (r: RoundState | null): { round: RoundState; bet: Bet } | null => {
    if (!r) return null;
    const bet = r.bets.find((b) => b.playerId === sessionId && (b.slot ?? 0) === slot && !b.isBot);
    return bet ? { round: r, bet } : null;
  };
  if (testRound) return scan(testRound);
  for (const e of engines.values()) {
    const hit = scan(e.round);
    if (hit) return hit;
  }
  return null;
}

/** Every in-memory bet a session currently holds, across all game engines. */
export function getBetsForSession(sessionId: string): Bet[] {
  if (testRound) return testRound.bets.filter((b) => b.playerId === sessionId);
  const out: Bet[] = [];
  for (const e of engines.values()) {
    if (e.round) out.push(...e.round.bets.filter((b) => b.playerId === sessionId));
  }
  return out;
}

/**
 * Boot / refresh: ensure one always-on engine per active catalogue game.
 * Idempotent — existing engines keep running (rtp is refreshed); new games get
 * a fresh engine started. Call on boot and whenever the games snapshot changes.
 * Falls back to a single default-game engine when the catalogue isn't wired
 * (e.g. tests never call this).
 */
export function startAllEngines(): void {
  const games = getOperatorWiringDeps()?.games?.snapshot();
  const list =
    games && games.length
      ? games.map((g) => ({ gameId: g.gameId, rtp: g.rtp }))
      : [{ gameId: DEFAULT_GAME_ID, rtp: CONFIG.rtp }];
  // Always keep the base game running even if it isn't in the catalogue.
  if (!list.some((g) => g.gameId === DEFAULT_GAME_ID)) {
    list.push({ gameId: DEFAULT_GAME_ID, rtp: CONFIG.rtp });
  }
  for (const g of list) {
    const existing = engines.get(g.gameId);
    if (existing) { existing.setRtp(g.rtp); continue; }
    const engine = new GameEngine(g.gameId, g.rtp);
    engines.set(g.gameId, engine);
    engine.start();
  }
}

// ─── Test-only compat ─────────────────────────────────────────────────────────
/**
 * @internal — testing only. Inject a synthetic round the WS handlers will see
 * via getRoundForGame / findBetForSession, without any engine timers/broadcasts.
 */
export function _internal__setCurrentRoundForTesting(round: RoundState | null): void {
  testRound = round;
  setCurrentRoundRef(round);
}
