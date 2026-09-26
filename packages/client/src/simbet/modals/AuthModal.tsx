import { useEffect, useState, type FormEvent } from 'react';
import { normalizeKePhone } from '@crash/shared/phone';
import { ApiError, api } from '../lib/api';
import { longDate, prettyPhone } from '../lib/format';
import { Link } from '../lib/router';
import { useSession, type SignedIn } from '../lib/session';
import { Button, ErrorNote, Field, Modal, ModalTitle, OtpInput, PasswordField, Tabs } from '../components/ui';

/**
 * Sign-up, sign-in and account recovery — every flow is phone + SMS code.
 *
 *   register ─► otp(register) ─► signed in
 *   login ─► signed in            (unverified phone ─► otp(register))
 *   forgot ─► otp(reset) ─► new password ─► signed in
 *   reactivate ─► otp(reactivate) ─► new password ─► signed in
 */

type Step =
  | { kind: 'register' }
  | { kind: 'login' }
  | { kind: 'forgot' }
  | { kind: 'reactivate' }
  | { kind: 'otp'; purpose: 'register' | 'reset' | 'reactivate'; phone: string; resendInSec: number }
  | { kind: 'password'; purpose: 'reset' | 'reactivate'; proof: string };

export type AuthEntry = 'login' | 'register' | 'forgot' | 'reactivate';

const PHONE_ERROR = 'Enter a valid Kenyan phone number, e.g. 0712 345 678.';

export default function AuthModal({ entry, onClose }: { entry: AuthEntry; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: entry });
  const [phone, setPhone] = useState('');
  return (
    <Modal onClose={onClose} labelledBy="sb-auth-title">
      {(step.kind === 'register' || step.kind === 'login') && (
        <Tabs
          className="mb-8 justify-center"
          items={[{ key: 'register', label: 'Register' }, { key: 'login', label: 'Login' }] as const}
          value={step.kind}
          onChange={(k) => setStep({ kind: k })}
        />
      )}
      {step.kind === 'register' && <RegisterForm phone={phone} setPhone={setPhone} go={setStep} onClose={onClose} />}
      {step.kind === 'login' && <LoginForm phone={phone} setPhone={setPhone} go={setStep} />}
      {step.kind === 'forgot' && <PhoneStep phone={phone} setPhone={setPhone} go={setStep} purpose="reset" />}
      {step.kind === 'reactivate' && <PhoneStep phone={phone} setPhone={setPhone} go={setStep} purpose="reactivate" />}
      {step.kind === 'otp' && <OtpStep step={step} go={setStep} />}
      {step.kind === 'password' && <NewPasswordStep step={step} go={setStep} />}
    </Modal>
  );
}

type Go = (s: Step) => void;

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.');
    } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

// ─── Register ────────────────────────────────────────────────────────────────

function RegisterForm({ phone, setPhone, go, onClose }: { phone: string; setPhone: (v: string) => void; go: Go; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [fieldErr, setFieldErr] = useState<{ phone?: string; password?: string }>({});
  const { busy, error, setError, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeKePhone(phone);
    const errs = { phone: normalized ? undefined : PHONE_ERROR, password: password.length >= 8 ? undefined : 'Use at least 8 characters.' };
    setFieldErr(errs);
    if (errs.phone || errs.password) return;
    void run(async () => {
      try {
        const r = await api<{ phone: string; resendInSec: number }>('/api/account/register', { body: { phone: normalized, password } });
        go({ kind: 'otp', purpose: 'register', phone: r.phone, resendInSec: r.resendInSec });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PHONE_TAKEN') { setError(err.message); return; }
        throw err;
      }
    });
  };

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-[400px]">
      <h2 id="sb-auth-title" className="sr-only">Register</h2>
      <Field label="Phone Number" type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX"
        value={phone} onChange={(e) => setPhone(e.target.value)} error={fieldErr.phone} />
      <PasswordField label="Password" autoComplete="new-password" className="mt-5" value={password}
        onChange={(e) => setPassword(e.target.value)} error={fieldErr.password} hint="At least 8 characters." />
      <p className="mt-6 text-[14px] leading-relaxed text-sb-text">
        By creating this account, I confirm that I am 18 years of age, and accept the{' '}
        <Link to="/terms" onClick={onClose} className="font-semibold text-sb-accent underline-offset-2 hover:underline">Terms and Conditions</Link> and{' '}
        <Link to="/privacy" onClick={onClose} className="font-semibold text-sb-accent underline-offset-2 hover:underline">Privacy Policy</Link>.
      </p>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Register</Button>
      <p className="mt-4 text-center text-[14px] text-sb-text">
        Already have an account?{' '}
        <button type="button" onClick={() => go({ kind: 'login' })} className="font-semibold text-sb-accent hover:underline">Log In</button>
      </p>
    </form>
  );
}

// ─── Login ───────────────────────────────────────────────────────────────────

function LoginForm({ phone, setPhone, go }: { phone: string; setPhone: (v: string) => void; go: Go }) {
  const { signIn } = useSession();
  const [password, setPassword] = useState('');
  const [phoneErr, setPhoneErr] = useState<string | undefined>();
  const [deactivated, setDeactivated] = useState(false);
  const { busy, error, setError, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeKePhone(phone);
    setPhoneErr(normalized ? undefined : PHONE_ERROR);
    setDeactivated(false);
    if (!normalized || !password) { if (normalized) setError('Enter your password.'); return; }
    void run(async () => {
      try {
        signIn(await api<SignedIn>('/api/account/login', { body: { phone: normalized, password } }));
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.code === 'PHONE_NOT_VERIFIED') {
          go({ kind: 'otp', purpose: 'register', phone: normalized, resendInSec: Number(err.details.resendInSec ?? 60) });
          return;
        }
        if (err.code === 'ACCOUNT_DEACTIVATED') setDeactivated(true);
        if (err.code === 'SELF_EXCLUDED' && typeof err.details.until === 'string') {
          setError(`You are self-excluded until ${longDate(err.details.until)}.`);
          return;
        }
        throw err;
      }
    });
  };

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-[400px]">
      <h2 id="sb-auth-title" className="sr-only">Login</h2>
      <Field label="Phone Number" type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX"
        value={phone} onChange={(e) => setPhone(e.target.value)} error={phoneErr} />
      <PasswordField label="Password" autoComplete="current-password" className="mt-5" value={password} onChange={(e) => setPassword(e.target.value)} />
      <p className="mt-4 text-center text-[14px] text-sb-text">
        Forgot Password?{' '}
        <button type="button" onClick={() => go({ kind: 'forgot' })} className="font-semibold text-sb-accent hover:underline">Click here.</button>
      </p>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      {deactivated && (
        <Button variant="outline" onClick={() => go({ kind: 'reactivate' })} className="mx-auto mt-3 flex">Reactivate my account</Button>
      )}
      <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Login</Button>
      <p className="mt-4 text-center text-[14px] text-sb-text">
        Don’t have an account?{' '}
        <button type="button" onClick={() => go({ kind: 'register' })} className="font-semibold text-sb-accent hover:underline">Register</button>
      </p>
    </form>
  );
}

// ─── Forgot password / reactivate: phone → code ─────────────────────────────

function PhoneStep({ phone, setPhone, go, purpose }: { phone: string; setPhone: (v: string) => void; go: Go; purpose: 'reset' | 'reactivate' }) {
  const [phoneErr, setPhoneErr] = useState<string | undefined>();
  const { busy, error, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeKePhone(phone);
    setPhoneErr(normalized ? undefined : PHONE_ERROR);
    if (!normalized) return;
    void run(async () => {
      const r = await api<{ resendInSec: number }>(purpose === 'reset' ? '/api/account/password/forgot' : '/api/account/reactivate/request', { body: { phone: normalized } });
      go({ kind: 'otp', purpose, phone: normalized, resendInSec: r.resendInSec });
    });
  };
  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-[400px]">
      <ModalTitle id="sb-auth-title" sub={purpose === 'reset'
        ? 'Please enter your phone number to reset your password.'
        : 'In order to reactivate your account, you will need to verify an OTP and reset your password.'}>
        {purpose === 'reset' ? 'Forgot Password?' : 'Reactivate Account'}
      </ModalTitle>
      <Field label="Phone Number" type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX"
        value={phone} onChange={(e) => setPhone(e.target.value)} error={phoneErr} />
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Send OTP Code</Button>
      <p className="mt-4 text-center text-[14px] text-sb-text">
        <button type="button" onClick={() => go({ kind: 'login' })} className="font-semibold text-sb-accent hover:underline">Back to Login</button>
      </p>
    </form>
  );
}

// ─── One-time code ───────────────────────────────────────────────────────────

function useCountdown(initial: number) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  return [left, setLeft] as const;
}

function OtpStep({ step, go }: { step: Extract<Step, { kind: 'otp' }>; go: Go }) {
  const { signIn, notify } = useSession();
  const [code, setCode] = useState('');
  const [left, setLeft] = useCountdown(step.resendInSec);
  const { busy, error, setError, run } = useSubmit();
  const [resending, setResending] = useState(false);

  const verify = (value = code) => {
    if (value.length !== 6 || busy) { if (value.length !== 6) setError('Enter the 6-digit code.'); return; }
    void run(async () => {
      try {
        if (step.purpose === 'register') {
          signIn(await api<SignedIn>('/api/account/register/verify', { body: { phone: step.phone, code: value } }));
          notify('Welcome to SimBet — your account is ready.', 'success');
        } else {
          const path = step.purpose === 'reset' ? '/api/account/password/verify' : '/api/account/reactivate/verify';
          const r = await api<{ proof: string }>(path, { body: { phone: step.phone, code: value } });
          go({ kind: 'password', purpose: step.purpose, proof: r.proof });
        }
      } catch (err) {
        setCode('');
        throw err;
      }
    });
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    try {
      const r = await api<{ resendInSec: number }>('/api/account/otp/resend', { body: { phone: step.phone, purpose: step.purpose } });
      setLeft(r.resendInSec);
      notify('A new code is on its way.', 'info');
    } catch (err) {
      if (err instanceof ApiError && typeof err.details.retryAfterSec === 'number') setLeft(err.details.retryAfterSec);
      setError(err instanceof ApiError ? err.message : 'Could not resend the code.');
    } finally { setResending(false); }
  };

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <form onSubmit={(e) => { e.preventDefault(); verify(); }} noValidate className="mx-auto max-w-[400px]">
      <ModalTitle id="sb-auth-title" sub={<>Please enter the OTP code sent to your phone number <span className="whitespace-nowrap font-semibold text-sb-text">{prettyPhone(step.phone)}</span>.</>}>
        Verify OTP Code
      </ModalTitle>
      <OtpInput value={code} onChange={setCode} onComplete={verify} disabled={busy} />
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Verify OTP</Button>
      <p className="mt-4 text-center text-[14px] text-sb-text">
        {left > 0
          ? <>Resend in <span className="sb-tabular">{mm}:{ss}</span></>
          : <button type="button" onClick={resend} disabled={resending} className="font-semibold text-sb-accent hover:underline disabled:opacity-50">Resend code</button>}
      </p>
    </form>
  );
}

// ─── New password (after reset / reactivation codes) ─────────────────────────

function NewPasswordStep({ step, go }: { step: Extract<Step, { kind: 'password' }>; go: Go }) {
  const { signIn, notify } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errs, setErrs] = useState<{ password?: string; confirm?: string }>({});
  const { busy, error, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = {
      password: password.length >= 8 ? undefined : 'Use at least 8 characters.',
      confirm: confirm === password ? undefined : 'The passwords don’t match.',
    };
    setErrs(next);
    if (next.password || next.confirm) return;
    void run(async () => {
      try {
        const path = step.purpose === 'reset' ? '/api/account/password/reset' : '/api/account/reactivate/complete';
        signIn(await api<SignedIn>(path, { body: { proof: step.proof, password } }));
        notify(step.purpose === 'reset' ? 'Password changed — you’re signed in.' : 'Welcome back — your account is active again.', 'success');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PROOF_EXPIRED') {
          notify(err.message, 'error');
          go({ kind: step.purpose === 'reset' ? 'forgot' : 'reactivate' });
          return;
        }
        throw err;
      }
    });
  };

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-[400px]">
      <ModalTitle id="sb-auth-title" sub="Please enter and confirm your new password.">Choose new password</ModalTitle>
      <PasswordField label="Password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} hint="At least 8 characters." />
      <PasswordField label="Confirm Password" autoComplete="new-password" className="mt-5" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errs.confirm} />
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">
        {step.purpose === 'reset' ? 'Reset Password' : 'Reactivate Account'}
      </Button>
    </form>
  );
}
