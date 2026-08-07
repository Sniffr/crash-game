import { useCallback, useEffect, useState } from 'react';
import AuthModal, { type AuthSuccess } from './components/AuthModal';
import { fromMinor, symbolFor, toMinor } from './lib/money';

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
  { from: 'hsl(21 97% 53%)', to: 'hsl(37 91% 55%)' },  // orange → amber
  { from: 'hsl(139 65% 38%)', to: 'hsl(211 90% 45%)' }, // green → blue
  { from: 'hsl(358 75% 59%)', to: 'hsl(21 97% 53%)' },  // red → orange
  { from: 'hsl(211 90% 45%)', to: 'hsl(187 71% 49%)' }, // blue → teal
  { from: 'hsl(263 82% 58%)', to: 'hsl(358 75% 59%)' }, // purple → red
  { from: 'hsl(37 91% 55%)', to: 'hsl(358 75% 59%)' },  // amber → red
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
  const [currency, setCurrency] = useState<string>('KES');

  const [authOpen, setAuthOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
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
      const j = (await res.json()) as { balanceMinor: number; currency?: string };
      setBalanceMinor(j.balanceMinor ?? 0);
      if (j.currency) setCurrency(j.currency);
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

  const featured = games?.[0];

  return (
    <div className="min-h-screen text-neutral-100 relative overflow-x-hidden">
      {/* Ambient background — soft brand glow, sits behind everything */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 -left-32 w-[38rem] h-[38rem] rounded-full bg-brand-500/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 w-[34rem] h-[34rem] rounded-full bg-bet-400/10 blur-[130px]" />
      </div>

      {/* ─── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center justify-between px-4 sm:px-6 h-16 border-b border-white/5 bg-space-950/60 backdrop-blur-xl">
        <div className="flex items-center gap-3 min-w-0">
          <LobbyLogo />
          <div className="flex flex-col min-w-0 leading-none">
            <h1 className="font-display font-extrabold text-lg tracking-tight">
              <span className="text-brand-500">Nova</span>
              <span className="ml-1 text-white">Casino</span>
            </h1>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 mt-1">
              Provably-fair crash games
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {token ? (
            <>
              <div className="flex items-center gap-3 bg-space-900/70 border border-white/5 rounded-control pl-3 pr-1.5 py-1.5">
                <div className="leading-tight">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
                    {username ?? 'Player'}
                  </div>
                  <div className="text-base sm:text-lg font-bold text-bet-400 tabular-nums">
                    {balanceMinor == null ? '—' : fromMinor(balanceMinor, currency)}
                  </div>
                </div>
                <button
                  onClick={() => setDepositOpen(true)}
                  className="text-[11px] font-bold text-space-950 bg-brand-500 hover:bg-brand-400 transition px-3 py-2 rounded-lg"
                  title="Deposit to your wallet"
                >
                  Deposit
                </button>
              </div>
              <button
                onClick={logout}
                className="text-xs font-bold text-neutral-300 hover:text-white transition px-3.5 py-2.5 rounded-control bg-space-900/70 border border-white/5"
              >
                Log out
              </button>
            </>
          ) : (
            <button
              onClick={() => { setPendingGameId(null); setAuthOpen(true); }}
              className="text-sm px-5 py-2.5 rounded-control font-bold bg-brand-500 text-space-950 hover:bg-brand-400 transition"
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
          <div className="mb-6 text-xs text-loss-500 bg-loss-500/10 border border-loss-500/30 rounded-control px-4 py-3">
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

      <footer className="text-center py-5 text-[11px] text-neutral-500 border-t border-white/5 bg-space-950/60 mt-10">
        Nova Casino · simulation only · no real wagers, no real money.
      </footer>

      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onSuccess={onAuthSuccess} />}
      {depositOpen && token && (
        <DepositModal
          token={token}
          currency={currency}
          onClose={() => setDepositOpen(false)}
          onCredited={() => { const t = readToken(); if (t) refreshBalance(t); }}
        />
      )}
    </div>
  );
}

// ─── Deposit modal ────────────────────────────────────────────────────────────
// Deposits are async: POST kicks off an M-PESA STK push, the player approves on
// their phone, and Maplerad's webhook credits the wallet moments later. So we
// show a "check your phone" pending state and poll /me until the balance rises.
type DepositPhase = 'form' | 'pending' | 'credited' | 'error';

function DepositModal({
  token, currency, onClose, onCredited,
}: {
  token: string; currency: string; onClose: () => void; onCredited: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<DepositPhase>('form');
  const [message, setMessage] = useState<string | null>(null);
  const sym = symbolFor(currency);

  const submit = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setMessage('Enter an amount greater than zero.'); return; }
    let amountMinor: number;
    try { amountMinor = toMinor(value, currency); } catch { setMessage('That amount is too large.'); return; }
    setMessage(null);
    try {
      const res = await fetch('/api/lobby/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountMinor }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
      if (!res.ok) { setPhase('error'); setMessage(j?.error?.message ?? 'Could not start the deposit. Try again.'); return; }
      setPhase('pending');
      setMessage(j?.message ?? 'Check your phone to approve the prompt.');
    } catch {
      setPhase('error');
      setMessage('Network error — please try again.');
    }
  };

  // While pending, poll the balance until the webhook credits it (~up to 3 min).
  useEffect(() => {
    if (phase !== 'pending') return;
    let cancelled = false;
    let start: number | null = null;
    const deadline = Date.now() + 3 * 60_000;
    const poll = async () => {
      try {
        const res = await fetch('/api/lobby/me', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const j = (await res.json()) as { balanceMinor?: number };
          const bal = j.balanceMinor ?? 0;
          if (start == null) start = bal;
          else if (bal > start) { if (!cancelled) { setPhase('credited'); onCredited(); } return; }
        }
      } catch { /* keep polling */ }
      if (!cancelled && Date.now() < deadline) setTimeout(poll, 4000);
    };
    const id = setTimeout(poll, 4000);
    return () => { cancelled = true; clearTimeout(id); };
  }, [phase, token, onCredited]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-space-950/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-panel border border-white/10 bg-space-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-extrabold text-lg">Deposit</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {phase === 'credited' ? (
          <div className="text-center py-4">
            <div className="text-3xl mb-2">✓</div>
            <p className="text-sm text-neutral-200">Your wallet has been topped up.</p>
            <button onClick={onClose} className="mt-5 w-full py-2.5 rounded-control font-bold bg-brand-500 text-space-950 hover:bg-brand-400 transition">Done</button>
          </div>
        ) : phase === 'pending' ? (
          <div className="text-center py-4">
            <div className="w-8 h-8 mx-auto mb-3 rounded-full border-2 border-brand-500/30 border-t-brand-500 animate-spin" />
            <p className="text-sm text-neutral-200">{message}</p>
            <p className="text-xs text-neutral-500 mt-2">Waiting for confirmation — this window updates automatically.</p>
            <button onClick={onClose} className="mt-5 w-full py-2.5 rounded-control font-bold bg-space-800 border border-white/10 text-neutral-200 hover:text-white transition">Close</button>
          </div>
        ) : (
          <>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 mb-2">Amount ({currency})</label>
            <div className="flex items-center gap-2 rounded-control bg-space-950 border border-white/10 px-3 focus-within:border-brand-500/60 transition">
              <span className="text-neutral-400 text-sm">{sym.trim()}</span>
              <input
                autoFocus
                type="number" min="0" step="any" inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="0.00"
                className="flex-1 bg-transparent py-3 text-lg font-bold tabular-nums outline-none placeholder:text-neutral-600"
              />
            </div>
            {message && <p className="text-xs text-loss-500 mt-2">{message}</p>}
            <button
              onClick={submit}
              className="mt-5 w-full py-3 rounded-control font-black bg-brand-500 text-space-950 hover:bg-brand-400 transition"
            >
              Continue
            </button>
            <p className="text-[11px] text-neutral-500 mt-3 text-center">You'll approve the payment prompt on your phone.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Hero band ──────────────────────────────────────────────────────────────
function Hero({ game, onPlay }: { game: Game; onPlay: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-panel mb-6 border border-white/10 bg-gradient-to-br from-space-800 to-space-900">
      {/* gradient mesh accents */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 right-10 w-96 h-96 rounded-full bg-brand-500/20 blur-[90px]" />
        <div className="absolute -bottom-28 -left-10 w-96 h-96 rounded-full bg-bet-400/15 blur-[90px]" />
      </div>

      <div className="relative grid md:grid-cols-[1.2fr_1fr] gap-6 p-6 sm:p-9 items-center">
        <div className="max-w-xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/15 text-brand-300 text-[10px] font-extrabold uppercase tracking-[0.16em] px-2.5 py-1 mb-4 ring-1 ring-brand-500/25">
            <RocketGlyph className="w-3 h-3" /> Featured · {game.name}
          </span>
          <h2 className="font-display font-black text-4xl sm:text-5xl leading-[1.02] tracking-tight">
            Cash out before<br className="hidden sm:block" /> it <span className="text-brand-400">crashes.</span>
          </h2>
          <p className="text-sm text-neutral-300/90 mt-3 leading-relaxed">
            Watch the multiplier climb and grab it in time. Every round is provably fair — verify the seed yourself.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-6">
            <button
              onClick={onPlay}
              className="px-6 py-3 rounded-control font-black text-space-950 bg-brand-500 hover:bg-brand-400 transition shadow-lg shadow-brand-500/20"
            >
              Play free
            </button>
            <span className="text-xs text-neutral-400 font-semibold">No signup for demo</span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 mt-6 text-[11px] font-semibold text-neutral-400">
            <TrustChip>Provably fair</TrustChip>
            <TrustChip>Instant cash-out</TrustChip>
            <TrustChip>Live multiplayer</TrustChip>
          </div>
        </div>

        {/* Animated multiplier motif */}
        <div className="hidden md:flex items-center justify-center">
          <HeroMultiplier />
        </div>
      </div>
    </div>
  );
}

function TrustChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-bet-400" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      {children}
    </span>
  );
}

// A looping climb-then-reset multiplier — a tiny live taste of the game.
function HeroMultiplier() {
  const [m, setM] = useState(1.0);
  useEffect(() => {
    let raf = 0, t0 = performance.now(), cap = 2 + Math.random() * 8;
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const v = Math.pow(Math.E, 0.14 * t);
      if (v >= cap) { t0 = now; cap = 2 + Math.random() * 8; setM(1.0); }
      else setM(v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const col = m >= 5 ? '#fbbf24' : m >= 2 ? '#22d3ee' : '#34d399';
  return (
    <div className="relative w-full max-w-xs aspect-video rounded-2xl border border-white/10 bg-space-950/60 grid place-items-center overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-40" style={{ background: `radial-gradient(circle at 50% 60%, ${col}22, transparent 60%)` }} />
      <div className="relative text-5xl font-black tabular-nums tracking-tight" style={{ color: col, textShadow: `0 0 24px ${col}66` }}>
        {m.toFixed(2)}x
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
    <div className="group rounded-panel border border-white/10 bg-space-800/70 overflow-hidden flex flex-col transition duration-200 hover:border-brand-500/50 hover:-translate-y-1 hover:shadow-2xl hover:shadow-brand-500/10">
      {/* Preview banner painted with the game's own theme accents (real identity) */}
      <div
        className="aspect-[16/10] relative flex items-start justify-between p-3 overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${accent.from}, ${accent.to})` }}
      >
        {/* gloss sweep on hover */}
        <div aria-hidden className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-out bg-gradient-to-r from-transparent via-white/15 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-space-950/80 via-transparent to-transparent" />
        <span className="relative z-10 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.14em] bg-brand-500 text-space-950">
          New
        </span>
        <span className="relative z-10 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] bg-space-950/50 backdrop-blur-sm border border-white/10 text-white">
          {game.gameType}
        </span>
        {/* hover play affordance */}
        <div aria-hidden className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition duration-200">
          <span className="grid place-items-center w-14 h-14 rounded-full bg-space-950/60 backdrop-blur-sm border border-white/20 scale-90 group-hover:scale-100 transition">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-white translate-x-0.5" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </div>
        {/* game name over the banner */}
        <h3 className="absolute z-10 bottom-2.5 left-3 right-3 font-display font-extrabold text-lg tracking-tight truncate drop-shadow" title={game.name}>
          {game.name}
        </h3>
      </div>

      <div className="p-3.5 flex items-center gap-2">
        <span className="mr-auto inline-flex items-center gap-1.5 text-[10px] font-semibold text-neutral-400">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-bet-400" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          Provably fair
        </span>
        <button
          onClick={onDemo}
          className="rounded-control px-4 py-2 text-xs font-bold uppercase tracking-wide bg-space-900/80 border border-white/10 text-neutral-200 hover:bg-space-600/60 hover:text-white transition"
        >
          Demo
        </button>
        <button
          onClick={onReal}
          className="rounded-control px-4 py-2 text-xs font-bold uppercase tracking-wide bg-brand-500 text-space-950 hover:bg-brand-400 transition"
        >
          Real
        </button>
      </div>
    </div>
  );
}

// ─── Empty / loading / logo ─────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="rounded-panel border border-dashed border-white/10 bg-space-800/50 px-6 py-16 text-center">
      <RocketGlyph className="w-10 h-10 mx-auto mb-3 text-brand-400" />
      <h3 className="font-display font-extrabold text-lg text-neutral-200">No games yet</h3>
      <p className="text-sm text-neutral-500 mt-1">Publish one from the Creator to see it here.</p>
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
    <div className="w-10 h-10 rounded-control bg-space-900 border border-white/10 grid place-items-center">
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
