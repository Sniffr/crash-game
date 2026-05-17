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
}

export const DEFAULT_BG_MOTION: BackgroundMotion = { direction: 'none', speed: 'medium' };

export function speedPxPerSec(speed: BgSpeed): number {
  return speed === 'slow' ? 30 : speed === 'fast' ? 140 : 70;
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
