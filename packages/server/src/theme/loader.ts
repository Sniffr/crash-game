import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Theme autoload ───────────────────────────────────────────────────────────
export const THEME_PATH = path.join(__dirname, '../../../../config/active-theme.json');
let activeTheme: unknown | null = null;

export function loadActiveTheme() {
  try {
    if (fs.existsSync(THEME_PATH)) {
      const raw = fs.readFileSync(THEME_PATH, 'utf-8');
      activeTheme = JSON.parse(raw);
      console.log(`[theme] loaded from ${THEME_PATH}`);
    } else {
      activeTheme = null;
    }
  } catch (e) {
    console.error('[theme] failed to load:', (e as Error).message);
    activeTheme = null;
  }
}

export function getActiveTheme(): unknown | null {
  return activeTheme;
}

export function initThemeLoader() {
  loadActiveTheme();

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
    console.warn('[theme] file watcher disabled:', (e as Error).message);
  }
}
