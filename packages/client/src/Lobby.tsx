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

/** Fallback gradients when a game's theme can't be fetched — indexed by position. */
const FALLBACK_GRADIENTS: GameAccents[] = [
  { from: '#7c3aed', to: '#22d3ee' },
  { from: '#f43f5e', to: '#f59e0b' },
  { from: '#10b981', to: '#3b82f6' },
  { from: '#8b5cf6', to: '#ec4899' },
  { from: '#0ea5e9', to: '#14b8a6' },
  { from: '#f59e0b', to: '#ef4444' },
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
      if (res.status === 401) {
        // token no longer valid — log out locally
        logout();
        return;
      }
      if (!res.ok) return;
      const j = (await res.json()) as { balanceMinor: number };
      setBalanceMinor(j.balanceMinor ?? 0);
    } catch {
      /* leave balance as-is */
    }
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
    // If the user was mid-launch, continue into the game in real mode.
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
    if (!tok) {
      setPendingGameId(gameId);
      setAuthOpen(true);
      return;
    }
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

  return (
    <div className="min-h-screen text-slate-100 relative">
      {/* ─── Header ──────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-space-500/30 bg-space-950/70 backdrop-blur-xl relative z-10">
        <div className="flex items-center gap-3 min-w-0">
          <LobbyLogo />
          <div className="flex flex-col min-w-0">
            <h1 className="font-display font-bold text-[15px] sm:text-base tracking-[0.18em] uppercase leading-none">
              <span className="bg-gradient-to-r from-plasma-400 via-cosmos-400 to-nebula-400 bg-clip-text text-transparent">
                Nova
              </span>
              <span className="ml-1.5">Casino</span>
            </h1>
            <span className="text-[9px] uppercase tracking-[0.22em] text-slate-500 mt-0.5">
              provably-fair game lobby
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {token ? (
            <>
              <div className="flex items-center gap-2 sm:gap-3 bg-space-800/80 border border-space-500/50 rounded-control px-3 py-1.5">
                <div className="leading-tight">
                  <div className="text-[9px] uppercase tracking-[0.22em] text-slate-500">
                    {username ?? 'Player'}
                  </div>
                  <div className="text-base sm:text-lg font-mono font-semibold text-aurora-400 tabular-nums">
                    {balanceMinor == null ? '—' : `$${(balanceMinor / 100).toFixed(2)}`}
                  </div>
                </div>
                <button
                  onClick={deposit}
                  className="text-[10px] text-slate-300 hover:text-slate-100 transition px-2 py-1 rounded bg-space-700/60 border border-space-500/40 uppercase tracking-wider font-semibold"
                  title="Add $50 of play credit"
                >
                  Deposit $50
                </button>
              </div>
              <button
                onClick={logout}
                className="text-[10px] text-slate-400 hover:text-slate-100 transition px-3 py-2 rounded-control bg-space-800/80 border border-space-500/50 uppercase tracking-wider font-semibold"
              >
                Log out
              </button>
            </>
          ) : (
            <button
              onClick={() => { setPendingGameId(null); setAuthOpen(true); }}
              className="text-xs px-4 py-2 rounded-control font-semibold uppercase tracking-wider bg-gradient-to-r from-plasma-500 to-cosmos-500 text-space-950 hover:brightness-110 transition shadow-plasma"
            >
              Log in
            </button>
          )}
        </div>
      </header>

      {/* ─── Body ────────────────────────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight">Games</h2>
          <p className="text-sm text-slate-500 mt-1">
            Pick a game — play the free demo, or log in to play for real.
          </p>
        </div>

        {loadError && (
          <div className="mb-6 text-xs text-nebula-400 bg-nebula-500/10 border border-nebula-500/30 rounded-control px-4 py-3 font-mono">
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

      <footer className="text-center py-4 text-[11px] text-slate-500 border-t border-space-500/30 bg-space-950/60 mt-8">
        Nova Casino · simulation only · no real wagers, no real money.
      </footer>

      {authOpen && (
        <AuthModal onClose={() => setAuthOpen(false)} onSuccess={onAuthSuccess} />
      )}
    </div>
  );
}

// ─── Game card ────────────────────────────────────────────────────────────────
function GameCard({
  game,
  accent,
  onDemo,
  onReal,
}: {
  game: Game;
  accent: GameAccents;
  onDemo: () => void;
  onReal: () => void;
}) {
  return (
    <div className="group rounded-panel border border-space-500/40 bg-space-900/70 shadow-panel overflow-hidden flex flex-col transition hover:border-space-500/70 hover:-translate-y-0.5">
      {/* Preview banner painted with the game's theme accents */}
      <div
        className="h-32 relative flex items-end p-3"
        style={{ background: `linear-gradient(135deg, ${accent.from}, ${accent.to})` }}
      >
        <div className="absolute inset-0 bg-space-950/25 group-hover:bg-space-950/10 transition" />
        <span className="relative z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] bg-space-950/60 backdrop-blur-sm border border-white/10 text-white">
          {game.gameType}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3 flex-1">
        <h3 className="font-display font-semibold text-base tracking-wide truncate" title={game.name}>
          {game.name}
        </h3>
        <div className="mt-auto grid grid-cols-2 gap-2">
          <button
            onClick={onDemo}
            className="rounded-control px-3 py-2 text-xs font-semibold uppercase tracking-wider bg-space-800/80 border border-space-500/50 text-slate-200 hover:bg-space-700/70 hover:text-white transition"
          >
            Demo
          </button>
          <button
            onClick={onReal}
            className="rounded-control px-3 py-2 text-xs font-semibold uppercase tracking-wider bg-gradient-to-r from-plasma-500 to-cosmos-500 text-space-950 hover:brightness-110 transition shadow-plasma"
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
    <div className="rounded-panel border border-dashed border-space-500/50 bg-space-900/40 px-6 py-16 text-center">
      <div className="text-4xl mb-3">🎰</div>
      <h3 className="font-display font-semibold text-lg text-slate-200">No games yet</h3>
      <p className="text-sm text-slate-500 mt-1">
        Publish one from the Creator to see it here.
      </p>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-panel border border-space-500/40 bg-space-900/50 overflow-hidden">
          <div className="h-32 bg-space-800/60 animate-pulse" />
          <div className="p-4 flex flex-col gap-3">
            <div className="h-4 w-2/3 rounded bg-space-800/70 animate-pulse" />
            <div className="grid grid-cols-2 gap-2">
              <div className="h-8 rounded bg-space-800/70 animate-pulse" />
              <div className="h-8 rounded bg-space-800/70 animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LobbyLogo() {
  return (
    <div className="w-9 h-9 rounded-control bg-gradient-to-br from-cosmos-600 via-space-700 to-plasma-600 border border-space-500/60 flex items-center justify-center">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2 L15 8 L15 16 Q12 22 9 16 L9 8 Z" fill="#f8fafc" stroke="#0f172a" strokeWidth="0.5" />
        <circle cx="12" cy="9" r="1.6" fill="#22d3ee" />
        <path d="M9 15 L6 19 L9 17 Z" fill="#ef4444" />
        <path d="M15 15 L18 19 L15 17 Z" fill="#ef4444" />
      </svg>
    </div>
  );
}
