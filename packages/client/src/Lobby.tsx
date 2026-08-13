import { useCallback, useEffect, useMemo, useState } from 'react';
import AuthModal, { type AuthSuccess } from './components/AuthModal';
import CrashRail, { tierColor, tierTextColor } from './components/CrashRail';
import {
  AppBar, BallGlyph, Button, CheckIcon, Chip, Eyebrow, LogOutIcon, Modal, Panel,
  PlusIcon, Readout, RocketGlyph, Spinner, Stat, TextInput, Wordmark,
} from './components/ui';
import { useHistories, type GameFeed } from './lib/histories';
import { fromMinor, symbolFor, toMinor } from './lib/money';

/**
 * The lobby, built as an instrument rather than a poster wall.
 *
 * The player's question on arrival is "is anything worth playing right now?",
 * and this product can actually answer it — every game's real round history is
 * public at /api/history. So the page leads with one focal readout (the
 * featured table's last crash point) plus its rail of recent rounds, and
 * demotes everything else to a dense, scannable list. Colour is spent only
 * where it means something; there are no decorative gradients.
 */

const TOKEN_KEY = 'casino_player_token';
const USERNAME_KEY = 'casino_player_username';

interface Game {
  gameId: string;
  name: string;
  gameType: 'sprite' | 'gif' | string;
}

/** Fallback tile colours when a game's own theme can't be fetched. */
const FALLBACK_ACCENTS = [
  '#fb6514', 'hsl(211 90% 45%)', 'hsl(138 61% 47%)',
  'hsl(37 91% 55%)', 'hsl(263 62% 58%)', 'hsl(187 71% 44%)',
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
  const [accents, setAccents] = useState<Record<string, string>>({});

  const [token, setToken] = useState<string | null>(() => readToken());
  const [username, setUsername] = useState<string | null>(() => readUsername());
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string>('KES');

  const [authOpen, setAuthOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  // Where to go once auth succeeds (a "real" launch attempted while logged out).
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

  // ─── Per-game accent, from each game's own published theme ──────────────────
  useEffect(() => {
    if (!games) return;
    let cancelled = false;
    games.forEach((g) => {
      fetch(`/api/theme?game=${encodeURIComponent(g.gameId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((theme: { colors?: { accent?: string } } | null) => {
          if (cancelled || !theme?.colors?.accent) return;
          setAccents((prev) => ({ ...prev, [g.gameId]: theme.colors!.accent! }));
        })
        .catch(() => { /* fall back to a stock colour */ });
    });
    return () => { cancelled = true; };
  }, [games]);

  // ─── Live round history, the thing the whole page is built around ───────────
  const gameIds = useMemo(() => (games ?? []).map((g) => g.gameId), [games]);
  const feeds = useHistories(gameIds);

  // ─── Balance (only when logged in) ──────────────────────────────────────────
  const refreshBalance = useCallback(async (tok: string) => {
    try {
      const res = await fetch('/api/lobby/me', { headers: { Authorization: `Bearer ${tok}` } });
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

  const featured = games?.[0] ?? null;
  const rest = games ? games.slice(1) : [];

  return (
    <div className="min-h-screen bg-space-950 text-neutral-100">
      <AppBar
        left={<Wordmark caption="Provably-fair crash games" />}
        right={
          token ? (
            <>
              <Readout label={username ?? 'Player'} value={balanceMinor == null ? '—' : fromMinor(balanceMinor, currency)} />
              <Button variant="secondary" onClick={() => setDepositOpen(true)} title="Top up your wallet">
                <PlusIcon className="h-4 w-4" />
                <span className="hidden sm:inline">Deposit</span>
              </Button>
              {/* Text where there's room, glyph where there isn't — a 320px
                  viewport can't hold wordmark + balance + deposit + "Log out". */}
              <Button variant="ghost" size="sm" onClick={logout} className="hidden sm:inline-flex">Log out</Button>
              <Button variant="ghost" size="sm" onClick={logout} aria-label="Log out" className="px-2 sm:hidden">
                <LogOutIcon className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => { setPendingGameId(null); setAuthOpen(true); }}>
              Log in
            </Button>
          )
        }
      />

      <main className="mx-auto max-w-[1080px] px-4 pb-16 pt-6 sm:px-6 sm:pt-8">
        {loadError && (
          <div className="mb-6 rounded-card border border-loss-500/30 bg-loss-500/10 px-4 py-3 text-[13px] text-loss-400">
            {loadError}
          </div>
        )}

        {games == null ? (
          <FeaturedSkeleton />
        ) : featured ? (
          <Featured
            game={featured}
            feed={feeds[featured.gameId]}
            accent={accents[featured.gameId] ?? FALLBACK_ACCENTS[0]!}
            onReal={() => playReal(featured.gameId)}
            onDemo={() => playDemo(featured.gameId)}
          />
        ) : (
          <Panel className="px-6 py-14 text-center">
            <h2 className="text-[15px] font-semibold text-neutral-200">No crash games are published yet</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-neutral-500">
              Publish one from the Creator and it will appear here. Simulate is playable in the meantime.
            </p>
          </Panel>
        )}

        {/* ─── The rest of the floor ─────────────────────────────────────── */}
        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between gap-3 px-0.5">
            <Eyebrow>More games</Eyebrow>
            <span className="text-[11px] tabular-nums text-neutral-600">
              {games == null ? '' : `${rest.length + 1} available`}
            </span>
          </div>

          <Panel className="overflow-hidden">
            <ul className="divide-y divide-white/[0.05]">
              {games == null
                ? Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={`sk-${i}`} />)
                : rest.map((g, i) => (
                    <GameRow
                      key={g.gameId}
                      game={g}
                      feed={feeds[g.gameId]}
                      accent={accents[g.gameId] ?? FALLBACK_ACCENTS[(i + 1) % FALLBACK_ACCENTS.length]!}
                      onReal={() => playReal(g.gameId)}
                      onDemo={() => playDemo(g.gameId)}
                    />
                  ))}
              <SimulateRow onPlay={() => { window.location.href = '/simulate'; }} />
            </ul>
          </Panel>
        </section>

        {/* Three facts, stated once, quietly — not six badges shouting. */}
        <ul className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            ['Provably fair', 'Every crash point is derived from a seed you can verify yourself.'],
            ['Instant cash-out', 'Take the multiplier the moment you want it — settlement is immediate.'],
            ['Demo needs no account', 'Play any table for free first. Real stakes only when you say so.'],
          ].map(([title, body]) => (
            <li key={title} className="rounded-card border border-edge-soft px-4 py-3.5">
              <div className="flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 shrink-0 text-bet-400" />
                <span className="text-[13px] font-semibold text-neutral-200">{title}</span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-500">{body}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-edge-soft">
        <div className="mx-auto max-w-[1080px] px-4 py-5 text-[11px] text-neutral-600 sm:px-6">
          Game Hub · real odds, provably fair · let's roll, win big.
        </div>
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

// ─── Featured table ──────────────────────────────────────────────────────────
// The one focal point on the page. It wins on size (a 44px figure against a
// page of 11–15px text), on colour (the only tier-coloured number here), and on
// the space around it — not by being wrapped in decoration.

function Featured({
  game, feed, accent, onReal, onDemo,
}: {
  game: Game; feed: GameFeed | undefined; accent: string; onReal: () => void; onDemo: () => void;
}) {
  const entries = feed?.entries ?? [];
  const last = entries.length > 0 ? entries[entries.length - 1]! : null;
  const window20 = entries.slice(-20);
  const avg = window20.length > 0
    ? window20.reduce((a, e) => a + e.crashPoint, 0) / window20.length
    : null;
  const best = entries.length > 0 ? Math.max(...entries.map((e) => e.crashPoint)) : null;

  return (
    <Panel className="animate-rise p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-chip" style={{ backgroundColor: accent }}>
          <RocketGlyph className="h-3.5 w-3.5 text-black" />
        </span>
        <h1 className="text-[15px] font-semibold tracking-tight text-neutral-100">{game.name}</h1>
        {feed?.live ? <Chip tone="up"><span className="mr-0.5 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-bet-400" />Live</Chip> : null}
        <Chip className="ml-auto">Provably fair</Chip>
      </div>

      {/* The figure sizes to its content and the rail takes every remaining
          pixel — a fixed-width rail parked at the far edge leaves a dead gap
          that reads as an unfinished layout, not as breathing room. */}
      <div className="mt-6 grid items-end gap-x-8 gap-y-5 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="min-w-0">
          <Eyebrow>Last crash</Eyebrow>
          <div
            className="mt-1 text-[40px] font-bold leading-none tracking-[-0.03em] tabular-nums sm:text-[52px]"
            style={{ color: last ? tierTextColor(last.crashPoint) : undefined }}
          >
            {last ? (
              <>{last.crashPoint.toFixed(2)}<span className="ml-0.5 text-[0.5em] font-semibold opacity-60">×</span></>
            ) : (
              <span className="text-neutral-700">—</span>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <Eyebrow>Recent rounds</Eyebrow>
            <span className="text-[11px] text-neutral-600">
              {entries.length > 0 ? 'newest →' : 'no rounds yet'}
            </span>
          </div>
          <CrashRail history={entries} bars={44} height={52} stretch />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-btn bg-white/[0.06]">
        {[
          { label: 'Avg last 20', value: avg ? `${avg.toFixed(2)}×` : '—' },
          { label: 'Best on record', value: best ? `${best.toFixed(2)}×` : '—', tone: 'up' as const },
          { label: 'Rounds played', value: entries.length > 0 ? entries.length.toLocaleString() : '—' },
        ].map((s) => (
          <div key={s.label} className="bg-space-850 px-3.5 py-3">
            <Stat label={s.label} value={s.value} tone={entries.length > 0 ? (s.tone ?? 'default') : 'default'} />
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={onReal} className="flex-1 sm:flex-none">Play for real</Button>
        <Button variant="secondary" size="lg" onClick={onDemo} className="flex-1 sm:flex-none">Try the demo</Button>
        <span className="w-full text-[11px] text-neutral-600 sm:w-auto">Demo needs no account.</span>
      </div>
    </Panel>
  );
}

// ─── Game row ────────────────────────────────────────────────────────────────

function GameRow({
  game, feed, accent, onReal, onDemo,
}: {
  game: Game; feed: GameFeed | undefined; accent: string; onReal: () => void; onDemo: () => void;
}) {
  const entries = feed?.entries ?? [];
  const last = entries.length > 0 ? entries[entries.length - 1]! : null;

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 ease-snap hover:bg-white/[0.03] sm:gap-4 sm:px-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn" style={{ backgroundColor: accent }}>
        <RocketGlyph className="h-4 w-4 text-black" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-neutral-100">{game.name}</span>
          {feed?.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-bet-400" title="Rounds are running" />}
        </div>
        <div className="truncate text-[11px] text-neutral-500">Crash · {game.gameType}</div>
      </div>

      <CrashRail history={entries} bars={10} height={20} className="hidden md:flex" />

      <div className="hidden w-[62px] text-right sm:block">
        <div
          className="text-[13px] font-semibold tabular-nums"
          style={{ color: last ? tierColor(last.crashPoint) : undefined }}
        >
          {last ? `${last.crashPoint.toFixed(2)}×` : <span className="text-neutral-700">—</span>}
        </div>
        <div className="text-[10px] text-neutral-600">last</div>
      </div>

      <Button variant="quiet" size="sm" onClick={onDemo}>Demo</Button>
      <Button variant="primary" onClick={onReal}>Play</Button>
    </li>
  );
}

/** Simulate is a different engine (real odds, bet slip) — it says so plainly. */
function SimulateRow({ onPlay }: { onPlay: () => void }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 ease-snap hover:bg-white/[0.03] sm:gap-4 sm:px-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn bg-bet-500">
        <BallGlyph className="h-4 w-4 text-black" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-neutral-100">Simulate Bets</div>
        <div className="truncate text-[11px] text-neutral-500">Football · real harvested odds</div>
      </div>
      <Chip tone="up" className="hidden sm:inline-flex">Sports</Chip>
      <Button variant="primary" onClick={onPlay}>Play</Button>
    </li>
  );
}

// ─── Loading states ──────────────────────────────────────────────────────────

function FeaturedSkeleton() {
  return (
    <Panel className="p-5 sm:p-7">
      <div className="h-6 w-40 animate-pulse rounded bg-white/[0.06]" />
      <div className="mt-6 h-12 w-44 animate-pulse rounded bg-white/[0.06]" />
      <div className="mt-6 h-14 animate-pulse rounded-btn bg-white/[0.04]" />
      <div className="mt-6 flex gap-3">
        <div className="h-12 w-40 animate-pulse rounded-btn bg-white/[0.06]" />
        <div className="h-12 w-36 animate-pulse rounded-btn bg-white/[0.04]" />
      </div>
    </Panel>
  );
}

function RowSkeleton() {
  return (
    <li className="flex items-center gap-4 px-4 py-2.5">
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-btn bg-white/[0.06]" />
      <div className="flex-1">
        <div className="h-3 w-32 animate-pulse rounded bg-white/[0.06]" />
        <div className="mt-1.5 h-2.5 w-20 animate-pulse rounded bg-white/[0.04]" />
      </div>
      <div className="h-10 w-16 animate-pulse rounded-btn bg-white/[0.04]" />
    </li>
  );
}

// ─── Deposit modal ────────────────────────────────────────────────────────────
// Deposits are async: POST kicks off an M-PESA STK push, the player approves on
// their phone, and Maplerad's webhook credits the wallet moments later. So we
// show a "check your phone" pending state and poll /me until the balance rises.
type DepositPhase = 'form' | 'pending' | 'credited' | 'error';

const QUICK_AMOUNTS = [100, 500, 1000, 5000];

function DepositModal({
  token, currency, onClose, onCredited,
}: {
  token: string; currency: string; onClose: () => void; onCredited: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<DepositPhase>('form');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sym = symbolFor(currency).trim();

  const submit = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setMessage('Enter an amount greater than zero.'); return; }
    let amountMinor: number;
    try { amountMinor = toMinor(value, currency); } catch { setMessage('That amount is too large.'); return; }
    setMessage(null);
    setBusy(true);
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
    } finally {
      setBusy(false);
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

  if (phase === 'credited') {
    return (
      <Modal title="Deposit" onClose={onClose}>
        <div className="py-4 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-bet-500/15 text-bet-400">
            <CheckIcon className="h-5 w-5" />
          </span>
          <p className="mt-4 text-[15px] font-semibold text-neutral-100">Wallet topped up</p>
          <p className="mt-1 text-[13px] text-neutral-500">Your new balance is ready to play with.</p>
          <Button variant="primary" size="lg" onClick={onClose} className="mt-6 w-full">Done</Button>
        </div>
      </Modal>
    );
  }

  if (phase === 'pending') {
    return (
      <Modal title="Check your phone" onClose={onClose}>
        <div className="py-4 text-center">
          <Spinner className="mx-auto h-8 w-8 text-brand-500" />
          <p className="mt-4 text-[13px] text-neutral-200">{message}</p>
          <p className="mt-2 text-[12px] text-neutral-500">
            Waiting for confirmation — this window updates on its own.
          </p>
          <Button variant="secondary" size="lg" onClick={onClose} className="mt-6 w-full">Close</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Deposit"
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" size="lg" onClick={submit} disabled={busy} className="w-full">
            {busy ? <><Spinner /> Starting…</> : 'Continue'}
          </Button>
          <p className="mt-3 text-center text-[11px] text-neutral-600">
            You will approve the payment prompt on your phone.
          </p>
        </>
      }
    >
      <TextInput
        label={`Amount (${currency})`}
        prefix={sym}
        autoFocus
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="0.00"
        className="tabular-nums"
      />
      <div className="mt-3 grid grid-cols-4 gap-2">
        {QUICK_AMOUNTS.map((v) => (
          <Button key={v} size="sm" onClick={() => setAmount(String(v))} className="tabular-nums">
            {v.toLocaleString()}
          </Button>
        ))}
      </div>
      {message && <p className="mt-3 text-[12px] text-loss-400">{message}</p>}
    </Modal>
  );
}
