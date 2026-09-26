import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api } from '../lib/api';
import { longDate, prettyPhone } from '../lib/format';
import { navigate, useLocation } from '../lib/router';
import { useSession, type SignedIn } from '../lib/session';
import { Button, Dropdown, ErrorNote, Modal, ModalTitle, OtpInput, PageHeader, PasswordField, Tabs } from '../components/ui';

type Tab = 'password' | 'exclusion' | 'deactivate';
const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'password', label: 'Password Reset' },
  { key: 'exclusion', label: 'Self Exclusion' },
  { key: 'deactivate', label: 'Deactivate Account' },
];

export default function SettingsPage() {
  const { query } = useLocation();
  const initial = (TABS.find((t) => t.key === query.get('tab'))?.key ?? 'password');
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <>
      <PageHeader title="Settings" back="/account" />
      <div className="mx-auto max-w-[560px] px-3 pt-6 sm:px-0">
        <Tabs size="sm" className="mb-4 justify-center" items={TABS} value={tab} onChange={setTab} />
        {tab === 'password' && <PasswordTab />}
        {tab === 'exclusion' && <ExclusionTab />}
        {tab === 'deactivate' && <DeactivateTab />}
      </div>
    </>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-sb-line bg-sb-surface p-5 sm:p-6">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 text-[14px]">
      <p className="font-semibold">Note</p>
      <div className="mt-1 space-y-1 pl-2 text-sb-text/90">{children}</div>
    </div>
  );
}

// ─── Password ────────────────────────────────────────────────────────────────

function PasswordTab() {
  const { signIn, notify, openModal } = useSession();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) { setError('Your new password must be at least 8 characters long.'); return; }
    setBusy(true);
    setError(null);
    try {
      // Changing the password signs out every other session; this one gets a fresh token.
      signIn(await api<SignedIn>('/api/account/password', { method: 'PUT', body: { oldPassword, newPassword }, auth: true }));
      setOld(''); setNew('');
      notify('Password changed. Other devices have been signed out.', 'success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change your password.');
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <PasswordField label="Old Password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} />
        <PasswordField label="New Password" autoComplete="new-password" className="mt-5" value={newPassword} onChange={(e) => setNew(e.target.value)} />
        <Note>
          <p>Your password must be at least 8 characters long.</p>
          <p>Your password can be any alphanumeric combination.</p>
        </Note>
        {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
        <Button type="submit" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Confirm</Button>
        <p className="mt-3 text-center">
          <button type="button" onClick={() => openModal('forgot')} className="text-[14px] font-semibold text-sb-accent hover:underline">Forgot Password?</button>
        </p>
      </form>
    </Card>
  );
}

// ─── Self exclusion ──────────────────────────────────────────────────────────

type Period = '24h' | '48h' | '7d' | '30d' | '90d';
const PERIODS: ReadonlyArray<{ key: Period; label: string; ms: number }> = [
  { key: '24h', label: '24 Hours', ms: 24 * 3_600_000 },
  { key: '48h', label: '48 Hours', ms: 48 * 3_600_000 },
  { key: '7d', label: '7 Days', ms: 7 * 86_400_000 },
  { key: '30d', label: '30 Days', ms: 30 * 86_400_000 },
  { key: '90d', label: '90 Days', ms: 90 * 86_400_000 },
];

function ExclusionTab() {
  const { signOut } = useSession();
  const [period, setPeriod] = useState<Period | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endsAt = period ? new Date(Date.now() + PERIODS.find((p) => p.key === period)!.ms).toISOString() : null;

  const exclude = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ until: string }>('/api/account/self-exclusion', { body: { period }, auth: true });
      setConfirming(false);
      signOut(`You’re self-excluded until ${longDate(r.until)}. Take care — we’ll be here when it ends.`);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start your self-exclusion.');
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <p className="mb-1.5 font-sb-form text-[14px] font-medium">Self Exclusion Period</p>
      <Dropdown block label="Self exclusion period" value={period} options={PERIODS} onChange={setPeriod} />
      <Note>
        <p>When you opt for self-exclusion, you are prohibited from creating new Sim Bet accounts during the self-exclusion period.</p>
        <p>Once you exclude yourself, it cannot be re-enabled until the time period has concluded or by contacting customer service.</p>
      </Note>
      {error && !confirming && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button disabled={!period} onClick={() => setConfirming(true)} className="mx-auto mt-6 flex w-full max-w-[240px]">Continue</Button>
      {confirming && endsAt && (
        <Modal onClose={() => setConfirming(false)} width="max-w-[520px]" labelledBy="sb-excl-title">
          <ModalTitle id="sb-excl-title" sub={<>Your self exclusion will start immediately and will end on:<br /><b className="text-sb-text">{longDate(endsAt)}</b></>}>
            Self Exclusion
          </ModalTitle>
          <p className="-mt-2 mb-4 text-center text-[13px] text-sb-muted">You’ll be signed out and can’t log in, bet or deposit until then.</p>
          {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="danger" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button busy={busy} onClick={exclude}>Self Exclude</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ─── Deactivate ──────────────────────────────────────────────────────────────

type Reason = 'fraud' | 'addiction' | 'other';
const REASONS: ReadonlyArray<{ key: Reason; label: string }> = [
  { key: 'fraud', label: 'Fraud or compromised account' },
  { key: 'addiction', label: 'Addiction' },
  { key: 'other', label: 'Other' },
];

function DeactivateTab() {
  const { account, signOut } = useSession();
  const [reason, setReason] = useState<Reason | null>(null);
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/account/deactivate/request', { body: { reason }, auth: true });
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the code.');
    } finally { setBusy(false); }
  };

  const confirm = async (value = code) => {
    if (value.length !== 6) { setError('Enter the 6-digit code.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/api/account/deactivate/confirm', { body: { reason, code: value }, auth: true });
      signOut('Your account is deactivated. You can reactivate it any time from the footer.');
      navigate('/');
    } catch (err) {
      setCode('');
      setError(err instanceof ApiError ? err.message : 'Could not deactivate your account.');
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <p className="mb-1.5 font-sb-form text-[14px] font-medium">Deactivate Reason</p>
      <Dropdown block label="Deactivate reason" value={reason} options={REASONS} onChange={setReason} />
      <Note>
        <p>Deactivation freezes all the funds in your account, logs out anybody currently logged in and prevents new log ins to your account.</p>
        <p>You will receive a 6 digit code to confirm that you are the owner of the account you wish to deactivate.</p>
      </Note>
      {error && step === 'form' && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button disabled={!reason} busy={busy && step === 'form'} onClick={request} className="mx-auto mt-6 flex w-full max-w-[240px]">Next</Button>
      {step === 'otp' && (
        <Modal onClose={() => { setStep('form'); setCode(''); setError(null); }} labelledBy="sb-deact-title">
          <form onSubmit={(e) => { e.preventDefault(); void confirm(); }} className="mx-auto max-w-[400px]">
            <ModalTitle id="sb-deact-title" sub={<>Enter the code we sent to <b className="text-sb-text">{prettyPhone(account?.phone)}</b> to deactivate your account.</>}>
              Verify OTP Code
            </ModalTitle>
            <OtpInput value={code} onChange={setCode} onComplete={(v) => void confirm(v)} disabled={busy} />
            {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
            <Button type="submit" variant="danger" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Deactivate Account</Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
