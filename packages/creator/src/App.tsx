import { useCallback, useEffect, useRef, useState } from 'react';
import PreviewCanvas from './PreviewCanvas';
import AssetUpload from './AssetUpload';
import SceneBuilder from './SceneBuilder';
import GrowthEditor from './GrowthEditor';
import {
  BACKGROUND_OPTIONS,
  DEFAULT_FLIGHT_ANIMATION,
  DEFAULT_FLIGHT_TRAJECTORY,
  DEFAULT_GIF_THRESHOLD_AT,
  PRESETS,
  SPRITE_OPTIONS,
  THEME_VERSION,
  type BackgroundKey,
  type FlightAnimation,
  type FlightTrajectory,
  type GameType,
  type SpriteKey,
  type Theme,
  type ThemeAssets,
  type ThemeColors,
  type ThemeGifs,
  type ThemeSounds,
} from './theme';

const STORAGE_KEY = 'crash-creator-theme';

/** True for a base64 `data:` URL (an inline asset not yet uploaded to S3). */
function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:');
}

// Theme binary-asset fields, grouped by their sub-object. Each data: URL is
// uploaded to S3 at publish time and replaced with the returned public URL.
const ASSET_FIELDS: Record<'assets' | 'gifs' | 'sounds', string[]> = {
  assets: ['sprite', 'spriteGround', 'spriteFlying', 'spriteCrashed', 'background', 'logo'],
  gifs: ['loading', 'flying', 'flyingThreshold', 'crashed'],
  sounds: ['takeoff', 'cashout', 'crash', 'bet', 'tick', 'music'],
};

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return PRESETS.galaxy;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme);

  // Admin session (login gate). Token lives in memory only — never persisted —
  // so closing the tab logs you out. Every write already requires this JWT.
  const [token, setToken] = useState<string | null>(null);
  const [admin, setAdmin] = useState<string | null>(null);

  // Editor UX: Simple (essentials) vs Advanced (everything), and the active tab.
  const [advanced, setAdvanced] = useState(false);
  const [tab, setTab] = useState<string>('brand');

  // Resizable editor / preview split — drag the divider to shrink the canvas and
  // give the (many-fielded) form more room. Persisted so it sticks per browser.
  const [editorW, setEditorW] = useState<number>(() => {
    const v = Number(localStorage.getItem('crash-creator-editorw'));
    return v >= 360 && v <= 1100 ? v : 460;
  });
  useEffect(() => { try { localStorage.setItem('crash-creator-editorw', String(editorW)); } catch { /* ignore */ } }, [editorW]);
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => setEditorW(Math.min(1100, Math.max(360, ev.clientX)));
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  }, []);

  // Scene-pack image files pending upload (filename → data URL). Transient and
  // NOT persisted — they can be multiple MB, and only the resolved S3 URLs
  // (theme.scene.baseUrl) belong in the saved theme.
  const [sceneFiles, setSceneFiles] = useState<Record<string, string>>({});

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch { /* ignore */ }
  }, [theme]);

  const update = useCallback(<K extends keyof Theme>(key: K, value: Theme[K]) => {
    setTheme((t) => ({ ...t, [key]: value }));
  }, []);
  const updateColor = useCallback(<K extends keyof ThemeColors>(key: K, value: ThemeColors[K]) => {
    setTheme((t) => ({ ...t, colors: { ...t.colors, [key]: value } }));
  }, []);
  const updateAsset = useCallback(<K extends keyof ThemeAssets>(key: K, value: ThemeAssets[K]) => {
    setTheme((t) => ({ ...t, assets: { ...(t.assets ?? {}), [key]: value } }));
  }, []);
  const updateSound = useCallback(<K extends keyof ThemeSounds>(key: K, value: ThemeSounds[K]) => {
    setTheme((t) => ({ ...t, sounds: { ...(t.sounds ?? {}), [key]: value } }));
  }, []);
  const updateGif = useCallback(<K extends keyof ThemeGifs>(key: K, value: ThemeGifs[K]) => {
    setTheme((t) => ({ ...t, gifs: { ...(t.gifs ?? {}), [key]: value } }));
  }, []);

  const handleExport = () => {
    const payload: Theme = { ...theme, version: THEME_VERSION };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(theme.brandName)}-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Catalogue of published games (for "Open game" → edit an existing one).
  const [games, setGames] = useState<{ gameId: string; name: string }[]>([]);
  const refreshGames = useCallback(async () => {
    try {
      const r = await fetch('/api/games');
      if (r.ok) { const j = (await r.json()) as { items?: { gameId: string; name: string }[] }; setGames(j.items ?? []); }
    } catch { /* server may be offline — Open list stays empty */ }
  }, []);
  useEffect(() => { void refreshGames(); }, [refreshGames]);

  // New game: reset to a clean default with an empty name (→ a fresh Game ID).
  const handleNew = useCallback(() => {
    if (theme.brandName && !window.confirm('Start a new game? Unsaved changes to the current design will be lost.')) return;
    setTheme({ ...PRESETS.galaxy, brandName: '' });
  }, [theme.brandName]);

  // Open an existing game's published theme into the editor (Publish then updates it).
  const handleOpen = useCallback(async (gameId: string) => {
    if (!gameId) return;
    if (theme.brandName && slug(theme.brandName) !== gameId
        && !window.confirm(`Open "${gameId}"? Unsaved changes to the current design will be lost.`)) return;
    try {
      const r = await fetch(`/api/theme?game=${encodeURIComponent(gameId)}`);
      if (!r.ok) { alert(`Could not load game "${gameId}" (${r.status}).`); return; }
      const loaded = (await r.json()) as Partial<Theme>;
      // Merge over a preset so any missing field still yields a complete Theme.
      setTheme({ ...PRESETS.galaxy, ...loaded, colors: { ...PRESETS.galaxy.colors, ...(loaded.colors ?? {}) } });
    } catch (e) { alert('Load failed: ' + (e as Error).message); }
  }, [theme.brandName]);

  // Delete (archive) a published game: it leaves the lobby + Open list and its
  // engine stops. Soft — bet history keeps its game reference.
  const handleDelete = useCallback(async (gameId: string) => {
    if (!gameId || !token) return;
    if (!window.confirm(`Delete game "${gameId}"?\n\nIt will be removed from the lobby and can no longer be launched. This can't be undone here.`)) return;
    try {
      const res = await fetch(`/admin/v1/games/${encodeURIComponent(gameId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'archived' }),
      });
      if (res.status === 401) { setToken(null); setAdmin(null); return; }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message ?? `Delete failed (${res.status})`); }
      await refreshGames();
      if (slug(theme.brandName) === gameId) setTheme({ ...PRESETS.galaxy, brandName: '' });
      alert(`Deleted "${gameId}".`);
    } catch (e) {
      alert('Delete failed: ' + (e as Error).message);
    }
  }, [token, theme.brandName]);

  const [publishing, setPublishing] = useState(false);
  const handlePublish = useCallback(async () => {
    // Publish this theme to the game server's catalogue. The admin JWT from the
    // login gate authorises every write below; on expiry we drop back to login.
    const gameId = slug(theme.brandName);
    if (!theme.brandName?.trim() || gameId === 'theme') {
      alert('Give your game a name first (the "Game name" field under Brand).');
      return;
    }
    if (!token) { setToken(null); return; }
    setPublishing(true);
    try {
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      // Upload any inline (base64 data:) assets to S3 first, so the stored theme
      // carries only URLs. Clone the sub-objects so we never mutate React state.
      const uploaded: Theme = {
        ...theme,
        assets: theme.assets ? { ...theme.assets } : theme.assets,
        gifs: theme.gifs ? { ...theme.gifs } : theme.gifs,
        sounds: theme.sounds ? { ...theme.sounds } : theme.sounds,
      };
      for (const group of ['assets', 'gifs', 'sounds'] as const) {
        const obj = uploaded[group] as Record<string, string | null | undefined> | undefined;
        if (!obj) continue;
        for (const field of ASSET_FIELDS[group]) {
          const val = obj[field];
          if (!isDataUrl(val)) continue;
          const up = await fetch('/api/assets/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ gameId, assetKey: `${group}.${field}`, dataUrl: val }),
          });
          if (!up.ok) {
            const e = await up.json().catch(() => ({}));
            throw new Error(e?.error?.message ?? `Asset upload failed for ${group}.${field} (${up.status})`);
          }
          const { url } = (await up.json()) as { url: string };
          obj[field] = url;
        }
      }

      // Scene pack: upload any freshly-added scene images to games/<id>/scene/…
      // and set the manifest baseUrl. If nothing new was added we keep the
      // existing baseUrl (editing a scene game without touching its art).
      if (uploaded.scene && Object.keys(sceneFiles).length > 0) {
        const manifest = { ...(uploaded.scene as Record<string, unknown>) };
        let baseUrl = (manifest.baseUrl as string) || '';
        for (const [fname, dataUrl] of Object.entries(sceneFiles)) {
          const up = await fetch('/api/assets/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ gameId, assetKey: `scene/${fname}`, dataUrl }),
          });
          if (!up.ok) {
            const e = await up.json().catch(() => ({}));
            throw new Error(e?.error?.message ?? `Scene upload failed for ${fname} (${up.status})`);
          }
          const { url } = (await up.json()) as { url: string };
          baseUrl = url.slice(0, url.lastIndexOf('/')); // the scene/ directory
        }
        manifest.baseUrl = baseUrl;
        uploaded.scene = manifest as Theme['scene'];
      }

      const payload: Theme = { ...uploaded, version: THEME_VERSION };
      const body = JSON.stringify({
        gameId,
        name: theme.brandName,
        gameType: theme.gameType ?? 'sprite',
        rtp: Math.round(theme.rtp * 100 * 100) / 100, // fraction → percentage
        theme: payload,
      });

      // Create, or update if it already exists.
      const exists = await fetch(`/admin/v1/games/${encodeURIComponent(gameId)}`, { headers: auth });
      const res = exists.ok
        ? await fetch(`/admin/v1/games/${encodeURIComponent(gameId)}`, { method: 'PATCH', headers: auth, body })
        : await fetch('/admin/v1/games', { method: 'POST', headers: auth, body });
      if (res.status === 401 || exists.status === 401) {
        setToken(null); setAdmin(null);
        throw new Error('Session expired — please log in again.');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `Publish failed (${res.status})`);
      }
      alert(`Published "${theme.brandName}" as game "${gameId}" (${exists.ok ? 'updated' : 'created'}).\nLaunch with ?game=${gameId}`);
      setSceneFiles({}); // uploaded — clear the pending scene images
      void refreshGames(); // a newly-created game now appears in "Open game"
    } catch (e) {
      alert('Publish failed: ' + (e as Error).message);
    } finally {
      setPublishing(false);
    }
  }, [theme, token, sceneFiles]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleImport = (file: File) => {
    file.text().then((txt) => {
      try {
        const parsed = JSON.parse(txt) as Partial<Theme>;
        // Merge with current to tolerate older/partial files
        setTheme((t) => ({ ...t, ...parsed, colors: { ...t.colors, ...(parsed.colors ?? {}) } }));
      } catch (e) {
        alert('Invalid theme JSON: ' + (e as Error).message);
      }
    });
  };

  // ─── Login gate ───────────────────────────────────────────────────────────
  if (!token) {
    return <LoginGate onLogin={(tok, user) => { setToken(tok); setAdmin(user); }} />;
  }

  return (
    <div className="min-h-screen flex flex-col text-slate-100">
      <TopBar
        onExport={handleExport}
        onImportClick={() => fileInputRef.current?.click()}
        onPublish={handlePublish}
        publishing={publishing}
        onNew={handleNew}
        games={games}
        onOpen={handleOpen}
        onDelete={handleDelete}
        currentGameId={slug(theme.brandName)}
        advanced={advanced}
        onToggleAdvanced={() => setAdvanced((v) => !v)}
        admin={admin}
        onLogout={() => { setToken(null); setAdmin(null); }}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImport(f);
          e.target.value = '';
        }}
      />

      <main
        className="flex-1 grid grid-cols-1 min-h-0 overflow-hidden lg:[grid-template-columns:var(--ew)_6px_1fr]"
        style={{ ['--ew' as string]: `${editorW}px` }}
      >
        {/* Editor — tabbed, Simple/Advanced, resizable */}
        <aside className="border-r border-ink-500/40 bg-ink-900/40 backdrop-blur-md flex flex-col min-h-0 lg:max-h-[calc(100vh-57px)]">
          <EditorForm
            theme={theme}
            advanced={advanced}
            tab={tab}
            setTab={setTab}
            update={update}
            updateColor={updateColor}
            updateAsset={updateAsset}
            updateSound={updateSound}
            updateGif={updateGif}
            onLoadPreset={(key) => setTheme(PRESETS[key])}
            sceneFiles={sceneFiles}
            setSceneFiles={setSceneFiles}
          />
        </aside>

        {/* Drag handle */}
        <div
          onMouseDown={startDrag}
          onDoubleClick={() => setEditorW(460)}
          title="Drag to resize · double-click to reset"
          className="hidden lg:block cursor-col-resize bg-ink-500/25 hover:bg-cyan-500/60 active:bg-cyan-400 transition"
        />

        {/* Preview — fills the (resizable) column; shrink it to grow the form */}
        <section className="flex flex-col min-h-0 bg-ink-950 overflow-hidden">
          <BrandStrip theme={theme} />
          <div className="flex-1 min-h-0 grid place-items-center p-5 overflow-auto">
            <div className="w-full max-w-[860px] aspect-video relative rounded-xl overflow-hidden border border-ink-500/40 shadow-2xl">
              <PreviewCanvas theme={theme} />
            </div>
          </div>
          <SampleControls theme={theme} />
        </section>
      </main>
    </div>
  );
}

// ─── Login gate ───────────────────────────────────────────────────────────
// The studio is served on its own subdomain and requires an admin sign-in
// before the editor renders. Same accounts as the admin console; the JWT it
// returns authorises every publish/upload. Token is held in memory only.
function LoginGate({ onLogin }: { onLogin: (token: string, user: string) => void }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !pass) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/admin/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (!r.ok) { setErr(r.status === 401 ? 'Invalid username or password.' : `Login failed (${r.status}).`); return; }
      const { token } = (await r.json()) as { token: string };
      onLogin(token, user);
    } catch {
      setErr('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center text-slate-100 p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-ink-900/70 border border-ink-500/40 rounded-2xl p-7 backdrop-blur-xl shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-control bg-gradient-to-br from-fuchsia-600 via-indigo-700 to-cyan-600 flex items-center justify-center border border-ink-500/50 font-display font-bold">C</div>
          <div className="leading-tight">
            <h1 className="font-display font-bold text-sm tracking-[0.18em] uppercase">Crash Game <span className="text-cyan-400">Creator</span></h1>
            <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Admin sign-in required</p>
          </div>
        </div>
        <label className="block text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-1.5">Admin username</label>
        <input
          autoFocus value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username"
          className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control px-3 h-10 text-sm mb-4 focus:outline-none focus:border-cyan-500/60"
        />
        <label className="block text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-1.5">Password</label>
        <input
          type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password"
          className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control px-3 h-10 text-sm mb-5 focus:outline-none focus:border-cyan-500/60"
        />
        {err && <div className="text-[11px] text-rose-400 mb-4 -mt-1">{err}</div>}
        <button
          type="submit" disabled={busy || !user || !pass}
          className="w-full h-10 rounded-control bg-gradient-to-r from-cyan-500 to-fuchsia-500 text-ink-950 font-bold uppercase tracking-[0.18em] text-xs hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────────────
function TopBar({ onExport, onImportClick, onPublish, publishing, onNew, games, onOpen, onDelete, currentGameId, advanced, onToggleAdvanced, admin, onLogout }: {
  onExport: () => void; onImportClick: () => void; onPublish: () => void; publishing: boolean;
  onNew: () => void; games: { gameId: string; name: string }[]; onOpen: (gameId: string) => void;
  onDelete: (gameId: string) => void; currentGameId: string;
  advanced: boolean; onToggleAdvanced: () => void; admin: string | null; onLogout: () => void;
}) {
  // <details> stays open after a click; collapse it so the menu isn't left
  // hanging over the confirm dialog.
  const closeMenu = (e: React.MouseEvent) => e.currentTarget.closest('details')?.removeAttribute('open');
  return (
    // relative z-40: backdrop-blur-xl makes this a stacking context, so without
    // an explicit z-index the Games dropdown paints *under* the editor below.
    <header className="relative z-40 flex items-center justify-between px-5 py-3 border-b border-ink-500/40 bg-ink-950/80 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-control bg-gradient-to-br from-fuchsia-600 via-indigo-700 to-cyan-600 flex items-center justify-center border border-ink-500/50">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V6"/><path d="M5 12l7-7 7 7"/><path d="M5 19h14"/>
          </svg>
        </div>
        <div className="leading-tight">
          <h1 className="font-display font-bold text-sm tracking-[0.18em] uppercase">
            Crash Game <span className="text-cyan-400">Creator</span>
          </h1>
          <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
            Theme studio
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Simple / Advanced */}
        <div className="flex rounded-control border border-ink-500/50 overflow-hidden mr-1" title="Advanced reveals every field; Simple shows just the essentials">
          <button
            onClick={() => { if (advanced) onToggleAdvanced(); }}
            className={`text-[11px] px-2.5 py-1.5 uppercase tracking-wider font-semibold transition ${!advanced ? 'bg-cyan-500/20 text-cyan-300' : 'bg-ink-800/60 text-slate-400 hover:text-white'}`}
          >Simple</button>
          <button
            onClick={() => { if (!advanced) onToggleAdvanced(); }}
            className={`text-[11px] px-2.5 py-1.5 uppercase tracking-wider font-semibold transition ${advanced ? 'bg-cyan-500/20 text-cyan-300' : 'bg-ink-800/60 text-slate-400 hover:text-white'}`}
          >Advanced</button>
        </div>
        <button
          onClick={onNew}
          className="text-xs px-3 py-1.5 rounded-control bg-ink-800/80 border border-ink-500/50 text-slate-300 hover:bg-ink-700 hover:text-white transition uppercase tracking-wider font-semibold"
          title="Start a fresh game"
        >
          + New
        </button>
        {/* Games menu — open or delete ANY published game. Previously this was a
            <select> to open, plus a Delete button that only appeared once the
            game was already open, so deleting meant opening it first. A <select>
            can't host a per-row delete control; <details> gives the open/close
            behaviour (Esc included) with no popover state or outside-click handler. */}
        <details className="relative">
          <summary
            className="list-none [&::-webkit-details-marker]:hidden cursor-pointer whitespace-nowrap text-xs px-3 py-1.5 rounded-control bg-ink-800/80 border border-ink-500/50 text-slate-300 hover:bg-ink-700 hover:text-white transition uppercase tracking-wider font-semibold"
            title="Open or delete a published game"
          >
            Games ({games.length})
          </summary>
          <div className="absolute right-0 mt-1 z-30 w-72 max-h-80 overflow-y-auto rounded-control border border-ink-500/50 bg-ink-900/95 backdrop-blur-xl shadow-xl p-1">
            {games.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-slate-500">No published games yet.</p>
            ) : games.map((g) => (
              <div key={g.gameId} className="flex items-center gap-1 rounded-control hover:bg-ink-800/80">
                <button
                  onClick={(e) => { closeMenu(e); onOpen(g.gameId); }}
                  className="flex-1 min-w-0 text-left px-2 py-1.5"
                  title={`Open "${g.gameId}" to edit`}
                >
                  <span className="block truncate text-xs text-slate-200">{g.name}</span>
                  <span className="block truncate text-[10px] text-slate-500">
                    {g.gameId}{g.gameId === currentGameId ? ' · open' : ''}
                  </span>
                </button>
                <button
                  onClick={(e) => { closeMenu(e); onDelete(g.gameId); }}
                  className="shrink-0 px-2 py-1.5 text-rose-400/70 hover:text-rose-300 transition"
                  title={`Delete "${g.gameId}"`}
                  aria-label={`Delete ${g.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </details>
        <button
          onClick={onImportClick}
          className="text-xs px-3 py-1.5 rounded-control bg-ink-800/80 border border-ink-500/50 text-slate-300 hover:bg-ink-700 hover:text-white transition uppercase tracking-wider font-semibold"
        >
          Import JSON
        </button>
        <button
          onClick={onExport}
          className="text-xs px-3 py-1.5 rounded-control bg-ink-800/80 border border-ink-500/50 text-slate-300 hover:bg-ink-700 hover:text-white transition uppercase tracking-wider font-semibold"
        >
          Export theme
        </button>
        <button
          onClick={onPublish}
          disabled={publishing}
          className="text-xs px-3 py-1.5 rounded-control bg-gradient-to-r from-cyan-500 to-fuchsia-500 text-ink-950 font-bold uppercase tracking-wider hover:brightness-110 transition disabled:opacity-50 disabled:cursor-wait"
        >
          {publishing ? 'Publishing…' : 'Publish'}
        </button>
        {admin && (
          <div className="flex items-center gap-2 pl-2 ml-1 border-l border-ink-500/40">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 hidden xl:inline">{admin}</span>
            <button
              onClick={onLogout}
              className="text-xs px-2.5 py-1.5 rounded-control bg-ink-800/80 border border-ink-500/50 text-slate-400 hover:bg-ink-700 hover:text-white transition uppercase tracking-wider font-semibold"
              title="Sign out"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

// ─── Brand strip ────────────────────────────────────────────────────────────
function BrandStrip({ theme }: { theme: Theme }) {
  return (
    <div
      className="border-b border-ink-500/40 px-5 py-3 flex items-center justify-between"
      style={{
        backgroundImage: `linear-gradient(90deg, ${theme.colors.bgFrom}cc, ${theme.colors.bgTo}cc)`,
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-control flex items-center justify-center border"
          style={{
            background: `linear-gradient(135deg, ${theme.colors.accent2}, ${theme.colors.accent})`,
            borderColor: `${theme.colors.accent}55`,
            boxShadow: `0 0 16px ${theme.colors.accent}55`,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V6"/><path d="M5 12l7-7 7 7"/>
          </svg>
        </div>
        <div className="leading-tight">
          <div className="font-display font-bold text-base tracking-[0.18em] uppercase" style={{ color: theme.colors.text }}>
            {theme.brandName || 'Your Brand'}
          </div>
          <div className="text-[10px] uppercase tracking-[0.22em]" style={{ color: theme.colors.text + 'aa' }}>
            {theme.brandTagline || 'Tagline goes here'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-semibold">
        <span style={{ color: theme.colors.text + 'aa' }}>RTP</span>
        <span style={{ color: theme.colors.win }}>{(theme.rtp * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

// ─── Sample controls (mock bet panel under the preview) ─────────────────────
function SampleControls({ theme }: { theme: Theme }) {
  return (
    <div className="border-t border-ink-500/40 px-5 py-3 flex items-center gap-3" style={{ backgroundColor: theme.colors.bgTo + 'cc' }}>
      <button
        className="px-4 py-2 rounded-control font-display font-bold text-xs uppercase tracking-[0.18em]"
        style={{
          background: `linear-gradient(90deg, ${theme.colors.win}, ${theme.colors.accent})`,
          color: theme.colors.bgTo,
        }}
      >
        Place bet · $10
      </button>
      <button
        className="px-4 py-2 rounded-control font-display font-bold text-xs uppercase tracking-[0.18em]"
        style={{
          background: `linear-gradient(90deg, ${theme.colors.gold}, ${theme.colors.crash})`,
          color: theme.colors.bgTo,
        }}
      >
        Cash out · $24.50
      </button>
      <div
        className="ml-auto px-3 py-2 rounded-control text-xs font-mono tabular-nums"
        style={{ backgroundColor: theme.colors.bgFrom + '88', color: theme.colors.text, border: `1px solid ${theme.colors.accent}40` }}
      >
        Balance · <span style={{ color: theme.colors.win }}>$1000.00</span>
      </div>
    </div>
  );
}

// ─── Editor form ────────────────────────────────────────────────────────────
function EditorForm({
  theme, advanced, tab, setTab, update, updateColor, updateAsset, updateSound, updateGif, onLoadPreset,
  sceneFiles, setSceneFiles,
}: {
  theme: Theme;
  advanced: boolean;
  tab: string;
  setTab: (t: string) => void;
  update: <K extends keyof Theme>(k: K, v: Theme[K]) => void;
  updateColor: <K extends keyof ThemeColors>(k: K, v: ThemeColors[K]) => void;
  updateAsset: <K extends keyof ThemeAssets>(k: K, v: ThemeAssets[K]) => void;
  updateSound: <K extends keyof ThemeSounds>(k: K, v: ThemeSounds[K]) => void;
  updateGif: <K extends keyof ThemeGifs>(k: K, v: ThemeGifs[K]) => void;
  onLoadPreset: (key: string) => void;
  sceneFiles: Record<string, string>;
  setSceneFiles: (f: Record<string, string>) => void;
}) {
  const gameType: GameType = theme.gameType ?? 'sprite';
  const hasScene = !!theme.scene;

  // Layers (tabs) depend on render mode + Simple/Advanced, so each is short (no
  // endless scroll) and only shows fields the current mode actually uses.
  const tabs: { id: string; label: string }[] = [
    { id: 'brand', label: 'Brand' },
    { id: 'look', label: 'Colors' },
    gameType === 'gif' ? { id: 'gif', label: 'Animations' } : { id: 'sprite', label: 'Sprite' },
    ...(gameType === 'sprite' && advanced ? [{ id: 'motion', label: 'Motion' }] : []),
    ...(gameType === 'sprite' && advanced ? [{ id: 'scene', label: `Scene${hasScene ? ' ●' : ''}` }] : []),
    ...(advanced ? [{ id: 'audio', label: 'Audio' }] : []),
    { id: 'math', label: 'Math' },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  // Scene guard: switching a scene-backed game to GIF would orphan the scene.
  const setGameType = (gt: GameType) => {
    if (gt === 'gif' && hasScene &&
      !window.confirm('This game uses a custom scene pack that only renders in Sprite mode.\n\nSwitch to GIF anyway? The scene stays saved and renders again when you switch back to Sprite.')) return;
    update('gameType', gt);
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Layer tabs */}
      <div className="flex gap-1 px-3 pt-3 pb-2 border-b border-ink-500/30 overflow-x-auto shrink-0 bg-ink-900/60">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-[11px] px-3 py-1.5 rounded-control uppercase tracking-wider font-semibold whitespace-nowrap transition ${
              activeTab === t.id
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'text-slate-400 hover:text-white border border-transparent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active layer */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {activeTab === 'brand' && (
          <>
            <Section title="Render mode">
              <p className="text-[10px] text-slate-500 leading-relaxed -mt-1">
                <strong className="text-slate-300">Sprite</strong> — a sprite (or a parallax scene) on the game canvas.
                <strong className="text-slate-300"> GIF</strong> — a full-screen clip per phase with the multiplier overlaid.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <SegmentCard active={gameType === 'sprite'} label="Sprite" description="Sprite / scene + curve" onClick={() => setGameType('sprite')} />
                <SegmentCard active={gameType === 'gif'} label="GIF" description="Full-screen clip per phase" onClick={() => setGameType('gif')} />
              </div>
              {hasScene && (
                <div className="rounded-control border border-cyan-500/40 bg-cyan-500/10 p-3 text-[11px] text-cyan-200 leading-relaxed">
                  <strong>Custom scene pack</strong> — this game renders an uploaded parallax scene (advanced sprite renderer). Name, colours, tuning and sounds are safe to edit and publish; the scene art is managed outside the studio. Keep the mode on <strong>Sprite</strong>.
                </div>
              )}
            </Section>

            <Section title="Brand">
              <Field label="Game name">
                <input
                  type="text"
                  value={theme.brandName}
                  onChange={(e) => update('brandName', e.target.value)}
                  placeholder="e.g. Skyline Cruise"
                  className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control px-3 h-9 text-sm font-display font-semibold focus:outline-none focus:border-cyan-500/60"
                  maxLength={32}
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Published as game ID <span className="font-mono text-cyan-400">{slug(theme.brandName) || '—'}</span>
                  {' '}· launch at <span className="font-mono">?game={slug(theme.brandName) || '…'}</span>
                </p>
              </Field>
              <Field label="Tagline">
                <input
                  type="text"
                  value={theme.brandTagline}
                  onChange={(e) => update('brandTagline', e.target.value)}
                  className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control px-3 h-9 text-sm focus:outline-none focus:border-cyan-500/60"
                  maxLength={48}
                />
              </Field>
              <AssetUpload
                label="Header logo"
                accept="image/png,image/svg+xml,image/webp"
                kind="image"
                value={theme.assets?.logo}
                onChange={(v) => updateAsset('logo', v)}
                hint="Replaces the procedural logo in the game header. Applies to both modes."
              />
            </Section>

            <Section title="Presets">
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(PRESETS).map(([key, p]) => (
                  <button
                    key={key}
                    onClick={() => onLoadPreset(key)}
                    className="text-left px-3 py-2 rounded-control border border-ink-500/40 bg-ink-800/50 hover:border-ink-500/80 hover:bg-ink-800 transition group"
                    style={{ boxShadow: `inset 0 -2px 0 0 ${p.colors.accent}` }}
                  >
                    <div className="text-[11px] font-bold tracking-wide text-slate-100 truncate">{p.brandName}</div>
                    <div className="flex items-center gap-1 mt-1.5">
                      {[p.colors.bgFrom, p.colors.accent, p.colors.accent2, p.colors.gold].map((c) => (
                        <span key={c} className="w-3 h-3 rounded-sm border border-white/10" style={{ backgroundColor: c }} />
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}

        {activeTab === 'look' && (
          <Section title="Colors">
            <div className="grid grid-cols-2 gap-3">
              <ColorField label="BG top"    value={theme.colors.bgFrom} onChange={(v) => updateColor('bgFrom', v)} />
              <ColorField label="BG bottom" value={theme.colors.bgTo}   onChange={(v) => updateColor('bgTo', v)} />
              <ColorField label="Accent"    value={theme.colors.accent} onChange={(v) => updateColor('accent', v)} />
              <ColorField label="Crash"     value={theme.colors.crash}  onChange={(v) => updateColor('crash', v)} />
              <ColorField label="Win"       value={theme.colors.win}    onChange={(v) => updateColor('win', v)} />
              <ColorField label="Text"      value={theme.colors.text}   onChange={(v) => updateColor('text', v)} />
              {advanced && <ColorField label="Accent 2" value={theme.colors.accent2} onChange={(v) => updateColor('accent2', v)} />}
              {advanced && <ColorField label="Gold"     value={theme.colors.gold}    onChange={(v) => updateColor('gold', v)} />}
            </div>
            {!advanced && <p className="text-[10px] text-slate-500">Switch to <strong className="text-slate-300">Advanced</strong> for the secondary accent and gold-tier colours.</p>}
          </Section>
        )}

        {activeTab === 'sprite' && (
          <>
            {hasScene && (
              <div className="rounded-control border border-cyan-500/40 bg-cyan-500/10 p-3 text-[11px] text-cyan-200 leading-relaxed">
                <strong>Scene pack active.</strong> The sprite / background pickers below are ignored while a scene is present — the uploaded parallax scene renders instead. They still publish, so switching the scene off later restores them.
              </div>
            )}
            <Section title="Sprite">
              <div className="grid grid-cols-2 gap-2">
                {SPRITE_OPTIONS.map((opt) => (
                  <PickCard key={opt.key} active={theme.sprite === opt.key} label={opt.label} description={opt.description} onClick={() => update('sprite', opt.key as SpriteKey)} />
                ))}
              </div>
            </Section>
            <Section title="Background">
              <div className="grid grid-cols-2 gap-2">
                {BACKGROUND_OPTIONS.map((opt) => (
                  <PickCard key={opt.key} active={theme.background === opt.key} label={opt.label} description={opt.description} onClick={() => update('background', opt.key as BackgroundKey)} />
                ))}
              </div>
            </Section>
            <Section title="Custom sprites">
              <p className="text-[10px] text-slate-500 leading-relaxed -mt-1">
                Upload per-state sprites for ground / flying / crashed. The sprite swaps from ground → flying at the transition multiplier below.
              </p>
              <AssetUpload label="Ground sprite (idle)" accept="image/png,image/svg+xml,image/jpeg,image/webp" kind="image" value={theme.assets?.spriteGround} onChange={(v) => updateAsset('spriteGround', v)} hint="Shown during BETTING and early flight. Falls back to the flying sprite." />
              <AssetUpload label="Flying sprite" accept="image/png,image/svg+xml,image/jpeg,image/webp" kind="image" value={theme.assets?.spriteFlying} onChange={(v) => updateAsset('spriteFlying', v)} hint="Shown after the multiplier crosses the transition threshold below." />
              <AssetUpload label="Crashed sprite" accept="image/png,image/svg+xml,image/jpeg,image/webp" kind="image" value={theme.assets?.spriteCrashed} onChange={(v) => updateAsset('spriteCrashed', v)} hint="Shown during the crash animation. Falls back to the flying sprite." />
              {advanced && (
                <AssetUpload label="Single sprite (legacy)" accept="image/png,image/svg+xml,image/jpeg,image/webp" kind="image" value={theme.assets?.sprite} onChange={(v) => updateAsset('sprite', v)} hint="Used for all states if no per-state sprite is set." />
              )}
              <SliderField label="Fully airborne at" min={1.0} max={5.0} step={0.1} value={theme.spriteTransitionAt ?? 1.5} onChange={(v) => update('spriteTransitionAt', v)} display={`${(theme.spriteTransitionAt ?? 1.5).toFixed(1)}x`} hint="At this multiplier the sprite swaps ground → flying and reaches the cruise point. Default 1.5x." />
            </Section>
          </>
        )}

        {activeTab === 'gif' && (
          <Section title="GIF animations">
            <p className="text-[10px] text-slate-500 leading-relaxed -mt-1">
              Each phase shows its own full-screen clip; the multiplier overlays it. Sprite / background settings aren't used in GIF mode.
            </p>
            <AssetUpload label="Loading (BETTING)" accept="image/gif,image/webp,image/png,video/mp4,video/webm" kind="image" value={theme.gifs?.loading} onChange={(v) => updateGif('loading', v)} hint="Plays during the place-bet countdown." warnBytes={5_000_000} />
            <AssetUpload label="Started (FLYING)" accept="image/gif,image/webp,image/png,video/mp4,video/webm" kind="image" value={theme.gifs?.flying} onChange={(v) => updateGif('flying', v)} hint="Plays from the moment the round starts." warnBytes={5_000_000} />
            {advanced && (
              <>
                <AssetUpload label="Threshold (optional)" accept="image/gif,image/webp,image/png,video/mp4,video/webm" kind="image" value={theme.gifs?.flyingThreshold} onChange={(v) => updateGif('flyingThreshold', v)} hint="Takes over FLYING once the multiplier crosses the value below." warnBytes={5_000_000} />
                {theme.gifs?.flyingThreshold && (
                  <SliderField label="Threshold multiplier" min={1.1} max={10.0} step={0.1} value={theme.gifs?.flyingThresholdAt ?? DEFAULT_GIF_THRESHOLD_AT} onChange={(v) => updateGif('flyingThresholdAt', v)} display={`${(theme.gifs?.flyingThresholdAt ?? DEFAULT_GIF_THRESHOLD_AT).toFixed(1)}x`} hint="At this multiplier the Threshold clip replaces the Started clip." />
                )}
              </>
            )}
            <AssetUpload label="Crashed" accept="image/gif,image/webp,image/png,video/mp4,video/webm" kind="image" value={theme.gifs?.crashed} onChange={(v) => updateGif('crashed', v)} hint="Plays on crash (and through the brief result phase)." warnBytes={5_000_000} />
          </Section>
        )}

        {activeTab === 'motion' && (
          <>
            <Section title="Flight motion">
              {(() => {
                const anim = { ...DEFAULT_FLIGHT_ANIMATION, ...(theme.flightAnimation ?? {}) };
                const setAnim = (patch: Partial<FlightAnimation>) => update('flightAnimation', { ...anim, ...patch });
                const trajectory: FlightTrajectory = theme.flightTrajectory ?? DEFAULT_FLIGHT_TRAJECTORY;
                return (
                  <>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-1.5">Trajectory</div>
                      <div className="grid grid-cols-2 gap-2">
                        <PickCard active={trajectory === 'elliptic'} label="Elliptic" description="Quarter-ellipse from bottom-left to upper-right." onClick={() => update('flightTrajectory', 'elliptic')} />
                        <PickCard active={trajectory === 'straight'} label="Straight" description="Takes off diagonally, then levels off horizontally." onClick={() => update('flightTrajectory', 'straight')} />
                      </div>
                    </div>
                    <SliderField label="Cruise point on arc" min={0.50} max={0.95} step={0.01} value={anim.cruisePoint} onChange={(v) => setAnim({ cruisePoint: v })} display={`${Math.round(anim.cruisePoint * 100)}% of arc`} hint="How far up the arc the sprite settles." />
                    <SliderField label="Bob distance" min={0} max={0.20} step={0.01} value={anim.bobAmplitude} onChange={(v) => setAnim({ bobAmplitude: v })} display={anim.bobAmplitude === 0 ? 'no bob' : `±${Math.round(anim.bobAmplitude * 100)}% of arc`} hint="How far the sprite slides along the arc while cruising. 0 = none." />
                    <SliderField label="Bob period" min={400} max={4000} step={100} value={anim.bobPeriodMs} onChange={(v) => setAnim({ bobPeriodMs: v })} display={`${(anim.bobPeriodMs / 1000).toFixed(1)}s / cycle`} hint="Time for one forward-and-back cycle. Disabled when bob distance is 0." />
                  </>
                );
              })()}
            </Section>
            <Section title="Custom background">
              <AssetUpload label="Background image" accept="image/png,image/jpeg,image/webp" kind="image" value={theme.assets?.background} onChange={(v) => updateAsset('background', v)} hint="Full-canvas image. Leave empty for the procedural scene." />
              <Field label="Motion direction">
                <select
                  value={theme.backgroundMotion?.direction ?? 'none'}
                  onChange={(e) => update('backgroundMotion', { direction: e.target.value as 'none' | 'left' | 'right' | 'up' | 'down', speed: theme.backgroundMotion?.speed ?? 'medium', tieToMultiplier: theme.backgroundMotion?.tieToMultiplier ?? false })}
                  className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control h-9 px-3 text-sm focus:outline-none focus:border-cyan-500/60"
                >
                  <option value="none">None (static)</option>
                  <option value="left">Scroll left (moves right)</option>
                  <option value="right">Scroll right</option>
                  <option value="up">Scroll up (climbing)</option>
                  <option value="down">Scroll down (descending)</option>
                </select>
              </Field>
              <Field label="Motion speed">
                <select
                  value={theme.backgroundMotion?.speed ?? 'medium'}
                  onChange={(e) => update('backgroundMotion', { direction: theme.backgroundMotion?.direction ?? 'none', speed: e.target.value as 'slow' | 'medium' | 'fast', tieToMultiplier: theme.backgroundMotion?.tieToMultiplier ?? false })}
                  className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control h-9 px-3 text-sm focus:outline-none focus:border-cyan-500/60"
                >
                  <option value="slow">Slow</option>
                  <option value="medium">Medium</option>
                  <option value="fast">Fast</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!theme.backgroundMotion?.tieToMultiplier}
                  onChange={(e) => update('backgroundMotion', { direction: theme.backgroundMotion?.direction ?? 'none', speed: theme.backgroundMotion?.speed ?? 'medium', tieToMultiplier: e.target.checked })}
                  className="w-4 h-4 accent-cyan-500"
                />
                <div className="leading-tight">
                  <div className="text-xs font-semibold text-slate-200">Tie speed to multiplier</div>
                  <div className="text-[10px] text-slate-500">Background scrolls faster as the round grows.</div>
                </div>
              </label>
            </Section>
          </>
        )}

        {activeTab === 'scene' && (
          <Section title="Scene pack (advanced sprite)">
            <SceneBuilder
              scene={theme.scene as Record<string, unknown> | undefined}
              setScene={(s) => update('scene', s as Theme['scene'])}
              sceneFiles={sceneFiles}
              setSceneFiles={setSceneFiles}
            />
          </Section>
        )}

        {activeTab === 'audio' && (
          <Section title="Custom sounds">
            <AssetUpload label="Takeoff whoosh" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3" kind="audio" value={theme.sounds?.takeoff} onChange={(v) => updateSound('takeoff', v)} hint="Plays when the round transitions to flight." />
            <AssetUpload label="Cashout chime" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3" kind="audio" value={theme.sounds?.cashout} onChange={(v) => updateSound('cashout', v)} hint="Plays on a successful cashout." />
            <AssetUpload label="Crash boom" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3" kind="audio" value={theme.sounds?.crash} onChange={(v) => updateSound('crash', v)} hint="Plays when the round crashes." />
            <AssetUpload label="Bet placed ping" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3" kind="audio" value={theme.sounds?.bet} onChange={(v) => updateSound('bet', v)} />
            <AssetUpload label="UI tick" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3" kind="audio" value={theme.sounds?.tick} onChange={(v) => updateSound('tick', v)} />
            <AssetUpload label="Background music loop" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3" kind="audio" value={theme.sounds?.music} onChange={(v) => updateSound('music', v)} hint="Loops while the game runs. Keep it small." warnBytes={3_000_000} />
          </Section>
        )}

        {activeTab === 'math' && (
          <Section title="Game tuning">
            <SliderField label="RTP" min={0.80} max={0.99} step={0.01} value={theme.rtp} onChange={(v) => update('rtp', v)} display={`${(theme.rtp * 100).toFixed(0)}%`} hint="Expected return per unit staked under a fixed cashout strategy." />
            <SliderField label="Betting window" min={3000} max={10000} step={500} value={theme.bettingMs} onChange={(v) => update('bettingMs', v)} display={`${(theme.bettingMs / 1000).toFixed(1)}s`} hint="How long players have to place bets before the round starts." />
            {advanced && (
              <>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-2">Growth curve</div>
                  <p className="text-[10px] text-slate-500 leading-relaxed mb-3 -mt-1">How fast the multiplier climbs. Piecewise bands give each range its own pace — only timing changes, RTP is unaffected (the crash point is RNG-driven).</p>
                  <GrowthEditor
                    growthRate={theme.growthRate}
                    segments={theme.growthSegments}
                    onChangeRate={(v) => update('growthRate', v)}
                    onChangeSegments={(s) => update('growthSegments', s)}
                  />
                </div>
                <SliderField label="Max multiplier" min={100} max={10000} step={100} value={theme.maxMultiplier} onChange={(v) => update('maxMultiplier', v)} display={`${theme.maxMultiplier}x`} hint="Hard ceiling on the displayed multiplier." />
              </>
            )}
            {!advanced && <p className="text-[10px] text-slate-500">Switch to <strong className="text-slate-300">Advanced</strong> for growth rate and max multiplier.</p>}
          </Section>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-ink-500/20 pt-5 first:border-t-0 first:pt-0">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500 mb-3 sticky top-0 bg-ink-900/95 backdrop-blur-md py-2 -mx-5 px-5 z-10 border-b border-ink-500/20">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 bg-ink-800/50 border border-ink-500/30 rounded-control p-2 cursor-pointer">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-9 h-9 shrink-0" />
      <div className="flex-1 min-w-0 leading-tight">
        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 truncate">{label}</div>
        <input
          type="text"
          value={value}
          onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && onChange(e.target.value)}
          className="bg-transparent text-xs font-mono w-full text-slate-200 outline-none p-0 m-0 leading-tight uppercase"
          maxLength={7}
        />
      </div>
    </label>
  );
}

function SegmentCard({
  active, label, description, onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-3 rounded-control border-2 transition ${
        active
          ? 'bg-cyan-500/15 border-cyan-500/70 ring-1 ring-cyan-500/40'
          : 'bg-ink-800/40 border-ink-500/30 hover:border-ink-500/70 hover:bg-ink-800/70'
      }`}
    >
      <div className={`text-sm font-display font-bold uppercase tracking-[0.18em] ${active ? 'text-cyan-300' : 'text-slate-200'}`}>
        {label}
      </div>
      <div className="text-[10px] text-slate-500 mt-1 leading-tight">{description}</div>
    </button>
  );
}

function PickCard({
  active, label, description, onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-3 py-2.5 rounded-control border transition ${
        active
          ? 'bg-cyan-500/15 border-cyan-500/60 ring-1 ring-cyan-500/40'
          : 'bg-ink-800/40 border-ink-500/40 hover:border-ink-500/80 hover:bg-ink-800/70'
      }`}
    >
      <div className={`text-sm font-bold ${active ? 'text-cyan-300' : 'text-slate-200'}`}>{label}</div>
      <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">{description}</div>
    </button>
  );
}

function SliderField({
  label, min, max, step, value, onChange, display, hint,
}: {
  label: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  display: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold">{label}</span>
        <span className="text-sm font-mono font-bold text-cyan-300 tabular-nums">{display}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────
function slug(s: string): string {
  return (s || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';
}
