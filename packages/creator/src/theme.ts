// ─── Theme types ────────────────────────────────────────────────────────────

export type SpriteKey = 'rocket' | 'jet' | 'biplane' | 'ufo';
export type BackgroundKey = 'galaxy' | 'sunset' | 'deep_sea' | 'cyber';

export interface ThemeColors {
  bgFrom: string;   // background gradient top
  bgTo: string;     // background gradient bottom
  accent: string;   // primary curve / sprite trim
  accent2: string;  // secondary accent
  win: string;      // cashed-out green
  crash: string;    // crash red
  gold: string;     // big-win tier color
  text: string;     // foreground
}

/**
 * Custom assets — all stored as base64 data URLs so a theme can be a single
 * portable JSON file. When `null` / omitted, the procedural defaults are used.
 *
 * Sprite states:
 *   • spriteGround  — shown during BETTING and FLYING when multiplier is
 *                     below `spriteTransitionAt` (the rocket sitting on the pad).
 *   • spriteFlying  — shown during FLYING once multiplier crosses the threshold.
 *   • spriteCrashed — shown during the crash animation instead of the flying
 *                     sprite tilted off-screen.
 *   • sprite        — legacy single sprite. If no per-state sprites are
 *                     uploaded, this is used for all three states.
 */
export interface ThemeAssets {
  sprite?: string | null;          // legacy single sprite
  spriteGround?: string | null;    // pre-launch / idle
  spriteFlying?: string | null;    // mid-flight (after transition multiplier)
  spriteCrashed?: string | null;   // crashed / explosion
  background?: string | null;      // PNG/JPG — replaces the procedural background
  logo?: string | null;            // PNG/SVG — replaces the procedural logo
}

/** Background motion when a custom background image is set. */
export type BgDirection = 'none' | 'left' | 'right' | 'up' | 'down';
export type BgSpeed = 'slow' | 'medium' | 'fast';

export interface BackgroundMotion {
  direction: BgDirection;
  speed: BgSpeed;
}

export const DEFAULT_BG_MOTION: BackgroundMotion = { direction: 'none', speed: 'medium' };

/** Convert speed enum to pixels-per-second. */
export function speedPxPerSec(speed: BgSpeed): number {
  return speed === 'slow' ? 30 : speed === 'fast' ? 140 : 70;
}

/**
 * How the sprite moves along the elliptic arc.
 *   • cruisePoint   — fraction of the arc the sprite settles on (0.5–0.95)
 *   • bobAmplitude  — fraction of the arc to slide back and forth (0–0.20)
 *   • bobPeriodMs   — one complete back-and-forth cycle in ms (400–4000)
 */
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
  takeoff?: string | null;      // audio/* — plays when the round transitions to FLYING
  cashout?: string | null;      // audio/* — plays on successful cashout
  crash?:   string | null;      // audio/* — plays on round crash
  bet?:     string | null;      // audio/* — plays when a bet is placed
  tick?:    string | null;      // audio/* — generic UI click
  music?:   string | null;      // audio/* — loops in the background
}

export interface Theme {
  // Theme pack format version — bump when breaking changes are made
  version?: number;

  brandName: string;
  brandTagline: string;
  sprite: SpriteKey;
  background: BackgroundKey;
  colors: ThemeColors;
  rtp: number;            // 0.80–0.99
  growthRate: number;     // 0.03–0.15  (exponent per second)
  bettingMs: number;      // 3000–10000
  maxMultiplier: number;  // 100–10000

  /** Optional uploaded assets — when present override the procedural defaults. */
  assets?: ThemeAssets;
  sounds?: ThemeSounds;

  /** How to animate a custom background image during FLYING. */
  backgroundMotion?: BackgroundMotion;
  /** Multiplier at which the sprite swaps from ground → flying. Default 1.5. */
  spriteTransitionAt?: number;
  /** How the sprite moves along the elliptic arc during cruise. */
  flightAnimation?: FlightAnimation;
}

export const THEME_VERSION = 1;

// ─── Presets ────────────────────────────────────────────────────────────────

export const PRESETS: Record<string, Theme> = {
  galaxy: {
    brandName: 'Galaxy Crash',
    brandTagline: 'Provably-fair multiplier',
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
  },

  sunset: {
    brandName: 'Skyline Cruise',
    brandTagline: 'Climb above the clouds',
    sprite: 'biplane',
    background: 'sunset',
    colors: {
      bgFrom: '#fb923c',
      bgTo:   '#7c2d12',
      accent: '#fcd34d',
      accent2:'#f472b6',
      win:    '#bef264',
      crash:  '#dc2626',
      gold:   '#fde047',
      text:   '#fff7ed',
    },
    rtp: 0.97,
    growthRate: 0.07,
    bettingMs: 5000,
    maxMultiplier: 5000,
  },

  deep_sea: {
    brandName: 'Abyss Ascent',
    brandTagline: 'Surface before the pressure',
    sprite: 'ufo',
    background: 'deep_sea',
    colors: {
      bgFrom: '#082f49',
      bgTo:   '#020617',
      accent: '#67e8f9',
      accent2:'#86efac',
      win:    '#4ade80',
      crash:  '#f43f5e',
      gold:   '#facc15',
      text:   '#e0f2fe',
    },
    rtp: 0.97,
    growthRate: 0.05,
    bettingMs: 6000,
    maxMultiplier: 5000,
  },

  cyber: {
    brandName: 'NEONRUN',
    brandTagline: 'Push your luck on the grid',
    sprite: 'jet',
    background: 'cyber',
    colors: {
      bgFrom: '#1e1b4b',
      bgTo:   '#000000',
      accent: '#ec4899',
      accent2:'#8b5cf6',
      win:    '#22d3ee',
      crash:  '#f97316',
      gold:   '#facc15',
      text:   '#fdf4ff',
    },
    rtp: 0.97,
    growthRate: 0.08,
    bettingMs: 4500,
    maxMultiplier: 10000,
  },
};

export const SPRITE_OPTIONS: { key: SpriteKey; label: string; description: string }[] = [
  { key: 'rocket',  label: 'Rocket',   description: 'Chrome retro rocket with thrust flame' },
  { key: 'jet',     label: 'Fighter Jet', description: 'Sleek modern delta-wing jet' },
  { key: 'biplane', label: 'Biplane',  description: 'Classic propeller plane' },
  { key: 'ufo',     label: 'UFO',      description: 'Saucer with rotating lights' },
];

export const BACKGROUND_OPTIONS: { key: BackgroundKey; label: string; description: string }[] = [
  { key: 'galaxy',   label: 'Galaxy',     description: 'Nebula clouds + parallax starfield' },
  { key: 'sunset',   label: 'Sunset Sky', description: 'Warm gradient with mountains' },
  { key: 'deep_sea', label: 'Deep Sea',   description: 'Bubbles rising + light rays' },
  { key: 'cyber',    label: 'Cyber Grid', description: 'Neon perspective grid' },
];

// Tier color resolver — same logic as the game.
export function tierColor(theme: Theme, m: number): string {
  if (m >= 10) return theme.colors.gold;
  if (m >= 5)  return theme.colors.accent2;
  if (m >= 2)  return theme.colors.accent;
  return theme.colors.win;
}
