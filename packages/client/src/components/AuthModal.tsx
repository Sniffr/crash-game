import { useEffect, useRef, useState } from 'react';

export interface AuthSuccess {
  token: string;
  username: string;
  balanceMinor: number;
}

/** Shape returned by /api/lobby/{login,register}. */
interface AuthResponse {
  token: string;
  player: { playerId: string; username: string };
  balanceMinor: number;
}

/**
 * Self-contained login / register modal for the casino lobby.
 * Toggles between the two modes and calls Agent-B's player-auth API.
 * All fetch/HTTP failures are surfaced inline — the modal never throws.
 */
export default function AuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (result: AuthSuccess) => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const u = username.trim();
    if (!u || !password) {
      setError('Enter a username and password');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/lobby/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password }),
      });

      if (res.status === 401) {
        setError('Invalid username or password');
        return;
      }
      if (res.status === 409) {
        setError('That username is already taken');
        return;
      }
      if (!res.ok) {
        setError('Something went wrong — please try again');
        return;
      }

      const j = (await res.json()) as AuthResponse;
      onSuccess({
        token: j.token,
        username: j.player?.username ?? u,
        balanceMinor: j.balanceMinor ?? 0,
      });
    } catch {
      setError('Could not reach the server — is it running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-space-950/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-panel border border-space-500/50 bg-space-900/90 shadow-panel p-6 animate-toast-in">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display font-bold text-lg tracking-[0.14em] uppercase text-slate-100">
            {mode === 'login' ? 'Log in' : 'Create account'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-500 hover:text-slate-200 transition text-xl leading-none px-1"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Username</span>
            <input
              ref={firstFieldRef}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="bg-space-800/70 border border-space-500/50 rounded-control px-3 py-2 text-sm text-slate-100 outline-none focus:border-plasma-500 focus:shadow-plasma transition"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="bg-space-800/70 border border-space-500/50 rounded-control px-3 py-2 text-sm text-slate-100 outline-none focus:border-plasma-500 focus:shadow-plasma transition"
            />
          </label>

          {error && (
            <div className="text-xs text-nebula-400 bg-nebula-500/10 border border-nebula-500/30 rounded-control px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-control px-4 py-2.5 text-sm font-semibold uppercase tracking-wider bg-plasma-500 text-space-950 hover:brightness-110 transition disabled:opacity-60 disabled:cursor-not-allowed shadow-plasma"
          >
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        <div className="mt-4 text-center text-xs text-slate-500">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => {
              setError(null);
              setMode(mode === 'login' ? 'register' : 'login');
            }}
            className="text-plasma-400 hover:text-plasma-500 font-semibold transition"
          >
            {mode === 'login' ? 'Register' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  );
}
