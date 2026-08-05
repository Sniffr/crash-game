import { type GameConfig } from '@crash/shared/types';
import { GAME_CONFIG } from '@crash/shared/config';

// Shared game constants. Kept out of round.ts so the per-game engine can import
// them without a circular dependency (round.ts imports the engine).
export const CONFIG: GameConfig = { ...GAME_CONFIG };

// Multiplier curve: m(t) = e^(GROWTH_RATE * t_seconds).
export const GROWTH_RATE = 0.06;

export function multiplierAt(elapsedMs: number): number {
  return Math.exp((GROWTH_RATE * Math.max(0, elapsedMs)) / 1000);
}
