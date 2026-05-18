/**
 * Theme types for loaded crash-game theme packs.
 * MUST stay in sync with packages/creator/src/theme.ts (compatible JSON shape).
 */

export type SpriteKey = 'rocket' | 'jet' | 'biplane' | 'ufo';
export type BackgroundKey = 'galaxy' | 'sunset' | 'deep_sea' | 'cyber';

export interface ThemeColors {
  bgFrom: string;
  bgTo: string;
  accent: string;
  accent2: string;
  win: string;
  crash: string;
  gold: string;
  text: string;
}

export interface ThemeAssets {
  sprite?: string | null;          // legacy single sprite
  spriteGround?: string | null;    // shown during BETTING + early flight (< spriteTransitionAt)
  spriteFlying?: string | null;    // shown during FLYING once multiplier crosses threshold
  spriteCrashed?: string | null;   // shown during the crash animation
  background?: string | null;
  logo?: string | null;
}

export type BgDirection = 'none' | 'left' | 'right' | 'up' | 'down';
export type BgSpeed = 'slow' | 'medium' | 'fast';
export interface BackgroundMotion {
  direction: BgDirection;
  speed: BgSpeed;
  /** Scale scroll speed by the current multiplier (clamped to [0.5, 10]). */
  tieToMultiplier?: boolean;
}

export const DEFAULT_BG_MOTION: BackgroundMotion = { direction: 'none', speed: 'medium', tieToMultiplier: false };

export function speedPxPerSec(speed: BgSpeed): number {
  return speed === 'slow' ? 30 : speed === 'fast' ? 140 : 70;
}

/** Effective scroll speed in pixels per second given motion + current multiplier. */
export function effectiveBgSpeed(motion: BackgroundMotion | undefined, multiplier: number): number {
  if (!motion) return 0;
  const base = speedPxPerSec(motion.speed);
  if (!motion.tieToMultiplier) return base;
  return base * Math.max(0.5, Math.min(10, multiplier));
}

export interface FlightAnimation {
  cruisePoint: number;
  bobAmplitude: number;
  bobPeriodMs: number;
}

export const DEFAULT_FLIGHT_ANIMATION: FlightAnimation = {
  cruisePoint:  0.80,
  bobAmplitude: 0.08,
  bobPeriodMs:  1500,
};

/** Shape of the flight path the sprite traces. */
export type FlightTrajectory = 'elliptic' | 'straight';
export const DEFAULT_FLIGHT_TRAJECTORY: FlightTrajectory = 'elliptic';

/** Two crash-game rendering modes: procedural sprite-on-curve, or full-screen GIFs. */
export type GameType = 'sprite' | 'gif';

export interface ThemeGifs {
  loading?: string | null;
  flying?: string | null;
  flyingThreshold?: string | null;
  flyingThresholdAt?: number;
  crashed?: string | null;
}

export const DEFAULT_GIF_THRESHOLD_AT = 2.0;

export interface ThemeSounds {
  takeoff?: string | null;
  cashout?: string | null;
  crash?: string | null;
  bet?: string | null;
  tick?: string | null;
  music?: string | null;
}

export interface Theme {
  version?: number;
  brandName: string;
  brandTagline: string;
  sprite: SpriteKey;
  background: BackgroundKey;
  colors: ThemeColors;
  rtp: number;
  growthRate: number;
  bettingMs: number;
  maxMultiplier: number;
  assets?: ThemeAssets;
  sounds?: ThemeSounds;
  backgroundMotion?: BackgroundMotion;
  /** Multiplier at which the sprite swaps from ground → flying. Default 1.5. */
  spriteTransitionAt?: number;
  /** Flight animation tuning. */
  flightAnimation?: FlightAnimation;
  /** Shape of the flight path: 'elliptic' (default) or 'straight'. */
  flightTrajectory?: FlightTrajectory;
  gameType?: GameType;
  gifs?: ThemeGifs;
}

export const THEME_VERSION = 1;

/** The built-in Galaxy Crash theme. */
export const DEFAULT_THEME: Theme = {
  version: THEME_VERSION,
  brandName: 'Galaxy Crash',
  brandTagline: 'provably-fair multiplier',
  sprite: 'rocket',
  background: 'galaxy',
  colors: {
    bgFrom: '#0a0820',
    bgTo:   '#04030d',
    accent: '#22d3ee',
    accent2:'#a855f7',
    win:    '#34d399',
    crash:  '#ef4444',
    gold:   '#fbbf24',
    text:   '#e6e3f5',
  },
  rtp: 0.97,
  growthRate: 0.06,
  bettingMs: 5000,
  maxMultiplier: 10000,
};

export function tierColor(theme: Theme, m: number): string {
  if (m >= 10) return theme.colors.gold;
  if (m >= 5)  return theme.colors.accent2;
  if (m >= 2)  return theme.colors.accent;
  return theme.colors.win;
}
