import { useCallback, useEffect, useRef, useState } from 'react';
import GameCanvas from './components/GameCanvas';
import BetPanel from './components/BetPanel';
import PlayerList from './components/PlayerList';
import HistoryStrip from './components/HistoryStrip';
import ProvablyFairDrawer from './components/ProvablyFairDrawer';
import {
  applyThemeSounds, cashoutChime, crashBoom, isMuted, placeBet as sndPlaceBet,
  setMuted, startMusic, takeoffWhoosh, uiTick,
} from './sounds';
import { applyThemeCssVars, clearTheme, fetchServerTheme, hasUserOverride, loadTheme, readThemeFromFile, saveTheme } from './theme/loader';
import { DEFAULT_THEME, tierColor as resolveTierColor, type Theme } from './theme/types';
import { formatBalance, toMinor } from './lib/money';

/**
 * In a production build the theme is whatever the server is serving from
 * config/active-theme.json. Players can't override it — the upload/reset UI
 * is hidden, and we never persist a user override to localStorage.
 *
 * Vite bakes `import.meta.env.PROD` to `true` for `vite build`, `false` for
 * `vite dev`. So local development keeps the full theme-editing experience.
 */
const THEME_LOCKED = import.meta.env.PROD;

interface Bet {
  playerId: string;
  amount: number;
  autoCashout?: number;
  cashedOut: boolean;
  isBot: boolean;
  botName?: string;
  displayName?: string;
  profit?: number;
  cashoutMultiplier?: number;
}

interface SessionInfo {
  sessionId: string;
  displayName: string;
  operatorId?: string;
  playerId?: string;
  currency?: string;
  balanceMinor?: number;
  rgLimits?: { maxBetMinor?: number; sessionEndsAt?: number };
}

interface SessionStats {
  bets: number; wins: number; losses: number;
  totalWagered: number; totalWon: number; netProfit: number;
  biggestCashout: number; biggestWin: number;
  currentStreak: number; bestStreak: number;
}

const ZERO_STATS: SessionStats = {
  bets: 0, wins: 0, losses: 0,
  totalWagered: 0, totalWon: 0, netProfit: 0,
  biggestCashout: 0, biggestWin: 0,
  currentStreak: 0, bestStreak: 0,
};

interface HistoryEntry {
  roundNumber: number;
  crashPoint: number;
}

interface GameState {
  roundNumber: number;
  phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';
  currentMultiplier: number;
  crashPoint?: number;
  serverSeed?: string;
  hashCommit?: string;
  prevServerSeed?: string | null;
  prevRoundNumber?: number | null;
  bets: Bet[];
  history: HistoryEntry[];
  countdownMs?: number;
  flightStartTime?: number | null;
}

const SESSION_PARAM = 'session';

function readSessionIdFromUrl(): string | null {
  try {
    const id = new URLSearchParams(location.search).get(SESSION_PARAM);
    return id && /^[a-z0-9]{8,32}$/.test(id) ? id : null;
  } catch { return null; }
}

function writeSessionIdToUrl(sessionId: string) {
  try {
    const url = new URL(location.href);
    url.searchParams.set(SESSION_PARAM, sessionId);
    history.replaceState(null, '', url.toString());
  } catch { /* ignore */ }
}

async function createNewSession(): Promise<SessionInfo | null> {
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.status === 503) return null; // backend offline
    if (!res.ok) return null;
    const j = await res.json() as { sessionId: string; displayName: string };
    return { sessionId: j.sessionId, displayName: j.displayName };
  } catch { return null; }
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>({
    roundNumber: 0,
    phase: 'BETTING',
    currentMultiplier: 1.0,
    bets: [],
    history: [],
    flightStartTime: null,
  });
  const [balance, setBalance] = useState(1000);
  const [betAmount, setBetAmount] = useState(10);
  const [autoCashoutEnabled, setAutoCashoutEnabled] = useState(false);
  const [autoCashout, setAutoCashout] = useState(2.0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [lobbyUrl, setLobbyUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats>(ZERO_STATS);
  const [hasBet, setHasBet] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: 'win' | 'loss' | 'info'; text: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [soundOn, setSoundOn] = useState(!isMuted());
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const wsRef = useRef<WebSocket | null>(null);
  const serverOffsetRef = useRef(0);
  const themeFileInputRef = useRef<HTMLInputElement>(null);

  const flashToast = useCallback((kind: 'win' | 'loss' | 'info', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  // Apply theme tokens (CSS vars + sounds) whenever the theme changes
  useEffect(() => {
    applyThemeCssVars(theme);
    applyThemeSounds(theme.sounds);
    // Production: never persist the theme — the server is the source of truth
    // each time the page loads. Dev: persist so refresh keeps your last edit.
    if (!THEME_LOCKED) saveTheme(theme);
    document.title = theme.brandName || 'Galaxy Crash';
  }, [theme]);

  // On boot, fetch the operator-configured theme from /api/theme.
  // Precedence: localStorage user override > server config > built-in default.
  useEffect(() => {
    if (hasUserOverride()) return; // user-loaded theme already in localStorage wins
    fetchServerTheme().then((t) => {
      if (t) setTheme(t);
    });
  }, []);

  // Read operator launch params (?lobby, ?return) once on mount, then strip them
  // from the URL so they don't persist across reloads. The ?session= param is kept.
  useEffect(() => {
    try {
      const params = new URLSearchParams(location.search);
      const lobby = params.get('lobby');
      const ret = params.get('return');
      if (lobby) setLobbyUrl(lobby);
      // Strip these from the URL while preserving ?session=
      if (lobby || ret) {
        params.delete('lobby');
        params.delete('return');
        const newSearch = params.toString();
        const newUrl = location.pathname + (newSearch ? `?${newSearch}` : '');
        history.replaceState(null, '', newUrl);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bootstrap the session — pull from URL, validate, or create a fresh one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id = readSessionIdFromUrl();
      if (!id) {
        const fresh = await createNewSession();
        if (cancelled) return;
        if (!fresh) {
          setSessionError('Backend offline — start Dragonfly with `docker compose up -d dragonfly`');
          return;
        }
        writeSessionIdToUrl(fresh.sessionId);
        setSession(fresh);
      } else {
        // We have an id from the URL — fetch the session to confirm it's valid
        try {
          const res = await fetch(`/api/sessions/${id}`);
          if (res.status === 404) {
            // session expired or invalid — mint a new one
            const fresh = await createNewSession();
            if (cancelled) return;
            if (!fresh) {
              setSessionError('Backend offline — start Dragonfly with `docker compose up -d dragonfly`');
              return;
            }
            writeSessionIdToUrl(fresh.sessionId);
            setSession(fresh);
          } else if (res.status === 503) {
            setSessionError('Backend offline — start Dragonfly with `docker compose up -d dragonfly`');
          } else if (res.ok) {
            const j = await res.json() as { session: SessionInfo & { balance: number }; stats: SessionStats };
            if (cancelled) return;
            setSession({
              sessionId: j.session.sessionId,
              displayName: j.session.displayName,
              operatorId: j.session.operatorId,
              playerId: j.session.playerId,
              currency: j.session.currency,
              balanceMinor: j.session.balanceMinor,
              rgLimits: j.session.rgLimits,
            });
            setBalance(j.session.balance);
            setStats(j.stats);
          }
        } catch {
          setSessionError('Could not reach the server');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadThemeFromFile = useCallback(async (file: File) => {
    try {
      const t = await readThemeFromFile(file);
      setTheme(t);
      saveTheme(t, /* isUserOverride */ true);
      flashToast('info', `Theme loaded: ${t.brandName}`);
      window.setTimeout(() => startMusic(), 50);
    } catch (e) {
      flashToast('loss', `Failed to load theme: ${(e as Error).message}`);
    }
  }, [flashToast]);

  const resetTheme = useCallback(async () => {
    // Clear user override, then re-fetch server theme; fall back to built-in.
    clearTheme();
    const server = await fetchServerTheme();
    if (server) {
      setTheme(server);
      flashToast('info', `Reset to server theme: ${server.brandName}`);
    } else {
      setTheme(DEFAULT_THEME);
      flashToast('info', 'Reset to default Galaxy Crash');
    }
  }, [flashToast]);

  useEffect(() => {
    // Don't open the WebSocket until we have a session id to attach to
    if (!session) return;
    let alive = true;
    let reconnectTimer: number | undefined;

    const connect = () => {
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${wsProto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'hello', data: { sessionId: session.sessionId } }));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch (e) { console.error('bad msg', e); }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!alive) return;
        reconnectTimer = window.setTimeout(connect, 1200);
      };
      ws.onerror = () => { /* close handler reconnects */ };
    };

    connect();
    return () => {
      alive = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId]);

  const handleMessage = useCallback((message: { type: string; data: any }) => {
    if (message.data?.serverTime) {
      serverOffsetRef.current = message.data.serverTime - Date.now();
    }

    switch (message.type) {
      case 'join':
        setGameState((prev) => ({
          ...prev,
          ...message.data,
          flightStartTime: message.data.phase === 'FLYING' ? message.data.startTime : null,
        }));
        setHasBet(false);
        break;

      case 'phase_change':
        if (message.data.phase === 'FLYING') takeoffWhoosh();
        setGameState((prev) => ({
          ...prev,
          phase: message.data.phase,
          roundNumber: message.data.roundNumber ?? prev.roundNumber,
          hashCommit: message.data.hashCommit ?? prev.hashCommit,
          countdownMs: message.data.countdownMs,
          history: message.data.history ?? prev.history,
          bets: message.data.bets ?? (message.data.phase === 'BETTING' ? [] : prev.bets),
          currentMultiplier: message.data.phase === 'FLYING' ? 1.0 : prev.currentMultiplier,
          crashPoint: message.data.phase === 'BETTING' ? undefined : (message.data.crashPoint ?? prev.crashPoint),
          flightStartTime: message.data.phase === 'FLYING' ? message.data.startTime : null,
          serverSeed: message.data.phase === 'RESULT' ? message.data.serverSeed : prev.serverSeed,
          prevServerSeed: message.data.prevServerSeed ?? prev.prevServerSeed,
          prevRoundNumber: message.data.prevRoundNumber ?? prev.prevRoundNumber,
        }));
        if (message.data.phase === 'BETTING') setHasBet(false);
        break;

      case 'countdown_update':
        setGameState((prev) => ({ ...prev, countdownMs: message.data.countdownMs }));
        break;

      case 'multiplier_update':
        setGameState((prev) => ({ ...prev, currentMultiplier: message.data.multiplier }));
        break;

      case 'crash':
        crashBoom();
        setGameState((prev) => ({
          ...prev,
          phase: 'CRASHED',
          crashPoint: message.data.crashPoint,
          currentMultiplier: message.data.crashPoint,
          serverSeed: message.data.serverSeed,
          bets: message.data.bets ?? prev.bets,
        }));
        setHasBet((had) => {
          if (had) flashToast('loss', `Crashed @ ${message.data.crashPoint.toFixed(2)}x`);
          return false;
        });
        break;

      case 'bet_placed':
        sndPlaceBet();
        // For operator sessions, the server sends balanceMinor (not balance).
        // We store it in the same `balance` state; formatBalance() renders it correctly.
        if (message.data.balanceMinor != null) {
          setBalance(message.data.balanceMinor);
          setSession((prev) => prev ? { ...prev, balanceMinor: message.data.balanceMinor } : prev);
        } else if (message.data.balance != null) {
          setBalance(message.data.balance);
        }
        setHasBet(true);
        if (message.data.stats) setStats(message.data.stats);
        flashToast('info', `Bet placed · $${message.data.bet.amount.toFixed(2)}`);
        break;

      case 'cashout_success':
        cashoutChime();
        // For operator sessions, prefer balanceMinor; fall back to legacy balance.
        if (message.data.balanceMinor != null) {
          setBalance(message.data.balanceMinor);
          setSession((prev) => prev ? { ...prev, balanceMinor: message.data.balanceMinor } : prev);
        } else if (message.data.balance != null) {
          setBalance(message.data.balance);
        }
        setHasBet(false);
        if (message.data.stats) setStats(message.data.stats);
        flashToast('win', `${message.data.source === 'auto' ? 'Auto cash out' : 'Cashed out'} @ ${message.data.multiplier.toFixed(2)}x  +$${message.data.profit.toFixed(2)}`);
        break;

      case 'cashout':
        setGameState((prev) => ({
          ...prev,
          bets: prev.bets.map((b) =>
            b.playerId === message.data.playerId
              ? { ...b, cashedOut: true, cashoutMultiplier: message.data.multiplier, profit: message.data.profit }
              : b,
          ),
        }));
        break;

      case 'new_bet':
        setGameState((prev) => {
          if (prev.bets.some((b) => b.playerId === message.data.playerId)) return prev;
          return {
            ...prev,
            bets: [
              ...prev.bets,
              {
                playerId: message.data.playerId,
                amount: message.data.amount,
                autoCashout: message.data.autoCashout,
                cashedOut: false,
                isBot: !!message.data.isBot,
                botName: message.data.botName,
                displayName: message.data.displayName,
              },
            ],
          };
        });
        break;

      case 'balance':
        if (message.data.balanceMinor != null) {
          setBalance(message.data.balanceMinor);
          setSession((prev) => prev ? { ...prev, balanceMinor: message.data.balanceMinor } : prev);
        } else {
          setBalance(message.data.balance);
        }
        break;

      case 'session_hello':
        if (message.data.session) {
          setSession({
            sessionId: message.data.session.sessionId,
            displayName: message.data.session.displayName,
            operatorId: message.data.session.operatorId,
            playerId: message.data.session.playerId,
            currency: message.data.session.currency,
            balanceMinor: message.data.session.balanceMinor,
            rgLimits: message.data.session.rgLimits,
          });
          setBalance(message.data.session.balance);
        }
        if (message.data.stats) setStats(message.data.stats);
        break;

      case 'stats_update':
        if (message.data.stats) setStats(message.data.stats);
        break;

      case 'session_invalid':
        // URL session is bogus — mint a new one and reload
        flashToast('loss', 'Session expired — creating a new one');
        createNewSession().then((fresh) => {
          if (fresh) {
            writeSessionIdToUrl(fresh.sessionId);
            setSession(fresh);
            setBalance(1000);
            setStats(ZERO_STATS);
          }
        });
        break;

      case 'error':
        flashToast('loss', message.data?.message ?? 'Error');
        break;
    }
  }, [flashToast]);

  const placeBet = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
    if (session.operatorId) {
      // Operator session: send amountMinor (integer minor units)
      const amountMinor = toMinor(betAmount, session.currency);
      ws.send(JSON.stringify({
        type: 'place_bet',
        data: { sessionId: session.sessionId, amountMinor, autoCashout: autoCashoutEnabled ? autoCashout : undefined },
      }));
    } else {
      // Legacy demo session: send decimal amount (byte-unchanged)
      ws.send(JSON.stringify({
        type: 'place_bet',
        data: { sessionId: session.sessionId, amount: betAmount, autoCashout: autoCashoutEnabled ? autoCashout : undefined },
      }));
    }
  };
  const cashout = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
    ws.send(JSON.stringify({ type: 'cashout', data: { sessionId: session.sessionId } }));
  };
  const resetBalance = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
    ws.send(JSON.stringify({ type: 'reset_balance', data: { sessionId: session.sessionId } }));
  };

  const getChipClass = (cp: number) => (cp < 2 ? 'pink' : cp < 10 ? 'purple' : 'gold');

  // Tier color from active theme — drives canvas curve, multiplier readout, history
  const getMultiplierColor = useCallback(
    (m: number) => resolveTierColor(theme, m),
    [theme],
  );

  return (
    <div className="min-h-screen text-slate-100 relative">
      <Header
        connected={connected}
        soundOn={soundOn}
        onToggleSound={() => {
          uiTick();
          const next = !soundOn;
          setSoundOn(next);
          setMuted(!next);
          if (next) startMusic();
        }}
        onOpenDrawer={() => setDrawerOpen(true)}
        balance={balance}
        onResetBalance={resetBalance}
        theme={theme}
        themeLocked={THEME_LOCKED}
        onLoadThemeClick={() => themeFileInputRef.current?.click()}
        onResetTheme={resetTheme}
        session={session}
        lobbyUrl={lobbyUrl}
      />
      {!THEME_LOCKED && (
        <input
          ref={themeFileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadThemeFromFile(f);
            e.target.value = '';
          }}
        />
      )}

      <HistoryStrip history={gameState.history} getChipClass={getChipClass} />

      {sessionError && (
        <div className="px-4 py-2 bg-nebula-500/15 border-b border-nebula-500/40 text-nebula-400 text-xs font-mono text-center">
          {sessionError}
        </div>
      )}

      <main className="flex flex-col lg:flex-row gap-4 p-4 lg:p-5 lg:h-[calc(100vh-148px)]">
        {/* Game Canvas */}
        <section className="flex-1 relative rounded-panel overflow-hidden border border-space-500/40 bg-space-900/40 shadow-panel min-h-[340px] lg:min-h-0">
          <GameCanvas
            phase={gameState.phase}
            flightStartTime={gameState.flightStartTime ?? null}
            serverClockOffsetMs={serverOffsetRef.current}
            currentMultiplier={gameState.currentMultiplier}
            crashPoint={gameState.crashPoint}
            hashCommit={gameState.hashCommit}
            countdownMs={gameState.countdownMs}
            getMultiplierColor={getMultiplierColor}
            theme={theme}
          />

          <div className="absolute top-3 left-3 text-[10px] uppercase tracking-[0.18em] text-slate-300/50 bg-space-900/60 backdrop-blur-md rounded-md px-2 py-1 border border-space-500/40 font-mono">
            Round · {gameState.roundNumber}
          </div>

          {toast && (
            <div
              className={`absolute top-3 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl text-sm font-semibold backdrop-blur-md border animate-toast-in ${
                toast.kind === 'win'
                  ? 'bg-aurora-500/15 text-aurora-400 border-aurora-500/40 shadow-aurora'
                  : toast.kind === 'loss'
                  ? 'bg-nebula-500/15 text-nebula-400 border-nebula-500/40 shadow-nebula'
                  : 'bg-plasma-500/15 text-plasma-400 border-plasma-500/40 shadow-plasma'
              }`}
            >
              {toast.text}
            </div>
          )}
        </section>

        {/* Sidebar */}
        <aside className="lg:w-[340px] flex flex-col gap-4 min-h-0">
          <BetPanel
            phase={gameState.phase}
            hasBet={hasBet}
            balance={balance}
            betAmount={betAmount}
            setBetAmount={setBetAmount}
            autoCashoutEnabled={autoCashoutEnabled}
            setAutoCashoutEnabled={setAutoCashoutEnabled}
            autoCashout={autoCashout}
            setAutoCashout={setAutoCashout}
            currentMultiplier={gameState.currentMultiplier}
            countdownMs={gameState.countdownMs}
            betAmounts={[1, 5, 10, 25, 50, 100, 500]}
            onPlaceBet={placeBet}
            onCashout={cashout}
            maxBetMinor={session?.rgLimits?.maxBetMinor}
            currency={session?.currency}
            isOperator={!!session?.operatorId}
          />
          <PlayerList bets={gameState.bets} youPlayerId={session?.sessionId} />
          <StatsPanel stats={stats} displayName={session?.displayName} />
        </aside>
      </main>

      <footer className="text-center py-3 text-[11px] text-slate-500 border-t border-space-500/30 bg-space-950/60">
        {theme.brandName || 'Galaxy Crash'} · simulation only · no real wagers, no real money.
      </footer>

      <ProvablyFairDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentRound={gameState}
      />
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function Header({
  connected, soundOn, onToggleSound, onOpenDrawer, balance, onResetBalance,
  theme, themeLocked, onLoadThemeClick, onResetTheme, session, lobbyUrl,
}: {
  connected: boolean;
  soundOn: boolean;
  onToggleSound: () => void;
  onOpenDrawer: () => void;
  balance: number;
  onResetBalance: () => void;
  theme: Theme;
  themeLocked: boolean;
  onLoadThemeClick: () => void;
  onResetTheme: () => void;
  session?: SessionInfo | null;
  lobbyUrl?: string | null;
}) {
  const brand = theme.brandName || 'Galaxy Crash';
  const tagline = theme.brandTagline || 'provably-fair multiplier';
  const customLogo = theme.assets?.logo;
  return (
    <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-space-500/30 bg-space-950/70 backdrop-blur-xl relative z-10">
      <div className="flex items-center gap-3 min-w-0">
        {customLogo ? (
          <img
            src={customLogo}
            alt={brand}
            className="w-9 h-9 rounded-control object-contain border border-space-500/60 bg-space-800/60 shrink-0"
          />
        ) : (
          <Logo />
        )}
        <div className="flex flex-col min-w-0">
          <h1 className="font-display font-bold text-[15px] sm:text-base tracking-[0.18em] uppercase leading-none truncate" style={{ color: theme.colors.text }}>
            <span className="bg-gradient-to-r from-plasma-400 via-cosmos-400 to-nebula-400 bg-clip-text text-transparent">
              {brand.split(' ')[0]}
            </span>
            {brand.split(' ').slice(1).length > 0 && (
              <span className="ml-1.5">{brand.split(' ').slice(1).join(' ')}</span>
            )}
          </h1>
          <span className="text-[9px] uppercase tracking-[0.22em] text-slate-500 mt-0.5 truncate">
            {tagline}
          </span>
        </div>
        <span
          className={`hidden sm:inline-block w-1.5 h-1.5 rounded-full ml-3 ${connected ? 'bg-aurora-500' : 'bg-nebula-500 animate-pulse'}`}
          title={connected ? 'live' : 'reconnecting'}
        />
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <IconButton onClick={onToggleSound} label={soundOn ? 'Mute sounds' : 'Unmute sounds'}>
          {soundOn ? <SpeakerIcon /> : <SpeakerMutedIcon />}
        </IconButton>
        {!themeLocked && (
          <>
            <IconButton onClick={onLoadThemeClick} label="Load theme pack">
              <ThemeIcon />
              <span className="hidden md:inline ml-1.5 text-xs font-medium text-slate-300">Theme</span>
            </IconButton>
            <IconButton onClick={onResetTheme} label="Reset to default theme">
              <ResetIcon />
            </IconButton>
          </>
        )}
        <IconButton onClick={onOpenDrawer} label="Provably fair">
          <ShieldIcon />
          <span className="hidden md:inline ml-1.5 text-xs font-medium text-slate-300">Fair</span>
        </IconButton>

        {lobbyUrl && (
          <button
            onClick={() => {
              window.parent.postMessage({ type: 'lobby' }, '*');
              setTimeout(() => {
                if (lobbyUrl && window.top) window.top.location.href = lobbyUrl;
              }, 50);
            }}
            className="text-[10px] text-slate-400 hover:text-slate-100 transition px-2 py-1.5 rounded-control bg-space-800/80 border border-space-500/50 uppercase tracking-wider font-semibold"
            title="Return to lobby"
          >
            Lobby
          </button>
        )}
        <div className="flex items-center gap-2 sm:gap-3 bg-space-800/80 border border-space-500/50 rounded-control px-3 py-1.5">
          <div className="leading-tight">
            <div className="text-[9px] uppercase tracking-[0.22em] text-slate-500">Balance</div>
            <div className="text-base sm:text-lg font-mono font-semibold text-aurora-400">{formatBalance(balance, session ?? null)}</div>
          </div>
          {!session?.operatorId && (
            <button
              onClick={onResetBalance}
              className="text-[10px] text-slate-400 hover:text-slate-100 transition px-2 py-1 rounded bg-space-700/60 border border-space-500/40 uppercase tracking-wider"
              title="Reset balance to $1000"
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function ThemeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r="2.5"/>
      <circle cx="19" cy="13" r="2.5"/>
      <circle cx="6" cy="11" r="2.5"/>
      <circle cx="10" cy="20" r="2.5"/>
      <path d="M2 12C2 6 7 2 12 2s10 4 10 10-4 10-10 10c-2 0-2-2-1-3 1-1 1-3-1-3-2 0-8 0-8-4z"/>
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
    </svg>
  );
}

function IconButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex items-center text-slate-400 hover:text-slate-100 transition px-2.5 py-2 rounded-control hover:bg-space-700/60 border border-transparent hover:border-space-500/40"
    >
      {children}
    </button>
  );
}

function Logo() {
  return (
    <div className="w-9 h-9 rounded-control bg-gradient-to-br from-cosmos-600 via-space-700 to-plasma-600 border border-space-500/60 flex items-center justify-center shadow-plasma/50">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2 L15 8 L15 16 Q12 22 9 16 L9 8 Z" fill="#f8fafc" stroke="#0f172a" strokeWidth="0.5"/>
        <circle cx="12" cy="9" r="1.6" fill="#22d3ee"/>
        <path d="M9 15 L6 19 L9 17 Z" fill="#ef4444"/>
        <path d="M15 15 L18 19 L15 17 Z" fill="#ef4444"/>
        <path d="M11 18 Q12 22 13 18 Z" fill="#fbbf24"/>
      </svg>
    </div>
  );
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
    </svg>
  );
}

function SpeakerMutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/>
      <line x1="23" y1="9" x2="17" y2="15"/>
      <line x1="17" y1="9" x2="23" y2="15"/>
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  );
}


// ─── Session stats sidebar panel ─────────────────────────────────────────────
function StatsPanel({ stats, displayName }: { stats: SessionStats; displayName?: string }) {
  const net = stats.netProfit;
  const streakLabel = stats.currentStreak > 0
    ? `${stats.currentStreak} wins`
    : stats.currentStreak < 0
    ? `${Math.abs(stats.currentStreak)} losses`
    : '—';
  return (
    <div className="bg-space-900/70 backdrop-blur-md border border-space-500/40 rounded-panel p-4 shadow-panel">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.22em]">Your stats</h2>
        {displayName && (
          <span className="text-[10px] font-mono text-cosmos-400 truncate ml-2" title={displayName}>
            {displayName}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <StatTile label="Bets" value={stats.bets.toString()} />
        <StatTile label="Wins" value={`${stats.wins} / ${stats.losses}`} />
        <StatTile label="Wagered" value={`$${stats.totalWagered.toFixed(2)}`} />
        <StatTile label="Won" value={`$${stats.totalWon.toFixed(2)}`} />
        <StatTile
          label="Net P/L"
          value={`${net >= 0 ? '+' : ''}$${net.toFixed(2)}`}
          tone={net > 0 ? 'win' : net < 0 ? 'loss' : 'neutral'}
        />
        <StatTile label="Streak" value={streakLabel} tone={stats.currentStreak > 0 ? 'win' : stats.currentStreak < 0 ? 'loss' : 'neutral'} />
        <StatTile label="Biggest x" value={stats.biggestCashout > 0 ? `${stats.biggestCashout.toFixed(2)}x` : '—'} />
        <StatTile label="Best win" value={stats.biggestWin > 0 ? `$${stats.biggestWin.toFixed(2)}` : '—'} />
      </div>
    </div>
  );
}

function StatTile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'win' | 'loss' | 'neutral' }) {
  const color = tone === 'win' ? 'text-aurora-400' : tone === 'loss' ? 'text-nebula-400' : 'text-slate-100';
  return (
    <div className="bg-space-800/50 border border-space-500/30 rounded-control px-2.5 py-1.5 leading-tight">
      <div className="text-[9px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`font-mono font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
