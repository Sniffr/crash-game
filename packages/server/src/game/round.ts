import { DEFAULT_GAME_ID } from '@crash/shared/rng';
import { DEFAULT_GROWTH_RATE, type GrowthSegment } from '@crash/shared/curve';
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
  const base = { gameId: DEFAULT_GAME_ID, rtp: CONFIG.rtp, rate: DEFAULT_GROWTH_RATE, segments: undefined as GrowthSegment[] | undefined };
  const list =
    games && games.length
      ? games.map((g) => ({ gameId: g.gameId, rtp: g.rtp, ...growthOf(g.theme) }))
      : [base];
  // Always keep the base game running even if it isn't in the catalogue.
  if (!list.some((g) => g.gameId === DEFAULT_GAME_ID)) list.push(base);
  for (const g of list) {
    const existing = engines.get(g.gameId);
    if (existing) { existing.setRtp(g.rtp); existing.setGrowth(g.rate, g.segments); continue; }
    const engine = new GameEngine(g.gameId, g.rtp, g.rate, g.segments);
    engines.set(g.gameId, engine);
    engine.start();
  }
}

/** Read a game's growth curve (base rate + optional piecewise bands) from its theme. */
function growthOf(theme: unknown): { rate: number; segments?: GrowthSegment[] } {
  const t = theme as { growthRate?: unknown; growthSegments?: unknown } | undefined;
  const rate = typeof t?.growthRate === 'number' && t.growthRate > 0 ? t.growthRate : DEFAULT_GROWTH_RATE;
  const segments = Array.isArray(t?.growthSegments) && t.growthSegments.length > 0
    ? (t.growthSegments as GrowthSegment[])
    : undefined;
  return { rate, segments };
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
