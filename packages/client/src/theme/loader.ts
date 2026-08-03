import { DEFAULT_THEME, type Theme } from './types';

const STORAGE_KEY = 'galaxy-crash-theme';
const USER_OVERRIDE_KEY = 'galaxy-crash-theme-user-override'; // 'true' if user manually loaded a theme

/**
 * Merge a partial loaded theme over the defaults so older/partial files
 * still produce a complete Theme object.
 */
function mergeWithDefault(partial: Partial<Theme>): Theme {
  return {
    ...DEFAULT_THEME,
    ...partial,
    colors: { ...DEFAULT_THEME.colors, ...(partial.colors ?? {}) },
    assets: { ...(partial.assets ?? {}) },
    sounds: { ...(partial.sounds ?? {}) },
  };
}

/** Synchronous local read (used for first-paint default). */
export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return mergeWithDefault(JSON.parse(raw));
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

/** True if the user has manually loaded their own theme via the UI. */
export function hasUserOverride(): boolean {
  try { return localStorage.getItem(USER_OVERRIDE_KEY) === 'true'; } catch { return false; }
}

export function saveTheme(theme: Theme, isUserOverride = false) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    if (isUserOverride) localStorage.setItem(USER_OVERRIDE_KEY, 'true');
  } catch { /* ignore */ }
}

/** Clear the user override (and the stored theme). Server theme will be re-applied on next boot. */
export function clearTheme() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(USER_OVERRIDE_KEY);
  } catch { /* ignore */ }
}

/**
 * Fetch the operator-configured theme from /api/theme.
 * Returns null if the server has no theme configured (204) or fetch fails.
 */
export async function fetchServerTheme(): Promise<Theme | null> {
  try {
    // Multi-game: launch redirects to /?session=…&game=<id>. Forward the game
    // so the server serves that catalogue game's theme (falls back to the
    // single active theme when absent).
    const game = new URLSearchParams(location.search).get('game');
    const url = game ? `/api/theme?game=${encodeURIComponent(game)}` : '/api/theme';
    const res = await fetch(url);
    if (res.status === 204 || !res.ok) return null;
    const parsed = await res.json() as Partial<Theme>;
    return mergeWithDefault(parsed);
  } catch {
    return null;
  }
}

export async function readThemeFromFile(file: File): Promise<Theme> {
  const text = await file.text();
  const parsed = JSON.parse(text) as Partial<Theme>;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Theme file must contain a JSON object');
  }
  return mergeWithDefault(parsed);
}

/**
 * Apply the theme's color tokens as CSS custom properties on :root.
 * Tailwind tokens read these vars, so the entire React UI re-skins.
 */
export function applyThemeCssVars(theme: Theme) {
  const root = document.documentElement;
  const c = theme.colors;
  root.style.setProperty('--c-bg-from', c.bgFrom);
  root.style.setProperty('--c-bg-to',   c.bgTo);
  root.style.setProperty('--c-accent',  c.accent);
  root.style.setProperty('--c-accent2', c.accent2);
  root.style.setProperty('--c-win',     c.win);
  root.style.setProperty('--c-crash',   c.crash);
  root.style.setProperty('--c-gold',    c.gold);
  root.style.setProperty('--c-text',    c.text);

  // Also expose rgb triples for use in `rgb(var(--rgb-...)/<alpha>)` cases.
  setRgbVar(root, '--rgb-accent',  c.accent);
  setRgbVar(root, '--rgb-accent2', c.accent2);
  setRgbVar(root, '--rgb-win',     c.win);
  setRgbVar(root, '--rgb-crash',   c.crash);
  setRgbVar(root, '--rgb-gold',    c.gold);
  setRgbVar(root, '--rgb-text',    c.text);
}

function setRgbVar(el: HTMLElement, name: string, hex: string) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
    el.style.setProperty(name, `${r} ${g} ${b}`);
  }
}
