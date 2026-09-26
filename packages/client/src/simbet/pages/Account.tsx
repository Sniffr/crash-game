import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateTime, money, prettyPhone } from '../lib/format';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { accountMenu, Avatar } from '../components/Shell';
import { Badge, type BadgeTone, Button, Dropdown, Empty, Modal, PageHeader, Pagination, Spinner, Tabs } from '../components/ui';
import { CardSend, ChevronRight, MoneyAdd, UserCircle } from '../components/glyphs';
import { BetDetailsModal } from '../components/BetDetails';

// ─── Profile ─────────────────────────────────────────────────────────────────

export function AccountPage() {
  const session = useSession();
  const { account, openModal } = session;
  const items = accountMenu(session).filter((i) => i.mobile);
  return (
    <>
      <PageHeader title="Profile" icon={<UserCircle className="h-7 w-7 shrink-0" />} />
      <div className="mx-auto grid max-w-[1100px] gap-4 px-3 pt-6 sm:px-[22px] md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-sb-line bg-sb-surface p-5">
            <MoneyAdd className="h-7 w-7" />
            <p className="mt-4 text-[15px]">Account Balance</p>
            <p className="font-sb-form text-[30px] font-medium text-sb-accent sb-tabular">{account ? money(account.balanceMinor, account.currency) : '—'}</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Button onClick={() => openModal('deposit')}><MoneyAdd className="h-5 w-5" /> Deposit</Button>
              <Button variant="outline" onClick={() => openModal('withdraw')}><CardSend className="h-5 w-5" /> Withdraw</Button>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-xl border border-sb-line bg-sb-surface p-5">
            <Avatar name={account?.username ?? ''} className="h-14 w-14" />
            <dl className="min-w-0 text-[14px]">
              <dt className="text-sb-muted">Phone number</dt>
              <dd className="font-semibold">{prettyPhone(account?.phone) || '—'}</dd>
              {account && account.username !== account.phone && (<><dt className="mt-2 text-sb-muted">Username</dt><dd className="truncate font-semibold">{account.username}</dd></>)}
              <dt className="mt-2 text-sb-muted">Currency</dt>
              <dd className="font-semibold">{account?.currency ?? '—'}</dd>
            </dl>
          </div>
        </div>
        <ul className="self-start overflow-hidden rounded-xl border border-sb-line bg-sb-surface py-2">
          {items.map((it) => (
            <li key={it.label}>
              <button type="button" onClick={it.run}
                className={`flex w-full items-center gap-3 px-5 py-3 text-left text-[16px] hover:bg-sb-surface2 ${it.danger ? 'text-sb-error' : ''}`}>
                <it.icon className="h-5 w-5 shrink-0" />
                <span className="flex-1">{it.label}</span>
                <ChevronRight className="h-4 w-4 text-sb-muted" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ─── Shared list chrome ──────────────────────────────────────────────────────

type HistoryDates = 'all' | 'today' | '7d' | '30d' | '90d';
const HISTORY_DATES: ReadonlyArray<{ key: HistoryDates; label: string }> = [
  { key: 'all', label: 'All Dates' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: '90d', label: 'Last 90 Days' },
];
function fromFor(d: HistoryDates): string | null {
  if (d === 'all') return null;
  const start = new Date();
  if (d === 'today') start.setHours(0, 0, 0, 0);
  else start.setDate(start.getDate() - (d === '7d' ? 7 : d === '30d' ? 30 : 90));
  return start.toISOString();
}

const PAGE_SIZE = 10;

function usePaged<T>(path: string | null, params: Record<string, string | null>, page: number) {
  const [data, setData] = useState<{ items: T[]; total: number } | null>(null);
  const [error, setError] = useState(false);
  const key = JSON.stringify(params) + page;
  useEffect(() => {
    if (!path) return;
    let live = true;
    setData(null);
    setError(false);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    api<{ items: T[]; total: number }>(`${path}?${qs}`, { auth: true })
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
  return { data, error };
}

// ─── Bet History ─────────────────────────────────────────────────────────────

interface HistoryBet {
  id: string;
  kind: 'sim' | 'fantasy';
  type: 'single' | 'multi' | 'fantasy';
  placedAt: string;
  status: 'active' | 'won' | 'lost' | 'cancelled';
  currency: string;
  stakeMinor: number;
  potentialWinMinor: number | null;
  payoutMinor: number | null;
  totalOdds: number | null;
  legs: Array<{ home: string | null; away: string | null }>;
  fantasy: { leagueId: string; name: string; gameweek: number; rank: number | null; points: number | null } | null;
}

const STATUS_TONE: Record<HistoryBet['status'], BadgeTone> = { active: 'active', won: 'won', lost: 'lost', cancelled: 'neutral' };
const STATUS_TEXT: Record<HistoryBet['status'], string> = { active: 'Active', won: 'Won', lost: 'Lost', cancelled: 'Refunded' };

export function BetHistoryPage() {
  const [status, setStatus] = useState<'all' | 'active' | 'settled'>('all');
  const [dates, setDates] = useState<HistoryDates>('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = usePaged<HistoryBet>('/api/account/bets', { status, from: fromFor(dates) }, page);
  const pages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <>
      <PageHeader title="Bet History" back="/account" />
      <div className="mx-auto max-w-[1396px] px-3 pt-4 sm:px-[22px]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Tabs size="sm" value={status} onChange={(s) => { setStatus(s); setPage(1); }}
            items={[{ key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'settled', label: 'Settled' }] as const} />
          <Dropdown label="Dates" value={dates} options={HISTORY_DATES} onChange={(d) => { setDates(d); setPage(1); }} />
        </div>
        {error ? <Empty title="Bet history didn’t load" body="Please try again in a moment." />
          : !data ? <div className="grid place-items-center py-24"><Spinner className="h-8 w-8 text-sb-primary" /></div>
          : data.items.length === 0 ? <Empty title="No bets yet" body="Bets you place on Simulated Matches and Fantasy League entries show up here."
              action={<Button onClick={() => navigate('/matches')}>Browse matches</Button>} />
          : (
            <ul className="flex flex-col gap-3">
              {data.items.map((b) => (
                <li key={b.id}><BetRow bet={b} onOpen={() => (b.kind === 'sim' ? setOpen(b.id) : navigate(`/fantasy/${encodeURIComponent(b.fantasy!.leagueId)}`))} /></li>
              ))}
            </ul>
          )}
        <Pagination page={page} pages={pages} onPage={(p) => { setPage(p); window.scrollTo({ top: 0 }); }} />
      </div>
      {open && <BetDetailsModal betId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function BetRow({ bet, onOpen }: { bet: HistoryBet; onOpen: () => void }) {
  const matches = bet.legs.map((l) => `${l.home ?? 'Home'} vs ${l.away ?? 'Away'}`);
  const extra = matches.length - 2;
  const win = bet.status === 'won' ? bet.payoutMinor : bet.potentialWinMinor;
  return (
    <button type="button" onClick={onOpen} className="block w-full overflow-hidden rounded-xl border border-sb-line bg-sb-surface text-left hover:border-sb-primary/60">
      <p className="px-4 pt-3 text-[13px] text-sb-muted sb-tabular">{dateTime(bet.placedAt)}</p>
      <div className="mt-2 flex items-center justify-between bg-sb-surface2 px-4 py-2 text-[14px]">
        <span className="font-medium">{bet.kind === 'fantasy' ? 'Fantasy League' : bet.type === 'multi' ? 'Multi Bet' : 'Single Bet'}</span>
        <span className="flex items-center gap-1"><Badge tone={STATUS_TONE[bet.status]}>{STATUS_TEXT[bet.status]}</Badge><ChevronRight className="h-4 w-4" /></span>
      </div>
      <div className="flex items-start gap-4 px-4 py-3 text-[14px]">
        <div className="min-w-0 flex-1">
          {bet.kind === 'fantasy' ? (
            <>
              <p className="truncate">{bet.fantasy!.name} · GW {bet.fantasy!.gameweek}</p>
              {bet.fantasy!.points != null && <p className="text-sb-muted">{bet.fantasy!.points} pts{bet.fantasy!.rank ? ` · ${bet.fantasy!.rank}${bet.fantasy!.rank === 1 ? 'st' : bet.fantasy!.rank === 2 ? 'nd' : bet.fantasy!.rank === 3 ? 'rd' : 'th'} place` : ''}</p>}
            </>
          ) : (
            <>
              {matches.slice(0, 2).map((m, i) => <p key={i} className="truncate">{m}</p>)}
              {extra > 0 && <p className="font-semibold text-sb-accent">+{extra} {extra === 1 ? 'match' : 'matches'}</p>}
            </>
          )}
        </div>
        <div className="shrink-0 text-center">
          <p className="text-sb-muted">{bet.kind === 'fantasy' ? 'Entry Fee' : 'Bet Amount'}</p>
          <p className="font-semibold sb-tabular">{money(bet.stakeMinor, bet.currency)}</p>
        </div>
        <div className="w-[110px] shrink-0 text-right">
          <p className="text-sb-muted">{bet.status === 'won' ? 'Won' : bet.status === 'cancelled' ? 'Refunded' : 'Est. Win'}</p>
          <p className={`font-semibold sb-tabular ${bet.status === 'won' ? 'text-sb-success' : ''}`}>
            {bet.status === 'cancelled' ? money(bet.stakeMinor, bet.currency) : win != null ? money(win, bet.currency) : 'Top 3 prize'}
          </p>
        </div>
      </div>
    </button>
  );
}

// ─── Transactions ────────────────────────────────────────────────────────────

interface Txn {
  reference: string;
  displayId: string;
  type: 'deposit' | 'withdrawal';
  status: 'pending' | 'success' | 'failed';
  amountMinor: number;
  currency: string;
  createdAt: string;
}
const TXN_TONE: Record<Txn['status'], BadgeTone> = { pending: 'pending', success: 'success', failed: 'failed' };
const TXN_TEXT: Record<Txn['status'], string> = { pending: 'Pending', success: 'Success', failed: 'Failed' };
const TYPE_TEXT: Record<Txn['type'], string> = { deposit: 'Deposit', withdrawal: 'Withdrawal' };

export function TransactionsPage() {
  const [type, setType] = useState<'all' | 'deposit' | 'withdrawal'>('all');
  const [dates, setDates] = useState<HistoryDates>('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Txn | null>(null);
  const { data, error } = usePaged<Txn>('/api/account/transactions', { type, from: fromFor(dates) }, page);
  const pages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <>
      <PageHeader title="Transactions" back="/account" />
      <div className="mx-auto max-w-[1396px] px-3 pt-4 sm:px-[22px]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Tabs size="sm" value={type} onChange={(t) => { setType(t); setPage(1); }}
            items={[{ key: 'all', label: 'All' }, { key: 'deposit', label: 'Deposits' }, { key: 'withdrawal', label: 'Withdrawals' }] as const} />
          <Dropdown label="Dates" value={dates} options={HISTORY_DATES} onChange={(d) => { setDates(d); setPage(1); }} />
        </div>
        {error ? <Empty title="Transactions didn’t load" body="Please try again in a moment." />
          : !data ? <div className="grid place-items-center py-24"><Spinner className="h-8 w-8 text-sb-primary" /></div>
          : data.items.length === 0 ? <Empty title="No transactions yet" body="Deposits and withdrawals show up here." />
          : (
            <div className="overflow-hidden rounded-xl border border-sb-line bg-sb-surface p-2 sm:p-3">
              <table className="w-full text-left text-[14px]">
                <thead>
                  <tr className="bg-sb-surface2">
                    <th className="hidden rounded-l-md px-3 py-2.5 font-medium md:table-cell">Time</th>
                    <th className="rounded-l-md px-3 py-2.5 font-medium md:rounded-none">Type</th>
                    <th className="hidden px-3 py-2.5 font-medium md:table-cell">Transaction ID</th>
                    <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                    <th className="hidden rounded-r-md px-3 py-2.5 text-center font-medium md:table-cell">Status</th>
                    <th className="w-8 rounded-r-md md:hidden" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((t) => (
                    <tr key={t.reference} onClick={() => setOpen(t)} className="cursor-pointer hover:bg-sb-surface2/60">
                      <td className="hidden px-3 py-3 sb-tabular md:table-cell">{dateTime(t.createdAt)}</td>
                      <td className="px-3 py-3">{TYPE_TEXT[t.type]}</td>
                      <td className="hidden px-3 py-3 sb-tabular md:table-cell">{t.displayId}</td>
                      <td className="px-3 py-3 text-right sb-tabular">{money(t.amountMinor, t.currency)}</td>
                      <td className="hidden px-3 py-3 text-center md:table-cell"><Badge tone={TXN_TONE[t.status]}>{TXN_TEXT[t.status]}</Badge></td>
                      <td className="px-1 md:hidden"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pagination page={page} pages={pages} onPage={(p) => { setPage(p); window.scrollTo({ top: 0 }); }} />
      </div>
      {open && (
        <Modal onClose={() => setOpen(null)} labelledBy="sb-txn-title">
          <div className="text-center">
            <h2 id="sb-txn-title" className="font-sb-display text-[26px]">{open.displayId}</h2>
            <p className="text-[14px] text-sb-muted sb-tabular">{dateTime(open.createdAt)}</p>
          </div>
          <div className="mt-5 overflow-hidden rounded-lg border border-sb-line">
            <p className="bg-sb-surface2 px-4 py-2 text-[14px] font-medium">{TYPE_TEXT[open.type]}</p>
            <div className="flex items-center justify-between px-4 py-3 text-[14px]">
              <div><p className="text-sb-muted">Amount</p><p className="font-semibold sb-tabular">{money(open.amountMinor, open.currency)}</p></div>
              <Badge tone={TXN_TONE[open.status]}>{TXN_TEXT[open.status]}</Badge>
            </div>
          </div>
          {open.status === 'pending' && open.type === 'withdrawal' && (
            <p className="mt-4 text-center text-[13px] text-sb-muted">Withdrawals usually land within minutes. If this one stays pending, contact support with the ID above.</p>
          )}
        </Modal>
      )}
    </>
  );
}
