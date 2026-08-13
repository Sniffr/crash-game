import { useCallback, useEffect, useRef, useState } from 'react';
import GameCanvas from './components/GameCanvas';
import BetPanel from './components/BetPanel';
import PlayerList from './components/PlayerList';
import HistoryStrip from './components/HistoryStrip';
import ProvablyFairDrawer from './components/ProvablyFairDrawer';
import {
  AppBar, Button, Eyebrow, Readout, RocketGlyph, ShieldIcon, SpeakerIcon, Spinner,
} from './components/ui';
import {
  applyThemeSounds, cashoutChime, crashBoom, isMuted, placeBet as sndPlaceBet,
  setMuted, startMusic, takeoffWhoosh, uiTick,
} from './sounds';
import { applyThemeCssVars, fetchServerTheme, hasUserOverride, loadTheme, saveTheme } from './theme/loader';
import { type Theme } from './theme/types';
import { formatBalance, formatCredits, fromMinor, toMinor } from './lib/money';

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
  operatorId?: string;
  currency?: string;
  amountMinor?: number;
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

/**
 * Mirrors @crash/shared SessionStats. `currency` discriminates the units of the
 * monetary fields: present ⇒ integer minor units of that currency (money
 * sessions), absent ⇒ decimal credits (legacy demo). `biggestCashout` is a
 * multiplier and is unitless either way.
 */
interface SessionStats {
  bets: number; wins: number; losses: number;
  totalWagered: number; totalWon: number; netProfit: number;
  biggestCashout: number; biggestWin: number;
  currentStreak: number; bestStreak: number;
  currency?: string;
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
const DEFAULT_GAME_ID = 'galaxy-crash';

/** The game this tab is playing, from ?game= (defaults to the base game). */
function readGameIdFromUrl(): string {
  try {
    return new URLSearchParams(location.search).get('game')?.trim() || DEFAULT_GAME_ID;
  } catch { return DEFAULT_GAME_ID; }
}

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
      // Bind the demo session to the game this tab is playing, so bets are gated
      // against THIS game's round (not the default game's).
      body: JSON.stringify({ gameId: readGameIdFromUrl() }),
    });
    if (res.status === 503) return null; // backend offline
    if (!res.ok) return null;
    const j = await res.json() as { sessionId: string; displayName: string };
    return { sessionId: j.sessionId, displayName: j.displayName };
  } catch { return null; }
}

// real-money lobby session (server endpoint may not exist yet — fall back to demo)
// When the lobby launches a game with ?mode=real and the player is logged in,
// bind the game to a player session via Agent-B's endpoint. If it's missing
// (404) or errors, we return null and the caller uses the anonymous demo flow.
async function createRealSession(): Promise<SessionInfo | null> {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('mode') !== 'real') return null;
    const token = localStorage.getItem('casino_player_token');
    if (!token) return null;
    const res = await fetch('/api/lobby/play/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ gameId: readGameIdFromUrl() }),
    });
    if (!res.ok) return null; // endpoint not built yet / rejected → fall back to demo
    const j = await res.json() as { sessionId?: string };
    if (!j?.sessionId) return null;
    return { sessionId: j.sessionId, displayName: '' };
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
  // Second bet section (OdiBets-style dual bet). Its own stake + auto-cashout.
  const [bet2Amount, setBet2Amount] = useState(10);
  const [auto2Enabled, setAuto2Enabled] = useState(false);
  const [auto2, setAuto2] = useState(2.0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [lobbyUrl, setLobbyUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats>(ZERO_STATS);
  // Per-slot active-bet flags for the dual-bet UI ([slot0, slot1]).
  const [hasBet, setHasBet] = useState<[boolean, boolean]>([false, false]);
  const setSlotBet = useCallback((slot: number, val: boolean) => {
    setHasBet((prev) => {
      const next = [prev[0], prev[1]] as [boolean, boolean];
      next[slot === 1 ? 1 : 0] = val;
      return next;
    });
  }, []);
  // Auto Bet (auto-rebet) per slot.
  const [autoBet1, setAutoBet1] = useState(false);
  const [autoBet2, setAutoBet2] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: 'win' | 'loss' | 'info'; text: string } | null>(null);
  const [, setConnected] = useState(false);
  const [soundOn, setSoundOn] = useState(!isMuted());
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  // For a launched catalogue game, hold rendering until THIS game's theme loads,
  // so we never flash the default galaxy theme/gifs before the real one arrives.
  const [themeReady, setThemeReady] = useState(() => !new URLSearchParams(location.search).has('game'));
  const wsRef = useRef<WebSocket | null>(null);
  const serverOffsetRef = useRef(0);

  const flashToast = useCallback((kind: 'win' | 'loss' | 'info', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  // Is this a launched catalogue game (lobby → /play?game=<id>)? If so the
  // server theme for THAT game is authoritative — localStorage must not win, or
  // switching games would keep showing a previously-cached theme.
  const isLaunchedGame = new URLSearchParams(location.search).has('game');

  // Apply theme tokens (CSS vars + sounds) whenever the theme changes
  useEffect(() => {
    applyThemeCssVars(theme);
    applyThemeSounds(theme.sounds);
    // Persist only for the standalone single-game dev flow. For a launched
    // catalogue game we never persist — each game's theme comes fresh from the
    // server, so localStorage can't leak one game's assets into another.
    if (!THEME_LOCKED && !isLaunchedGame) saveTheme(theme);
    document.title = theme.brandName || 'Galaxy Crash';
  }, [theme, isLaunchedGame]);

  // On boot, fetch the theme from /api/theme (per-game via ?game=).
  // For a launched catalogue game the server theme always wins; only the
  // standalone single-game flow honours a manual localStorage override.
  useEffect(() => {
    if (!isLaunchedGame && hasUserOverride()) return; // manual override wins in the standalone flow only
    const fallback = setTimeout(() => setThemeReady(true), 4000); // never stick on the loader
    fetchServerTheme()
      .then((t) => { if (t) setTheme(t); })
      .finally(() => { clearTimeout(fallback); setThemeReady(true); });
    return () => clearTimeout(fallback);
  }, [isLaunchedGame]);

  // On boot, seed the history strip with THIS game's series (multi-game).
  useEffect(() => {
    fetch(`/api/history?game=${encodeURIComponent(readGameIdFromUrl())}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((h: { roundNumber: number; crashPoint: number }[]) => {
        if (Array.isArray(h) && h.length) {
          setGameState((prev) => (prev.history.length ? prev : { ...prev, history: h }));
        }
      })
      .catch(() => { /* strip just starts empty */ });
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
        // real-money lobby session (server endpoint may not exist yet — fall back to demo)
        const fresh = (await createRealSession()) ?? (await createNewSession());
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

  useEffect(() => {
    // Don't open the WebSocket until we have a session id to attach to
    if (!session) return;
    let alive = true;
    let reconnectTimer: number | undefined;

    const connect = () => {
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${wsProto}://${location.host}/ws?game=${encodeURIComponent(readGameIdFromUrl())}`);
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
    // Per-game engines broadcast every game's frames to every socket. Ignore any
    // game-scoped frame that isn't ours — our tab only ever plays readGameIdFromUrl().
    const GAME_SCOPED = new Set(['join', 'phase_change', 'countdown_update', 'multiplier_update', 'new_bet', 'crash', 'cashout']);
    if (GAME_SCOPED.has(message.type) && (message.data?.gameId ?? DEFAULT_GAME_ID) !== readGameIdFromUrl()) {
      return;
    }

    if (message.data?.serverTime) {
      serverOffsetRef.current = message.data.serverTime - Date.now();
    }

    switch (message.type) {
      case 'join': {
        // The join snapshot is our own game's live round (server routes it by the
        // ?game= on the WS URL), so its history/state apply directly.
        setGameState((prev) => ({
          ...prev,
          ...message.data,
          history: message.data.history ?? prev.history,
          flightStartTime: message.data.phase === 'FLYING' ? message.data.startTime : null,
        }));
        setHasBet([false, false]);
        break;
      }

      case 'phase_change':
        if (message.data.phase === 'FLYING') takeoffWhoosh();
        setGameState((prev) => ({
          ...prev,
          phase: message.data.phase,
          roundNumber: message.data.roundNumber ?? prev.roundNumber,
          hashCommit: message.data.hashCommit ?? prev.hashCommit,
          countdownMs: message.data.countdownMs,
          // Our own game's history (RESULT-phase frames carry it; guard drops siblings).
          history: message.data.history ?? prev.history,
          bets: message.data.bets ?? (message.data.phase === 'BETTING' ? [] : prev.bets),
          currentMultiplier: message.data.phase === 'FLYING' ? 1.0 : prev.currentMultiplier,
          crashPoint: message.data.phase === 'BETTING' ? undefined : (message.data.crashPoint ?? prev.crashPoint),
          flightStartTime: message.data.phase === 'FLYING' ? message.data.startTime : null,
          serverSeed: message.data.phase === 'RESULT' ? message.data.serverSeed : prev.serverSeed,
          prevServerSeed: message.data.prevServerSeed ?? prev.prevServerSeed,
          prevRoundNumber: message.data.prevRoundNumber ?? prev.prevRoundNumber,
        }));
        if (message.data.phase === 'BETTING') setHasBet([false, false]);
        break;

      case 'countdown_update':
        setGameState((prev) => ({ ...prev, countdownMs: message.data.countdownMs }));
        break;

      case 'multiplier_update':
        // Ignore a stray tick that races in after our own crash frame.
        setGameState((prev) => (prev.phase === 'CRASHED' ? prev : { ...prev, currentMultiplier: message.data.multiplier }));
        break;

      case 'crash': {
        crashBoom();
        setGameState((prev) => {
          // Append this round to our game's history strip (dedup by roundNumber).
          const rn = message.data.roundNumber;
          const already = prev.history.some((h) => h.roundNumber === rn);
          const history = already
            ? prev.history
            : [...prev.history, { roundNumber: rn, crashPoint: message.data.crashPoint }].slice(-200);
          return {
            ...prev,
            phase: 'CRASHED',
            crashPoint: message.data.crashPoint,
            currentMultiplier: message.data.crashPoint,
            serverSeed: message.data.serverSeed ?? prev.serverSeed,
            bets: message.data.bets ?? prev.bets,
            history,
          };
        });
        setHasBet((prev) => {
          if (prev[0] || prev[1]) flashToast('loss', `Crashed @ ${message.data.crashPoint.toFixed(2)}x`);
          return [false, false];
        });
        break;
      }

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
        setSlotBet(message.data.bet?.slot ?? 0, true);
        if (message.data.stats) setStats(message.data.stats);
        if (message.data.isOperator === true) {
          // Operator frame: bet.amount is integer minor units; currency is top-level.
          flashToast('info', `Bet placed · ${fromMinor(message.data.bet.amount, message.data.currency)}`);
        } else {
          flashToast('info', `Bet placed · ${formatCredits(message.data.bet.amount)}`);
        }
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
        setSlotBet(message.data.slot ?? 0, false);
        if (message.data.stats) setStats(message.data.stats);
        if (message.data.winAmountMinor != null) {
          // Operator frame: no `profit` field; use winAmountMinor + currency.
          flashToast('win', `${message.data.source === 'auto' ? 'Auto cash out' : 'Cashed out'} @ ${message.data.multiplier.toFixed(2)}x  +${fromMinor(message.data.winAmountMinor, message.data.currency)}`);
        } else {
          flashToast('win', `${message.data.source === 'auto' ? 'Auto cash out' : 'Cashed out'} @ ${message.data.multiplier.toFixed(2)}x  +${formatCredits(message.data.profit)}`);
        }
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
          const isOperatorBet = !!message.data.isOperator;
          return {
            ...prev,
            bets: [
              ...prev.bets,
              {
                playerId: message.data.playerId,
                // For operator bets, amount is absent — fall back to amountMinor so
                // no consumer ever sees undefined/NaN; PlayerList formats via amountMinor.
                amount: message.data.amount ?? message.data.amountMinor,
                autoCashout: message.data.autoCashout,
                cashedOut: false,
                isBot: !!message.data.isBot,
                botName: message.data.botName,
                displayName: message.data.displayName,
                ...(isOperatorBet ? {
                  operatorId: message.data.operatorId,
                  currency: message.data.currency,
                  amountMinor: message.data.amountMinor,
                } : {}),
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

      case 'cashout_pending':
        // No balanceMinor in this frame by design: the /win call failed or the
        // operator was unavailable, so no credit has happened yet. Keep showing
        // the last-known post-debit balance. Task 4.2 force-credit will eventually
        // resolve and can push a fresh balance.
        flashToast('info', message.data?.message ?? 'Win pending — will be credited automatically');
        break;

      case 'error':
        flashToast('loss', message.data?.message ?? 'Error');
        break;
    }
  }, [flashToast]);

  // Place a bet for a given slot with an explicit stake + auto-cashout.
  const placeBetWith = (amount: number, autoEnabled: boolean, autoVal: number, slot: 0 | 1 = 0) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
    const autoTarget = autoEnabled ? autoVal : undefined;
    // A money session (operator OR personal-lobby real-money) carries balanceMinor
    // + currency and settles in integer minor units. Only the legacy anonymous
    // demo session uses decimal credits.
    if (typeof session.balanceMinor === 'number' && session.currency) {
      const amountMinor = toMinor(amount, session.currency);
      ws.send(JSON.stringify({
        type: 'place_bet',
        data: { sessionId: session.sessionId, amountMinor, autoCashout: autoTarget, slot },
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'place_bet',
        data: { sessionId: session.sessionId, amount, autoCashout: autoTarget, slot },
      }));
    }
  };
  const placeBet = () => placeBetWith(betAmount, autoCashoutEnabled, autoCashout, 0);
  const cashout = (slot: 0 | 1 = 0) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
    ws.send(JSON.stringify({ type: 'cashout', data: { sessionId: session.sessionId, slot } }));
  };

  // Auto Bet: at the start of each betting window, re-place any enabled slot.
  const prevPhaseRef = useRef(gameState.phase);
  useEffect(() => {
    const phase = gameState.phase;
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase !== 'BETTING' || prev === 'BETTING' || !session) return;
    if (autoBet1 && !hasBet[0]) placeBetWith(betAmount, autoCashoutEnabled, autoCashout, 0);
    if (autoBet2 && !hasBet[1]) placeBetWith(bet2Amount, auto2Enabled, auto2, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.phase]);
  const resetBalance = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
    ws.send(JSON.stringify({ type: 'reset_balance', data: { sessionId: session.sessionId } }));
  };

  // One discriminator for money-vs-demo, matching formatBalance's rule.
  const isMoneySession = typeof session?.balanceMinor === 'number' && !!session?.currency;

  const getChipClass = (cp: number) => (cp < 2 ? 'pink' : cp < 10 ? 'purple' : 'gold');

  // Tier color from active theme — drives canvas curve, multiplier readout, history
  // Signature: the climbing multiplier heats up — cool white → orange → gold →
  // white-hot — so the number itself telegraphs the tension. Fixed (not themed)
  // so it stays consistent across games, on the iMoon warm palette.
  const getMultiplierColor = useCallback((m: number) => {
    // Hex (not hsl): this feeds the <canvas>, which concatenates a 2-char hex
    // alpha onto it (e.g. color + '40'), so it must be #rrggbb.
    if (m < 2) return '#d9d9d9';   // cool grey
    if (m < 10) return '#fb6514';  // orange — heating up
    if (m < 50) return '#f5a623';  // gold
    return '#fafafa';              // white-hot
  }, []);

  // Launched game: show a neutral loader until its theme is ready (no default flash).
  if (isLaunchedGame && !themeReady) {
    return (
      <div className="grid min-h-screen place-items-center bg-space-950">
        <div className="flex flex-col items-center gap-3 text-neutral-500">
          <Spinner className="h-7 w-7 text-brand-500" />
          <span className="text-[13px] font-medium">Loading the table…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-space-950 text-neutral-100">
      <Header
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
        theme={theme}
        session={session}
        lobbyUrl={lobbyUrl}
      />

      {sessionError && (
        <div role="alert" className="border-b border-loss-500/40 bg-loss-500/15 px-4 py-2 text-center text-[12px] text-loss-400">
          {sessionError}
        </div>
      )}

      <main className="mx-auto w-full max-w-[1500px] p-3 lg:p-4">
        <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-4">
          {/* Live Bets — desktop sidebar */}
          <aside className="hidden min-h-0 flex-col gap-3 lg:flex">
            <PlayerList bets={gameState.bets} youPlayerId={session?.sessionId} />
            <StatsPanel
              stats={stats}
              displayName={session?.displayName}
              onResetBalance={resetBalance}
              canReset={!isMoneySession}
              isMoneySession={isMoneySession}
              sessionCurrency={session?.currency}
            />
          </aside>

          {/* Right column: history · canvas · dual bet */}
          <div className="flex min-w-0 flex-col gap-3">
            <HistoryStrip history={gameState.history} getChipClass={getChipClass} />

            {/* 16:9 to match the 1280×720 game scene so nothing is cropped
                (gif clips are 16:9 too). max-h keeps it from dominating short
                viewports; the renderer contain-fits, so any residual gap just
                shows the stage backdrop rather than clipping the road/wheels. */}
            <section className="relative aspect-[16/9] max-h-[70vh] w-full overflow-hidden rounded-card border border-edge bg-space-950">
              {/* CSS galaxy (starfield + supernova + planet Earth), behind the canvas */}
              <div className="game-bg absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
                <div className="sn-earth-glow" />
                <div className="sn-earth" />
                <div className="sn-supernova" />
              </div>
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

              {/* Chrome over the canvas stays at the lowest possible contrast —
                  the multiplier is the focal point and nothing should compete. */}
              <div className="absolute left-3 top-3 rounded-chip border border-white/10 bg-black/50 px-2 py-1 text-[11px] tabular-nums text-neutral-400 backdrop-blur-md">
                Round {gameState.roundNumber}
              </div>

              {toast && (
                <div
                  role="status"
                  className={`animate-toast-in absolute left-1/2 top-3 -translate-x-1/2 rounded-btn border px-3.5 py-2 text-[13px] font-semibold backdrop-blur-md ${
                    toast.kind === 'win'
                      ? 'border-bet-500/40 bg-bet-500/15 text-bet-400'
                      : toast.kind === 'loss'
                      ? 'border-loss-500/40 bg-loss-500/15 text-loss-400'
                      : 'border-brand-500/40 bg-brand-500/15 text-brand-400'
                  }`}
                >
                  {toast.text}
                </div>
              )}
            </section>

            {/* Dual bet sections — side-by-side on desktop, stacked on mobile */}
            <div className="grid gap-3 sm:grid-cols-2">
              <BetPanel
                phase={gameState.phase} hasBet={hasBet[0]} balance={balance}
                betAmount={betAmount} setBetAmount={setBetAmount}
                autoCashoutEnabled={autoCashoutEnabled} setAutoCashoutEnabled={setAutoCashoutEnabled}
                autoCashout={autoCashout} setAutoCashout={setAutoCashout}
                autoBetEnabled={autoBet1} setAutoBetEnabled={setAutoBet1}
                currentMultiplier={gameState.currentMultiplier}
                betAmounts={[10, 100, 1000, 10000]}
                onPlaceBet={placeBet} onCashout={() => cashout(0)}
                maxBetMinor={session?.rgLimits?.maxBetMinor}
                currency={session?.currency}
                isOperator={isMoneySession}
              />
              <BetPanel
                phase={gameState.phase} hasBet={hasBet[1]} balance={balance}
                betAmount={bet2Amount} setBetAmount={setBet2Amount}
                autoCashoutEnabled={auto2Enabled} setAutoCashoutEnabled={setAuto2Enabled}
                autoCashout={auto2} setAutoCashout={setAuto2}
                autoBetEnabled={autoBet2} setAutoBetEnabled={setAutoBet2}
                currentMultiplier={gameState.currentMultiplier}
                betAmounts={[10, 100, 1000, 10000]}
                onPlaceBet={() => placeBetWith(bet2Amount, auto2Enabled, auto2, 1)} onCashout={() => cashout(1)}
                maxBetMinor={session?.rgLimits?.maxBetMinor}
                currency={session?.currency}
                isOperator={isMoneySession}
              />
            </div>

            {/* Live Bets + stats on mobile (sidebar is desktop-only) */}
            <div className="flex flex-col gap-3 lg:hidden">
              <StatsPanel
              stats={stats}
              displayName={session?.displayName}
              onResetBalance={resetBalance}
              canReset={!isMoneySession}
              isMoneySession={isMoneySession}
              sessionCurrency={session?.currency}
            />
              <PlayerList bets={gameState.bets} youPlayerId={session?.sessionId} />
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-edge-soft">
        <div className="mx-auto max-w-[1500px] px-4 py-4 text-[11px] text-neutral-600">
          {theme.brandName || 'Galaxy Crash'} · simulation only · no real wagers, no real money.
        </div>
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
  soundOn, onToggleSound, onOpenDrawer, balance,
  theme, session, lobbyUrl,
}: {
  soundOn: boolean;
  onToggleSound: () => void;
  onOpenDrawer: () => void;
  balance: number;
  theme: Theme;
  session?: SessionInfo | null;
  lobbyUrl?: string | null;
}) {
  const brand = theme.brandName || 'Galaxy Crash';
  const tagline = theme.brandTagline || 'provably-fair multiplier';
  const customLogo = theme.assets?.logo;

  return (
    <AppBar
      left={
        <>
          {customLogo ? (
            <img
              src={customLogo}
              alt=""
              className="h-7 w-7 shrink-0 rounded-btn border border-edge object-contain"
            />
          ) : (
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-btn bg-brand-500">
              <RocketGlyph className="h-4 w-4 text-black" />
            </span>
          )}
          {/* The game's own name, at its own weight — the old header split it in
              two colours and tracked it out to 0.18em, which made every table
              read as a logo rather than a title. */}
          <h1 className="truncate text-[15px] font-bold tracking-tight text-neutral-100">{brand}</h1>
          <span className="hidden h-4 w-px shrink-0 bg-white/10 sm:block" aria-hidden />
          <span className="hidden truncate text-[11px] font-medium text-neutral-500 sm:block">{tagline}</span>
        </>
      }
      right={
        <>
          <Button
            variant="quiet"
            size="sm"
            onClick={onToggleSound}
            aria-label={soundOn ? 'Mute sounds' : 'Unmute sounds'}
            title={soundOn ? 'Mute sounds' : 'Unmute sounds'}
            className="px-2.5"
          >
            <SpeakerIcon className="h-4 w-4" muted={!soundOn} />
          </Button>
          <Button variant="quiet" size="sm" onClick={onOpenDrawer} title="Provably fair" className="px-2.5">
            <ShieldIcon className="h-4 w-4" />
            <span className="hidden md:inline">Fair</span>
          </Button>

          {lobbyUrl && (
            <Button
              variant="secondary"
              size="sm"
              title="Return to lobby"
              onClick={() => {
                window.parent.postMessage({ type: 'lobby' }, '*');
                setTimeout(() => {
                  if (lobbyUrl && window.top) window.top.location.href = lobbyUrl;
                }, 50);
              }}
            >
              Lobby
            </Button>
          )}

          <Readout label="Balance" value={formatBalance(balance, session ?? null)} />
        </>
      }
    />
  );
}


// ─── Session stats sidebar panel ─────────────────────────────────────────────
/**
 * Eight equally-weighted tiles said nothing — the number a player actually
 * tracks is whether they're up or down, so net P/L leads at 20px and the rest
 * drop to a quiet two-column grid beneath it.
 */
function StatsPanel({
  stats, displayName, onResetBalance, canReset, isMoneySession, sessionCurrency,
}: {
  stats: SessionStats;
  displayName?: string;
  onResetBalance: () => void;
  /** Demo sessions only — a money-backed balance is never resettable. */
  canReset: boolean;
  /** Operator- or lobby-backed real-money session. */
  isMoneySession: boolean;
  sessionCurrency?: string;
}) {
  const net = stats.netProfit;
  const streakLabel = stats.currentStreak > 0
    ? `${stats.currentStreak}W`
    : stats.currentStreak < 0
    ? `${Math.abs(stats.currentStreak)}L`
    : '—';

  // The server stamps `currency` on the stats record the first time a money
  // session records anything; before that first bet every figure is 0, so
  // falling back to the session currency just picks the right symbol for the
  // zeros. A demo session has neither and stays on decimal credits.
  const unitCurrency = stats.currency ?? (isMoneySession ? sessionCurrency : undefined);
  const money = (v: number) => (unitCurrency ? fromMinor(v, unitCurrency) : formatCredits(v));

  const header = (
    <div className="flex items-baseline justify-between gap-2 border-b border-edge-soft px-3 py-2.5">
      <h2 className="text-[13px] font-semibold text-neutral-100">This session</h2>
      {displayName && (
        <span className="truncate text-[11px] text-neutral-600" title={displayName}>{displayName}</span>
      )}
    </div>
  );

  return (
    <div className="rounded-card border border-edge bg-space-850">
      {header}

      <div className="border-b border-edge-soft px-3 py-3">
        <Eyebrow>Net profit / loss</Eyebrow>
        <div
          className={`mt-1 text-[20px] font-bold leading-none tabular-nums ${
            net > 0 ? 'text-bet-400' : net < 0 ? 'text-loss-400' : 'text-neutral-300'
          }`}
        >
          {net > 0 ? '+' : net < 0 ? '−' : ''}{money(Math.abs(net))}
        </div>
        <div className="mt-1.5 text-[11px] tabular-nums text-neutral-600">
          {stats.bets} {stats.bets === 1 ? 'bet' : 'bets'} · {stats.wins}W / {stats.losses}L
          {stats.currentStreak !== 0 && ` · ${streakLabel} streak`}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 px-3 py-3">
        <StatTile label="Wagered" value={money(stats.totalWagered)} />
        <StatTile label="Returned" value={money(stats.totalWon)} />
        <StatTile label="Best multiplier" value={stats.biggestCashout > 0 ? `${stats.biggestCashout.toFixed(2)}×` : '—'} />
        <StatTile label="Best win" value={stats.biggestWin > 0 ? money(stats.biggestWin) : '—'} />
      </div>

      {/* Resetting the demo balance lives with the session it belongs to, not in
          the top bar — in the bar it crowded the game's name down to "Gal…" on
          a 390px screen. */}
      {canReset && (
        <div className="border-t border-edge-soft px-3 py-2.5">
          <Button variant="quiet" size="sm" onClick={onResetBalance} className="w-full">
            Reset demo balance
          </Button>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.1em] text-neutral-600">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-neutral-200">{value}</div>
    </div>
  );
}
