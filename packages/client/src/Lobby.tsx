import { useCallback, useEffect, useState } from 'react';
import AuthModal, { type AuthSuccess } from './components/AuthModal';

const TOKEN_KEY = 'casino_player_token';
const USERNAME_KEY = 'casino_player_username';

interface Game {
  gameId: string;
  name: string;
  gameType: 'sprite' | 'gif' | string;
}

interface GameAccents {
  from: string;
  to: string;
}

/** Fallback banner gradients when a game's own theme can't be fetched — vivid,
 *  game-y variety (indexed by card position). */
const FALLBACK_GRADIENTS: GameAccents[] = [
  { from: '#fb6514', to: '#f5a623' }, // orange → amber
  { from: '#22a04a', to: '#0c70db' }, // green → blue
  { from: '#e5484d', to: '#fb6514' }, // red → orange
  { from: '#0c70db', to: '#22c3d6' }, // blue → teal
  { from: '#7c3aed', to: '#e5484d' }, // purple → red
  { from: '#f5a623', to: '#e5484d' }, // amber → red
];

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function readUsername(): string | null {
  try { return localStorage.getItem(USERNAME_KEY); } catch { return null; }
}

export default function Lobby() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accents, setAccents] = useState<Record<string, GameAccents>>({});

  const [token, setToken] = useState<string | null>(() => readToken());
  const [username, setUsername] = useState<string | null>(() => readUsername());
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null);

  const [authOpen, setAuthOpen] = useState(false);
  // Where to go once auth succeeds (a "Real" launch the user attempted while logged out).
  const [pendingGameId, setPendingGameId] = useState<string | null>(null);

  // ─── Load the games catalogue ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch('/api/games')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { items: Game[] }) => {
        if (cancelled) return;
        setGames(Array.isArray(j.items) ? j.items : []);
      })
      .catch(() => {
        if (cancelled) return;
        setGames([]);
        setLoadError('Could not load games — is the server running?');
      });
    return () => { cancelled = true; };
  }, []);

  // ─── Lazily fetch per-game accent colors for card previews ──────────────────
  useEffect(() => {
    if (!games) return;
    let cancelled = false;
    games.forEach((g) => {
      fetch(`/api/theme?game=${encodeURIComponent(g.gameId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((theme: { colors?: { accent?: string; accent2?: string } } | null) => {
          if (cancelled || !theme?.colors?.accent) return;
          setAccents((prev) => ({
            ...prev,
            [g.gameId]: {
              from: theme.colors!.accent2 ?? theme.colors!.accent!,
              to: theme.colors!.accent!,
            },
          }));
        })
        .catch(() => { /* fall back to a stock gradient */ });
    });
    return () => { cancelled = true; };
  }, [games]);

  // ─── Balance (only when logged in) ──────────────────────────────────────────
  const refreshBalance = useCallback(async (tok: string) => {
    try {
      const res = await fetch('/api/lobby/me', {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) return;
      const j = (await res.json()) as { balanceMinor: number };
      setBalanceMinor(j.balanceMinor ?? 0);
    } catch { /* leave balance as-is */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (token) refreshBalance(token);
  }, [token, refreshBalance]);

  function logout() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USERNAME_KEY);
    } catch { /* ignore */ }
    setToken(null);
    setUsername(null);
    setBalanceMinor(null);
  }

  const onAuthSuccess = useCallback((result: AuthSuccess) => {
    try {
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(USERNAME_KEY, result.username);
    } catch { /* ignore */ }
    setToken(result.token);
    setUsername(result.username);
    setBalanceMinor(result.balanceMinor);
    setAuthOpen(false);
    if (pendingGameId) {
      const id = pendingGameId;
      setPendingGameId(null);
      window.location.href = `/play?game=${encodeURIComponent(id)}&mode=real`;
    }
  }, [pendingGameId]);

  const playDemo = (gameId: string) => {
    window.location.href = `/play?game=${encodeURIComponent(gameId)}&mode=demo`;
  };

  const playReal = (gameId: string) => {
    const tok = readToken();
    if (!tok) { setPendingGameId(gameId); setAuthOpen(true); return; }
    window.location.href = `/play?game=${encodeURIComponent(gameId)}&mode=real`;
  };

  const deposit = async () => {
    const tok = readToken();
    if (!tok) return;
    try {
      const res = await fetch('/api/lobby/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ amountMinor: 5000 }),
      });
      if (res.ok) await refreshBalance(tok);
    } catch { /* ignore */ }
  };

  const featured = games?.[0];

  return (
    <div className="min-h-screen text-slate-100 relative">
      {/* ─── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center justify-between px-4 sm:px-6 h-16 border-b border-white/5 bg-space-700/80 backdrop-blur-xl">
        <div className="flex items-center gap-3 min-w-0">
          <LobbyLogo />
          <div className="flex flex-col min-w-0 leading-none">
            <h1 className="font-display font-extrabold text-lg tracking-tight">
              <span className="text-brand-500">Nova</span>
              <span className="ml-1 text-white">Casino</span>
            </h1>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 mt-1">
              Provably-fair crash games
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {token ? (
            <>
              <div className="flex items-center gap-3 bg-space-900/70 border border-white/5 rounded-control pl-3 pr-1.5 py-1.5">
                <div className="leading-tight">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {username ?? 'Player'}
                  </div>
                  <div className="text-base sm:text-lg font-mono font-bold text-bet-400 tabular-nums">
                    {balanceMinor == null ? '—' : `$${(balanceMinor / 100).toFixed(2)}`}
                  </div>
                </div>
                <button
                  onClick={deposit}
                  className="text-[11px] font-bold text-space-950 bg-brand-500 hover:bg-brand-400 transition px-3 py-2 rounded-lg"
                  title="Add $50 of play credit"
                >
                  + $50
                </button>
              </div>
              <button
                onClick={logout}
                className="text-xs font-bold text-slate-300 hover:text-white transition px-3.5 py-2.5 rounded-control bg-space-900/70 border border-white/5"
              >
                Log out
              </button>
            </>
          ) : (
            <button
              onClick={() => { setPendingGameId(null); setAuthOpen(true); }}
              className="text-sm px-5 py-2.5 rounded-control font-bold bg-brand-500 text-space-950 hover:bg-brand-400 transition shadow-plasma"
            >
              Log in
            </button>
          )}
        </div>
      </header>

      {/* ─── Body ────────────────────────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Hero */}
        {featured && <Hero game={featured} onPlay={() => playDemo(featured.gameId)} />}

        <SectionEyebrow>Games</SectionEyebrow>

        {loadError && (
          <div className="mb-6 text-xs text-loss-500 bg-loss-500/10 border border-loss-500/30 rounded-control px-4 py-3 font-mono">
            {loadError}
          </div>
        )}

        {games == null ? (
          <GridSkeleton />
        ) : games.length === 0 && !loadError ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
            {games.map((g, i) => (
              <GameCard
                key={g.gameId}
                game={g}
                accent={accents[g.gameId] ?? FALLBACK_GRADIENTS[i % FALLBACK_GRADIENTS.length]!}
                onDemo={() => playDemo(g.gameId)}
                onReal={() => playReal(g.gameId)}
              />
            ))}
          </div>
        )}
      </main>

      <footer className="text-center py-5 text-[11px] text-slate-500 border-t border-white/5 bg-space-950/60 mt-10">
        Nova Casino · simulation only · no real wagers, no real money.
      </footer>

      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onSuccess={onAuthSuccess} />}
    </div>
  );
}

// ─── Hero band ──────────────────────────────────────────────────────────────
function Hero({ game, onPlay }: { game: Game; onPlay: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-panel mb-8 border border-white/5 bg-space-800 shadow-panel">
      {/* thin brand accent along the top edge — flat, no glow */}
      <div className="absolute inset-x-0 top-0 h-1 bg-brand-500" />
      <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5 p-6 sm:p-8">
        <div className="max-w-lg">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/15 text-brand-400 text-[10px] font-extrabold uppercase tracking-[0.16em] px-2.5 py-1 mb-3">
            <RocketGlyph className="w-3 h-3" /> Featured
          </span>
          <h2 className="font-display font-black text-3xl sm:text-4xl leading-[1.05] tracking-tight">
            Cash out before it crashes.
          </h2>
          <p className="text-sm text-slate-300/90 mt-2">
            Watch the multiplier climb and grab it in time. Every round is provably fair — verify the seed yourself.
          </p>
          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={onPlay}
              className="px-6 py-3 rounded-control font-black text-space-950 bg-brand-500 hover:bg-brand-400 transition shadow-plasma"
            >
              Play {game.name} — free
            </button>
            <span className="text-xs text-slate-400 font-semibold">No signup for demo</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Section eyebrow ─────────────────────────────────────────────────────────
function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="grid place-items-center w-6 h-6 rounded-lg bg-brand-500/15 text-brand-400">
        <RocketGlyph className="w-3.5 h-3.5" />
      </span>
      <h2 className="font-display text-xl font-extrabold tracking-tight">{children}</h2>
    </div>
  );
}

// ─── Game card ────────────────────────────────────────────────────────────────
function GameCard({
  game, accent, onDemo, onReal,
}: {
  game: Game; accent: GameAccents; onDemo: () => void; onReal: () => void;
}) {
  return (
    <div className="group rounded-panel border border-white/5 bg-space-800 shadow-panel overflow-hidden flex flex-col transition duration-200 hover:border-brand-500/40 hover:-translate-y-1 hover:shadow-plasma">
      {/* Preview banner painted with the game's own theme accents (real identity) */}
      <div
        className="h-36 relative flex items-start justify-between p-3"
        style={{ background: `linear-gradient(135deg, ${accent.from}, ${accent.to})` }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-space-950/70 via-transparent to-transparent" />
        <span className="relative z-10 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.14em] bg-brand-500 text-space-950 shadow">
          New
        </span>
        <span className="relative z-10 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] bg-space-950/50 backdrop-blur-sm border border-white/10 text-white">
          {game.gameType}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3 flex-1">
        <h3 className="font-display font-extrabold text-base tracking-tight truncate" title={game.name}>
          {game.name}
        </h3>
        <div className="mt-auto grid grid-cols-2 gap-2">
          <button
            onClick={onDemo}
            className="rounded-control px-3 py-2.5 text-xs font-bold uppercase tracking-wide bg-space-900/80 border border-white/5 text-slate-200 hover:bg-space-600/60 hover:text-white transition"
          >
            Demo
          </button>
          <button
            onClick={onReal}
            className="rounded-control px-3 py-2.5 text-xs font-bold uppercase tracking-wide bg-brand-500 text-space-950 hover:bg-brand-400 transition"
          >
            Real
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Empty / loading / logo ─────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="rounded-panel border border-dashed border-white/10 bg-space-800/50 px-6 py-16 text-center">
      <RocketGlyph className="w-10 h-10 mx-auto mb-3 text-brand-400" />
      <h3 className="font-display font-extrabold text-lg text-slate-200">No games yet</h3>
      <p className="text-sm text-slate-500 mt-1">Publish one from the Creator to see it here.</p>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-panel border border-white/5 bg-space-800/60 overflow-hidden">
          <div className="h-36 bg-space-700/60 animate-pulse" />
          <div className="p-4 flex flex-col gap-3">
            <div className="h-4 w-2/3 rounded bg-space-700/70 animate-pulse" />
            <div className="grid grid-cols-2 gap-2">
              <div className="h-9 rounded bg-space-700/70 animate-pulse" />
              <div className="h-9 rounded bg-space-700/70 animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LobbyLogo() {
  return (
    <div className="w-10 h-10 rounded-control bg-space-900 border border-white/10 grid place-items-center shadow-plasma">
      <RocketGlyph className="w-5 h-5 text-brand-500" />
    </div>
  );
}

// A single on-brand glyph reused across the lobby (rocket = the crash climb).
function RocketGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
