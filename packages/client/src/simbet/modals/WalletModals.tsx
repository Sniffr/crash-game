import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { fromMinor, money, moneyShort, prettyPhone, toMinor } from '../lib/format';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { Check } from '../components/glyphs';
import { Button, ErrorNote, Field, Modal, ModalTitle, Spinner } from '../components/ui';

const QUICK = [50, 100, 500, 1000];

function QuickAmounts({ onAdd, selected }: { onAdd: (v: number) => void; selected: number | null }) {
  return (
    <div className="mb-5 grid grid-cols-4 gap-2">
      {QUICK.map((v) => (
        <button key={v} type="button" onClick={() => onAdd(v)}
          className={`h-10 rounded-md border text-[15px] sb-tabular transition-colors ${
            selected === v ? 'border-sb-primary bg-sb-primary text-white' : 'border-sb-line bg-sb-surface text-sb-text hover:border-sb-primary'}`}>
          +{v}
        </button>
      ))}
    </div>
  );
}

function MpesaMark() {
  return <img src="/simbet/mpesa.png" alt="M-PESA" className="mx-auto mt-6 h-12 w-auto" />;
}

function Done({ title, body, onClose, action }: { title: string; body: string; onClose: () => void; action?: { label: string; run: () => void } }) {
  return (
    <div className="py-2 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sb-success/15 text-sb-success"><Check className="h-7 w-7" strokeWidth={2.5} /></span>
      <h2 className="mt-4 font-sb-display text-[26px]">{title}</h2>
      <p className="mx-auto mt-1 max-w-sm text-[15px] text-sb-muted">{body}</p>
      <div className="mt-6 flex justify-center gap-3">
        {action && <Button variant="outline" onClick={action.run}>{action.label}</Button>}
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

// ─── Deposit ─────────────────────────────────────────────────────────────────
// POST starts an M-PESA STK push; the webhook credits the wallet once the
// player approves on their phone, so the modal waits and polls the balance.

export function DepositModal({ onClose }: { onClose: () => void }) {
  const { account, setBalance } = useSession();
  const currency = account?.currency ?? 'KES';
  const [amount, setAmount] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [phase, setPhase] = useState<'form' | 'pending' | 'credited' | 'timeout'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [startBalance, setStartBalance] = useState<number | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountMinor = toMinor(Number(amount), currency);
    if (amountMinor == null) { setError('Enter an amount greater than zero.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirectUrl?: string }>('/api/lobby/deposit', { body: { amountMinor }, auth: true });
      setStartBalance(account?.balanceMinor ?? null);
      if (r.redirectUrl) {
        setPayUrl(r.redirectUrl);
        window.open(r.redirectUrl, '_blank', 'noopener,noreferrer');
      }
      setPhase('pending');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the deposit.');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (phase !== 'pending') return;
    let cancelled = false;
    const deadline = Date.now() + 3 * 60_000;
    let timer = 0;
    const poll = async () => {
      try {
        const me = await api<{ balanceMinor: number }>('/api/account/me', { auth: true });
        if (cancelled) return;
        if (startBalance != null && me.balanceMinor > startBalance) {
          setBalance(me.balanceMinor);
          setPhase('credited');
          return;
        }
      } catch { /* keep polling */ }
      if (cancelled) return;
      if (Date.now() > deadline) { setPhase('timeout'); return; }
      timer = window.setTimeout(poll, 4000);
    };
    timer = window.setTimeout(poll, 4000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [phase, startBalance, setBalance]);

  if (phase === 'credited') {
    return <Modal onClose={onClose}><Done title="Deposit received" body="Your balance is updated and ready to play." onClose={onClose} /></Modal>;
  }

  if (phase === 'pending' || phase === 'timeout') {
    return (
      <Modal onClose={onClose} labelledBy="sb-dep-title">
        <div className="text-center">
          {phase === 'pending' ? <Spinner className="mx-auto h-10 w-10 text-sb-primary" /> : null}
          <h2 id="sb-dep-title" className="mt-4 font-sb-display text-[26px]">{payUrl ? 'Complete your payment' : 'Check your phone'}</h2>
          <p className="mx-auto mt-1 max-w-sm text-[15px] text-sb-muted">
            {phase === 'pending'
              ? payUrl ? 'Finish paying on the page we opened. This window updates on its own.' : `Approve the M-PESA prompt on ${prettyPhone(account?.phone)} and enter your PIN. This window updates on its own.`
              : 'We haven’t seen the payment yet. If you approved it, your balance will update shortly — you can close this window.'}
          </p>
          {payUrl && <a href={payUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block text-[14px] font-semibold text-sb-accent underline">Payment page didn’t open? Tap here</a>}
          <Button variant="outline" onClick={onClose} className="mx-auto mt-6 flex">Close</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="sb-dep-title">
      <form onSubmit={submit} noValidate className="mx-auto max-w-[400px]">
        <ModalTitle id="sb-dep-title" sub={<>You will receive an M-PESA prompt on <span className="whitespace-nowrap">{prettyPhone(account?.phone) || 'your phone'}</span></>}>
          Deposit to your account
        </ModalTitle>
        <QuickAmounts selected={picked} onAdd={(v) => { setPicked(v); setAmount(String((Number(amount) || 0) + v)); }} />
        <Field label="Deposit Amount" prefix={currency} type="number" inputMode="decimal" min="1" step="any" placeholder="0"
          value={amount} onChange={(e) => { setAmount(e.target.value); setPicked(null); }} className="sb-tabular" />
        {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
        <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Deposit</Button>
        <MpesaMark />
      </form>
    </Modal>
  );
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

interface Limits { minWithdrawalMinor: number; maxWithdrawalMinor: number }

export function WithdrawModal({ onClose }: { onClose: () => void }) {
  const { account, setBalance, closeModal } = useSession();
  const currency = account?.currency ?? 'KES';
  const [amount, setAmount] = useState('');
  const [limits, setLimits] = useState<Limits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amountMinor: number; phone: string } | null>(null);

  useEffect(() => {
    api<Limits>('/api/account/limits').then(setLimits).catch(() => { /* server enforces anyway */ });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountMinor = toMinor(Number(amount), currency);
    if (amountMinor == null) { setError('Enter an amount greater than zero.'); return; }
    if (account && amountMinor > account.balanceMinor) { setError(`You can withdraw up to ${money(account.balanceMinor, currency)}.`); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ amountMinor: number; phone: string; balanceMinor: number }>('/api/account/withdraw', { body: { amountMinor }, auth: true });
      setBalance(r.balanceMinor);
      setDone({ amountMinor: r.amountMinor, phone: r.phone });
    } catch (err) {
      if (err instanceof ApiError && typeof err.body?.balanceMinor === 'number') setBalance(err.body.balanceMinor);
      setError(err instanceof ApiError ? err.message : 'Could not start the withdrawal.');
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Modal onClose={onClose}>
        <Done title="Withdrawal on its way" onClose={onClose}
          body={`${money(done.amountMinor, currency)} is being sent to ${prettyPhone(done.phone)} by M-PESA. You’ll get an M-PESA message when it lands.`}
          action={{ label: 'Transactions', run: () => { closeModal(); navigate('/account/transactions'); } }} />
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="sb-wd-title">
      <form onSubmit={submit} noValidate className="mx-auto max-w-[400px]">
        <ModalTitle id="sb-wd-title" sub={<>You will receive an M-PESA message on <span className="whitespace-nowrap">{prettyPhone(account?.phone) || 'your phone'}</span></>}>
          Withdraw from your account
        </ModalTitle>
        <Field label="Withdrawal Amount" prefix={currency} type="number" inputMode="decimal" min="1" step="any" placeholder="0"
          value={amount} onChange={(e) => setAmount(e.target.value)} className="sb-tabular"
          hint={<>
            Available {account ? money(account.balanceMinor, currency) : '—'}
            {limits ? ` · min ${moneyShort(limits.minWithdrawalMinor, currency)} · max ${moneyShort(limits.maxWithdrawalMinor, currency)}` : ''}
          </>} />
        {account && account.balanceMinor > 0 && (
          <button type="button" onClick={() => setAmount(String(fromMinor(Math.min(account.balanceMinor, limits?.maxWithdrawalMinor ?? Infinity), currency)))}
            className="mt-2 text-[13px] font-semibold text-sb-accent hover:underline">Withdraw all</button>
        )}
        {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
        <Button type="submit" size="lg" busy={busy} className="mx-auto mt-6 flex w-full max-w-[240px]">Withdraw</Button>
        <MpesaMark />
      </form>
    </Modal>
  );
}
