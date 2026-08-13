import { useEffect, useRef, useState } from 'react';
import { Button, CheckIcon, Modal, Spinner, TextInput } from './ui';

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
  { code: 'UGX', country: 'Uganda', contact: 'phone' },
  { code: 'TZS', country: 'Tanzania', contact: 'phone' },
  { code: 'ZMW', country: 'Zambia', contact: 'phone' },
  { code: 'ZAR', country: 'South Africa', contact: 'email' },
];

/**
 * Login / register for the casino lobby.
 *
 * Login is a single username + password step. Register is a two-step flow:
 * (1) username + password, (2) settlement currency + the matching contact
 * channel (phone for the momo currencies, email for ZAR). All fetch/HTTP failures are
 * surfaced inline — the modal never throws.
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
  const [currency, setCurrency] = useState(CURRENCY_OPTIONS[0]!.code);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const contactFieldRef = useRef<HTMLInputElement>(null);

  const selected = CURRENCY_OPTIONS.find((c) => c.code === currency) ?? CURRENCY_OPTIONS[0]!;
  const contactType = selected.contact;

  useEffect(() => {
    if (mode === 'register' && step === 2) contactFieldRef.current?.focus();
    else firstFieldRef.current?.focus();
  }, [mode, step]);

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
      if (!u || !password) { setError('Enter a username and password'); return; }
      setStep(2);
      return;
    }

    if (!u || !password) { setError('Enter a username and password'); return; }
    if (mode === 'register') {
      if (contactType === 'phone' && !phone.trim()) { setError('Enter a phone number'); return; }
      if (contactType === 'email' && !email.trim()) { setError('Enter an email address'); return; }
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

      if (res.status === 401) { setError('Invalid username or password'); return; }
      if (res.status === 409) { setError('That username is already taken'); return; }
      if (!res.ok) { setError('Something went wrong — please try again'); return; }

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

  const onStepTwo = mode === 'register' && step === 2;

  const subtitle = mode === 'login'
    ? 'Log in to play with real stakes.'
    : onStepTwo
      ? 'Where should we settle your winnings?'
      : 'Pick a username and password to get started.';

  const submitLabel = mode === 'login' ? 'Log in' : onStepTwo ? 'Create account' : 'Continue';

  return (
    <Modal
      title={mode === 'login' ? 'Log in' : 'Create account'}
      onClose={onClose}
      footer={
        <div className="text-center text-[12px] text-neutral-500">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            className="font-semibold text-brand-400 transition-colors duration-150 ease-snap hover:text-brand-300"
          >
            {mode === 'login' ? 'Register' : 'Log in'}
          </button>
        </div>
      }
    >
      <p className="-mt-1 mb-4 text-[13px] text-neutral-500">{subtitle}</p>

      {mode === 'register' && (
        <div className="mb-5 flex items-center gap-1.5" aria-hidden="true">
          <span className="h-0.5 flex-1 rounded-full bg-brand-500" />
          <span className={`h-0.5 flex-1 rounded-full transition-colors duration-150 ease-snap ${step >= 2 ? 'bg-brand-500' : 'bg-white/10'}`} />
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3">
        {(mode === 'login' || step === 1) && (
          <div key="step-1" className="animate-rise flex flex-col gap-3">
            <TextInput
              ref={firstFieldRef}
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
            <TextInput
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>
        )}

        {onStepTwo && (
          <div key="step-2" className="animate-rise flex flex-col gap-4">
            <div>
              <span className="mb-1.5 block text-[11px] font-medium text-neutral-400">Currency</span>
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
                      className={`flex h-14 flex-col items-start justify-center rounded-btn border px-3 text-left transition-[background-color,border-color,transform] duration-150 ease-snap active:scale-[0.97] ${
                        active
                          ? 'border-brand-500/60 bg-brand-500/10'
                          : 'border-edge bg-space-950 hover:border-edge-strong'
                      }`}
                    >
                      <span className={`text-[13px] font-semibold ${active ? 'text-brand-300' : 'text-neutral-200'}`}>
                        {opt.country}
                      </span>
                      <span className="mt-0.5 text-[11px] text-neutral-500">
                        {opt.code} · {opt.contact === 'phone' ? 'mobile money' : 'bank / card'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div key={contactType} className="animate-rise">
              {contactType === 'phone' ? (
                <TextInput
                  ref={contactFieldRef}
                  label="Phone number"
                  hint="for the payment prompt"
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="07xx xxx xxx"
                  autoComplete="tel"
                  className="tabular-nums"
                />
              ) : (
                <TextInput
                  ref={contactFieldRef}
                  label="Email address"
                  hint="for payouts"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              )}
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-btn border border-loss-500/30 bg-loss-500/10 px-3 py-2 text-[12px] text-loss-400">
            {error}
          </p>
        )}

        <div className="mt-1 flex gap-2">
          {onStepTwo && (
            <Button variant="secondary" size="lg" onClick={() => { setError(null); setStep(1); }}>
              Back
            </Button>
          )}
          <Button type="submit" variant="primary" size="lg" disabled={busy || !canProceed} className="flex-1">
            {busy ? <><Spinner /> Please wait…</> : submitLabel}
          </Button>
        </div>

        {mode === 'register' && !onStepTwo && (
          <p className="flex items-center gap-1.5 text-[11px] text-neutral-600">
            <CheckIcon className="h-3 w-3 shrink-0 text-bet-400" />
            Play money only — no real wagers are taken.
          </p>
        )}
      </form>
    </Modal>
  );
}
