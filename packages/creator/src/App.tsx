import { useCallback, useEffect, useRef, useState } from 'react';
import PreviewCanvas from './PreviewCanvas';
import AssetUpload from './AssetUpload';
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

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return PRESETS.galaxy;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme);

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

  const [publishing, setPublishing] = useState(false);
  const handlePublish = useCallback(async () => {
    // Publish this theme to the game server's catalogue as a first-class game.
    // The catalogue API is admin-only, so we log in for a short-lived JWT.
    // (Dev tool: creds are prompted, never stored. Server reached via vite proxy.)
    const gameId = slug(theme.brandName);
    const user = window.prompt(`Publish "${theme.brandName}" as game "${gameId}".\n\nAdmin username:`);
    if (!user) return;
    const pass = window.prompt('Admin password:');
    if (!pass) return;
    setPublishing(true);
    try {
      const login = await fetch('/admin/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (!login.ok) throw new Error(`Login failed (${login.status})`);
      const { token } = (await login.json()) as { token: string };
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const payload: Theme = { ...theme, version: THEME_VERSION };
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `Publish failed (${res.status})`);
      }
      alert(`Published "${theme.brandName}" as game "${gameId}" (${exists.ok ? 'updated' : 'created'}).\nLaunch with ?game=${gameId}`);
    } catch (e) {
      alert('Publish failed: ' + (e as Error).message);
    } finally {
      setPublishing(false);
    }
  }, [theme]);

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

  return (
    <div className="min-h-screen flex flex-col text-slate-100">
      <TopBar onExport={handleExport} onImportClick={() => fileInputRef.current?.click()} onPublish={handlePublish} publishing={publishing} />

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

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[380px_1fr] min-h-0 overflow-hidden">
        {/* Editor */}
        <aside className="border-r border-ink-500/40 bg-ink-900/40 backdrop-blur-md overflow-y-auto h-full lg:max-h-[calc(100vh-57px)]">
          <EditorForm
            theme={theme}
            update={update}
            updateColor={updateColor}
            updateAsset={updateAsset}
            updateSound={updateSound}
            updateGif={updateGif}
            onLoadPreset={(key) => setTheme(PRESETS[key])}
          />
        </aside>

        {/* Preview */}
        <section className="flex flex-col min-h-0">
          <BrandStrip theme={theme} />
          <div className="flex-1 relative min-h-[400px] bg-ink-950">
            <PreviewCanvas theme={theme} />
          </div>
          <SampleControls theme={theme} />
        </section>
      </main>
    </div>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────────────
function TopBar({ onExport, onImportClick, onPublish, publishing }: { onExport: () => void; onImportClick: () => void; onPublish: () => void; publishing: boolean }) {
  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-ink-500/40 bg-ink-950/80 backdrop-blur-xl">
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
  theme, update, updateColor, updateAsset, updateSound, updateGif, onLoadPreset,
}: {
  theme: Theme;
  update: <K extends keyof Theme>(k: K, v: Theme[K]) => void;
  updateColor: <K extends keyof ThemeColors>(k: K, v: ThemeColors[K]) => void;
  updateAsset: <K extends keyof ThemeAssets>(k: K, v: ThemeAssets[K]) => void;
  updateSound: <K extends keyof ThemeSounds>(k: K, v: ThemeSounds[K]) => void;
  updateGif: <K extends keyof ThemeGifs>(k: K, v: ThemeGifs[K]) => void;
  onLoadPreset: (key: string) => void;
}) {
  const gameType: GameType = theme.gameType ?? 'sprite';
  return (
    <div className="p-5 pb-16 space-y-7">
      {/* Game type — the first decision: sprite-on-curve, or full-screen GIF */}
      <Section title="Game type">
        <p className="text-[10px] text-slate-500 leading-relaxed -mt-1">
          Pick how this game renders. <strong className="text-slate-300">Sprite</strong> uses
          a procedural or static sprite traveling along an elliptic curve.
          <strong className="text-slate-300"> GIF</strong> plays a full-screen
          animated GIF per phase with the multiplier overlaid — the GIF brings
          its own background and motion.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <SegmentCard
            active={gameType === 'sprite'}
            label="Sprite"
            description="Sprite + curve + background"
            onClick={() => update('gameType', 'sprite')}
          />
          <SegmentCard
            active={gameType === 'gif'}
            label="GIF"
            description="Full-screen GIF per phase"
            onClick={() => update('gameType', 'gif')}
          />
        </div>
      </Section>

      {/* Presets */}
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

      {/* Brand */}
      <Section title="Brand">
        <Field label="Game name">
          <input
            type="text"
            value={theme.brandName}
            onChange={(e) => update('brandName', e.target.value)}
            className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control px-3 h-9 text-sm font-display font-semibold focus:outline-none focus:border-cyan-500/60"
            maxLength={32}
          />
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
      </Section>

      {/* Sprite */}
      <Section title="Sprite">
        <div className="grid grid-cols-2 gap-2">
          {SPRITE_OPTIONS.map((opt) => (
            <PickCard
              key={opt.key}
              active={theme.sprite === opt.key}
              label={opt.label}
              description={opt.description}
              onClick={() => update('sprite', opt.key as SpriteKey)}
            />
          ))}
        </div>
      </Section>

      {/* Background */}
      <Section title="Background">
        <div className="grid grid-cols-2 gap-2">
          {BACKGROUND_OPTIONS.map((opt) => (
            <PickCard
              key={opt.key}
              active={theme.background === opt.key}
              label={opt.label}
              description={opt.description}
              onClick={() => update('background', opt.key as BackgroundKey)}
            />
          ))}
        </div>
      </Section>

      {/* Colors */}
      <Section title="Colors">
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="BG top"     value={theme.colors.bgFrom}  onChange={(v) => updateColor('bgFrom', v)} />
          <ColorField label="BG bottom"  value={theme.colors.bgTo}    onChange={(v) => updateColor('bgTo', v)} />
          <ColorField label="Accent"     value={theme.colors.accent}  onChange={(v) => updateColor('accent', v)} />
          <ColorField label="Accent 2"   value={theme.colors.accent2} onChange={(v) => updateColor('accent2', v)} />
          <ColorField label="Win"        value={theme.colors.win}     onChange={(v) => updateColor('win', v)} />
          <ColorField label="Crash"      value={theme.colors.crash}   onChange={(v) => updateColor('crash', v)} />
          <ColorField label="Gold"       value={theme.colors.gold}    onChange={(v) => updateColor('gold', v)} />
          <ColorField label="Text"       value={theme.colors.text}    onChange={(v) => updateColor('text', v)} />
        </div>
      </Section>

      {/* ─── GIF mode: animated GIFs per phase ──────────────────────────── */}
      {gameType === 'gif' && (
        <Section title="GIF animations">
          <p className="text-[10px] text-slate-500 leading-relaxed -mt-1">
            Each phase shows its own animated GIF full-screen. The multiplier
            text overlays it. Backgrounds and sprite settings are not used in
            GIF mode — the GIF brings everything.
          </p>
          <AssetUpload
            label="Loading GIF (BETTING phase)"
            accept="image/gif,image/webp,image/png"
            kind="image"
            value={theme.gifs?.loading}
            onChange={(v) => updateGif('loading', v)}
            hint="Plays during the place-bet countdown."
            warnBytes={5_000_000}
          />
          <AssetUpload
            label="Started GIF (FLYING phase)"
            accept="image/gif,image/webp,image/png"
            kind="image"
            value={theme.gifs?.flying}
            onChange={(v) => updateGif('flying', v)}
            hint="Plays from the moment the round starts."
            warnBytes={5_000_000}
          />
          <AssetUpload
            label="Threshold GIF (optional)"
            accept="image/gif,image/webp,image/png"
            kind="image"
            value={theme.gifs?.flyingThreshold}
            onChange={(v) => updateGif('flyingThreshold', v)}
            hint="Optional: takes over the FLYING phase once the multiplier crosses the value below. Skip to keep one GIF for the whole flight."
            warnBytes={5_000_000}
          />
          {theme.gifs?.flyingThreshold && (
            <SliderField
              label="Threshold multiplier"
              min={1.1} max={10.0} step={0.1}
              value={theme.gifs?.flyingThresholdAt ?? DEFAULT_GIF_THRESHOLD_AT}
              onChange={(v) => updateGif('flyingThresholdAt', v)}
              display={`${(theme.gifs?.flyingThresholdAt ?? DEFAULT_GIF_THRESHOLD_AT).toFixed(1)}x`}
              hint="At this multiplier the Threshold GIF replaces the Started GIF."
            />
          )}
          <AssetUpload
            label="Crashed GIF"
            accept="image/gif,image/webp,image/png"
            kind="image"
            value={theme.gifs?.crashed}
            onChange={(v) => updateGif('crashed', v)}
            hint="Plays on crash (and stays through the brief result phase)."
            warnBytes={5_000_000}
          />
        </Section>
      )}

      {/* ─── Sprite mode: existing sprite + background + flight sections ──── */}
      {gameType === 'sprite' && <>
      {/* Custom sprites */}
      <Section title="Custom sprites">
        <p className="text-[10px] text-slate-500 leading-relaxed -mt-1">
          Upload per-state sprites for ground / flying / crashed, or just one
          "Sprite" used for all states. The plane swaps from ground → flying at
          the transition multiplier below.
        </p>
        <AssetUpload
          label="Ground sprite (idle)"
          accept="image/png,image/svg+xml,image/jpeg,image/webp"
          kind="image"
          value={theme.assets?.spriteGround}
          onChange={(v) => updateAsset('spriteGround', v)}
          hint="Shown during BETTING and early flight. Falls back to the flying sprite."
        />
        <AssetUpload
          label="Flying sprite"
          accept="image/png,image/svg+xml,image/jpeg,image/webp"
          kind="image"
          value={theme.assets?.spriteFlying}
          onChange={(v) => updateAsset('spriteFlying', v)}
          hint="Shown after multiplier crosses the transition threshold below."
        />
        <AssetUpload
          label="Crashed sprite"
          accept="image/png,image/svg+xml,image/jpeg,image/webp"
          kind="image"
          value={theme.assets?.spriteCrashed}
          onChange={(v) => updateAsset('spriteCrashed', v)}
          hint="Shown during the crash animation (an explosion / wreck). Falls back to the flying sprite."
        />
        <AssetUpload
          label="Single sprite (legacy, used if no per-state)"
          accept="image/png,image/svg+xml,image/jpeg,image/webp"
          kind="image"
          value={theme.assets?.sprite}
          onChange={(v) => updateAsset('sprite', v)}
          hint="Used for all states if no per-state sprite is set."
        />
        <SliderField
          label="Fully airborne at"
          min={1.0} max={5.0} step={0.1}
          value={theme.spriteTransitionAt ?? 1.5}
          onChange={(v) => update('spriteTransitionAt', v)}
          display={`${(theme.spriteTransitionAt ?? 1.5).toFixed(1)}x`}
          hint="At this multiplier the sprite (a) swaps from ground → flying and (b) reaches the cruise point on the arc. Default 1.5x."
        />
      </Section>

      {/* Flight motion */}
      <Section title="Flight motion">
        {(() => {
          const anim = { ...DEFAULT_FLIGHT_ANIMATION, ...(theme.flightAnimation ?? {}) };
          const setAnim = (patch: Partial<FlightAnimation>) =>
            update('flightAnimation', { ...anim, ...patch });
          const trajectory: FlightTrajectory = theme.flightTrajectory ?? DEFAULT_FLIGHT_TRAJECTORY;
          return (
            <>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold mb-1.5">Trajectory</div>
                <div className="grid grid-cols-2 gap-2">
                  <PickCard
                    active={trajectory === 'elliptic'}
                    label="Elliptic"
                    description="Quarter-ellipse from bottom-left to upper-right — the default arc."
                    onClick={() => update('flightTrajectory', 'elliptic')}
                  />
                  <PickCard
                    active={trajectory === 'straight'}
                    label="Straight"
                    description="Takes off diagonally, then levels off and flies horizontally across the center."
                    onClick={() => update('flightTrajectory', 'straight')}
                  />
                </div>
              </div>
              <SliderField
                label="Cruise point on arc"
                min={0.50} max={0.95} step={0.01}
                value={anim.cruisePoint}
                onChange={(v) => setAnim({ cruisePoint: v })}
                display={`${Math.round(anim.cruisePoint * 100)}% of arc`}
                hint="How far up the elliptic arc the sprite settles. 80% leaves visible sky above; 95% pushes it near the top."
              />
              <SliderField
                label="Bob distance"
                min={0} max={0.20} step={0.01}
                value={anim.bobAmplitude}
                onChange={(v) => setAnim({ bobAmplitude: v })}
                display={anim.bobAmplitude === 0 ? 'no bob' : `±${Math.round(anim.bobAmplitude * 100)}% of arc`}
                hint="How far the sprite slides back and forth along the arc while cruising. 0 = no bob (sprite holds position)."
              />
              <SliderField
                label="Bob period"
                min={400} max={4000} step={100}
                value={anim.bobPeriodMs}
                onChange={(v) => setAnim({ bobPeriodMs: v })}
                display={`${(anim.bobPeriodMs / 1000).toFixed(1)}s / cycle`}
                hint="Time for one full forward-and-back cycle. Shorter = faster wiggle. Disabled when bob distance is 0."
              />
            </>
          );
        })()}
      </Section>

      {/* Custom background */}
      <Section title="Background">
        <AssetUpload
          label="Background image"
          accept="image/png,image/jpeg,image/webp"
          kind="image"
          value={theme.assets?.background}
          onChange={(v) => updateAsset('background', v)}
          hint="Full-canvas image. Leave empty for the procedural scene above."
        />
        <Field label="Motion direction">
          <select
            value={theme.backgroundMotion?.direction ?? 'none'}
            onChange={(e) => update('backgroundMotion', {
              direction: e.target.value as 'none' | 'left' | 'right' | 'up' | 'down',
              speed: theme.backgroundMotion?.speed ?? 'medium',
            })}
            className="w-full bg-ink-800/80 border border-ink-500/40 rounded-control h-9 px-3 text-sm focus:outline-none focus:border-cyan-500/60"
          >
            <option value="none">None (static)</option>
            <option value="left">Scroll left (plane appears to move right)</option>
            <option value="right">Scroll right</option>
            <option value="up">Scroll up (climbing)</option>
            <option value="down">Scroll down (descending)</option>
          </select>
        </Field>
        <Field label="Motion speed">
          <select
            value={theme.backgroundMotion?.speed ?? 'medium'}
            onChange={(e) => update('backgroundMotion', {
              direction: theme.backgroundMotion?.direction ?? 'none',
              speed: e.target.value as 'slow' | 'medium' | 'fast',
              tieToMultiplier: theme.backgroundMotion?.tieToMultiplier ?? false,
            })}
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
            onChange={(e) => update('backgroundMotion', {
              direction: theme.backgroundMotion?.direction ?? 'none',
              speed: theme.backgroundMotion?.speed ?? 'medium',
              tieToMultiplier: e.target.checked,
            })}
            className="w-4 h-4 accent-cyan-500"
          />
          <div className="leading-tight">
            <div className="text-xs font-semibold text-slate-200">Tie speed to multiplier</div>
            <div className="text-[10px] text-slate-500">
              Background scrolls faster as the round grows. At 1× it moves at half base speed; at 5× it moves at 5× base.
            </div>
          </div>
        </label>
      </Section>
      </>}

      {/* Header logo (applies to both game types) */}
      <Section title="Header logo">
        <AssetUpload
          label="Logo image"
          accept="image/png,image/svg+xml,image/webp"
          kind="image"
          value={theme.assets?.logo}
          onChange={(v) => updateAsset('logo', v)}
          hint="Replaces the procedural rocket logo in the game header."
        />
      </Section>

      {/* Custom sounds */}
      <Section title="Custom sounds">
        <AssetUpload
          label="Takeoff whoosh"
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3"
          kind="audio"
          value={theme.sounds?.takeoff}
          onChange={(v) => updateSound('takeoff', v)}
          hint="Plays when the round transitions to flight."
        />
        <AssetUpload
          label="Cashout chime"
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3"
          kind="audio"
          value={theme.sounds?.cashout}
          onChange={(v) => updateSound('cashout', v)}
          hint="Plays on a successful cashout."
        />
        <AssetUpload
          label="Crash boom"
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3"
          kind="audio"
          value={theme.sounds?.crash}
          onChange={(v) => updateSound('crash', v)}
          hint="Plays when the round crashes."
        />
        <AssetUpload
          label="Bet placed ping"
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3"
          kind="audio"
          value={theme.sounds?.bet}
          onChange={(v) => updateSound('bet', v)}
        />
        <AssetUpload
          label="UI tick"
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3"
          kind="audio"
          value={theme.sounds?.tick}
          onChange={(v) => updateSound('tick', v)}
        />
        <AssetUpload
          label="Background music loop"
          accept="audio/mpeg,audio/wav,audio/ogg,audio/mp3"
          kind="audio"
          value={theme.sounds?.music}
          onChange={(v) => updateSound('music', v)}
          hint="Loops continuously while the game is running. Keep file size small."
          warnBytes={3_000_000}
        />
      </Section>

      {/* Tuning */}
      <Section title="Game tuning">
        <SliderField
          label="RTP"
          min={0.80} max={0.99} step={0.01}
          value={theme.rtp}
          onChange={(v) => update('rtp', v)}
          display={`${(theme.rtp * 100).toFixed(0)}%`}
          hint="The expected return per unit staked under a fixed cashout strategy."
        />
        <SliderField
          label="Growth rate"
          min={0.03} max={0.15} step={0.005}
          value={theme.growthRate}
          onChange={(v) => update('growthRate', v)}
          display={theme.growthRate.toFixed(3)}
          hint={`At ${theme.growthRate}, 2× takes ${(Math.log(2) / theme.growthRate).toFixed(1)}s, 10× takes ${(Math.log(10) / theme.growthRate).toFixed(1)}s.`}
        />
        <SliderField
          label="Betting window"
          min={3000} max={10000} step={500}
          value={theme.bettingMs}
          onChange={(v) => update('bettingMs', v)}
          display={`${(theme.bettingMs / 1000).toFixed(1)}s`}
          hint="How long players have to place bets before the round starts."
        />
        <SliderField
          label="Max multiplier"
          min={100} max={10000} step={100}
          value={theme.maxMultiplier}
          onChange={(v) => update('maxMultiplier', v)}
          display={`${theme.maxMultiplier}x`}
          hint="Hard ceiling on the displayed multiplier."
        />
      </Section>
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
