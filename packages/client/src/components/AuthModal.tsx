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

type ContactKind = 'phone' | 'email';

/**
 * Client-side mirror of the server's supported settlement currencies. The
 * server is the source of truth for which rails actually work — this list
 * only drives which contact field (phone vs email) the onboarding form asks
 * for, and is deliberately small and explicit.
 */
const CURRENCY_OPTIONS: { code: string; country: string; contact: ContactKind }[] = [
  { code: 'KES', country: 'Kenya', contact: 'phone' },
  { code: 'ZMW', country: 'Zambia', contact: 'phone' },
  { code: 'ZAR', country: 'South Africa', contact: 'email' },
  { code: 'NGN', country: 'Nigeria', contact: 'email' },
];

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <path d="M22 6l-10 7L2 6" />
    </svg>
  );
}

/**
 * Self-contained login / register modal for the casino lobby.
 * Login is a single username + password step. Register is a friendly
 * two-step flow: (1) username + password, (2) settlement currency + the
 * matching contact channel (phone for KES/ZMW, email for ZAR/NGN).
 * Calls Agent-B's player-auth API. All fetch/HTTP failures are surfaced
 * inline — the modal never throws.
 */
export default function AuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (result: AuthSuccess) => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [currency, setCurrency] = useState(CURRENCY_OPTIONS[0].code);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const contactFieldRef = useRef<HTMLInputElement>(null);

  const selected = CURRENCY_OPTIONS.find((c) => c.code === currency) ?? CURRENCY_OPTIONS[0];
  const contactType = selected.contact;

  useEffect(() => {
    if (mode === 'register' && step === 2) {
      contactFieldRef.current?.focus();
    } else {
      firstFieldRef.current?.focus();
    }
  }, [mode, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const switchMode = (next: 'login' | 'register') => {
    setError(null);
    setMode(next);
    setStep(1);
  };

  const canProceed =
    mode === 'login' || step === 1
      ? username.trim().length > 0 && password.length > 0
      : contactType === 'phone'
        ? phone.trim().length > 0
        : email.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const u = username.trim();

    if (mode === 'register' && step === 1) {
      if (!u || !password) {
        setError('Enter a username and password');
        return;
      }
      setStep(2);
      return;
    }

    if (!u || !password) {
      setError('Enter a username and password');
      return;
    }
    if (mode === 'register') {
      if (contactType === 'phone' && !phone.trim()) {
        setError('Enter a phone number');
        return;
      }
      if (contactType === 'email' && !email.trim()) {
        setError('Enter an email address');
        return;
      }
    }

    setBusy(true);
    try {
      const body =
        mode === 'login'
          ? { username: u, password }
          : contactType === 'phone'
            ? { username: u, password, currency, phone: phone.trim() }
            : { username: u, password, currency, email: email.trim() };

      const res = await fetch(`/api/lobby/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  const back = () => {
    setError(null);
    setStep(1);
  };

  const subtitle =
    mode === 'login'
      ? 'Welcome back — log in to keep playing.'
      : step === 1
        ? 'Pick a username and password to get started.'
        : 'Choose your currency and how we can reach you.';

  const submitLabel = busy
    ? 'Please wait…'
    : mode === 'login'
      ? 'Log in'
      : step === 1
        ? 'Continue'
        : 'Create account';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-space-950/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-panel border border-space-500/50 bg-space-900/90 p-6 animate-toast-in">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display font-bold text-lg tracking-[0.14em] uppercase text-neutral-100">
            {mode === 'login' ? 'Log in' : 'Create account'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-200 transition text-xl leading-none px-1"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-neutral-500 mb-4">{subtitle}</p>

        {mode === 'register' && (
          <div className="flex items-center gap-1.5 mb-5" aria-hidden="true">
            <span className={`h-1 flex-1 rounded-full transition-colors ${step >= 1 ? 'bg-brand-500' : 'bg-space-600'}`} />
            <span className={`h-1 flex-1 rounded-full transition-colors ${step >= 2 ? 'bg-brand-500' : 'bg-space-600'}`} />
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-3">
          {(mode === 'login' || step === 1) && (
            <div key="step-1" className="flex flex-col gap-3 animate-chip-in">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Username</span>
                <input
                  ref={firstFieldRef}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="bg-space-800/70 border border-space-500/50 rounded-control px-3 py-2 text-sm text-neutral-100 outline-none focus:border-brand-500 transition"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className="bg-space-800/70 border border-space-500/50 rounded-control px-3 py-2 text-sm text-neutral-100 outline-none focus:border-brand-500 transition"
                />
              </label>
            </div>
          )}

          {mode === 'register' && step === 2 && (
            <div key="step-2" className="flex flex-col gap-3 animate-chip-in">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Currency</span>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Currency">
                  {CURRENCY_OPTIONS.map((opt) => {
                    const active = opt.code === currency;
                    return (
                      <button
                        key={opt.code}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setCurrency(opt.code)}
                        className={`relative flex flex-col items-start gap-0.5 rounded-control px-3 py-2 text-left border transition ${
                          active
                            ? 'border-brand-500 bg-brand-500/10'
                            : 'border-space-500/50 bg-space-800/70 hover:border-space-400'
                        }`}
                      >
                        <span className={`text-sm font-bold ${active ? 'text-brand-400' : 'text-neutral-200'}`}>
                          {opt.country}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500">{opt.code}</span>
                        <span className={`absolute top-2 right-2 ${active ? 'text-brand-400' : 'text-neutral-600'}`}>
                          {opt.contact === 'phone' ? (
                            <PhoneIcon className="w-3 h-3" />
                          ) : (
                            <MailIcon className="w-3 h-3" />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div key={contactType} className="animate-chip-in">
                {contactType === 'phone' ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Phone number</span>
                    <div className="relative">
                      <PhoneIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
                      <input
                        ref={contactFieldRef}
                        type="tel"
                        inputMode="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="07xx xxx xxx"
                        autoComplete="tel"
                        className="w-full bg-space-800/70 border border-space-500/50 rounded-control pl-9 pr-3 py-2 text-sm text-neutral-100 outline-none focus:border-brand-500 transition tabular-nums"
                      />
                    </div>
                  </label>
                ) : (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Email address</span>
                    <div className="relative">
                      <MailIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
                      <input
                        ref={contactFieldRef}
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                        className="w-full bg-space-800/70 border border-space-500/50 rounded-control pl-9 pr-3 py-2 text-sm text-neutral-100 outline-none focus:border-brand-500 transition"
                      />
                    </div>
                  </label>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-loss-400 bg-loss-500/10 border border-loss-500/30 rounded-control px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 mt-1">
            {mode === 'register' && step === 2 && (
              <button
                type="button"
                onClick={back}
                className="rounded-control px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border border-space-500/50 text-neutral-300 hover:text-white hover:border-space-400 transition"
              >
                Back
              </button>
            )}
            <button
              type="submit"
              disabled={busy || !canProceed}
              className="flex-1 rounded-control px-4 py-2.5 text-sm font-semibold uppercase tracking-wider bg-brand-500 text-space-950 hover:brightness-110 transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitLabel}
            </button>
          </div>
        </form>

        <div className="mt-4 text-center text-xs text-neutral-500">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            className="text-brand-400 hover:text-brand-500 font-semibold transition"
          >
            {mode === 'login' ? 'Register' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  );
}
