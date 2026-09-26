import { useEffect, useMemo, useState } from 'react';
import {
  BUDGET_TENTHS, MAX_PER_CLUB, POSITIONS, POSITION_LIMITS, SQUAD_SIZE,
  formatMillions, squadCost, squadIssues, type Position, type SquadPick,
} from '@crash/shared/fantasy';
import { ApiError, api } from '../lib/api';
import { moneyShort } from '../lib/format';
import { useSession } from '../lib/session';
import { Close } from '../components/glyphs';
import { Button, ErrorNote, Field, Modal, Spinner, Tabs } from '../components/ui';
import type { Catalog, CatalogPlayer, FplLink, League } from './api';

const POSITION_TONE: Record<Position, string> = {
  GKP: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  DEF: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  MID: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  FWD: 'bg-sb-primary/15 text-sb-accent',
};
const STATUS_LABEL: Record<string, string> = { d: 'Doubtful', i: 'Injured', s: 'Suspended' };

export function PositionTag({ position }: { position: Position }) {
  return <span className={`inline-flex w-10 shrink-0 justify-center rounded px-1 py-0.5 text-[11px] font-bold ${POSITION_TONE[position]}`}>{position}</span>;
}

/**
 * Pick an XI for a league: 11 players in a legal formation, within budget,
 * max per club, plus captain (2×) and vice. Rules come from @crash/shared/fantasy,
 * the same code the server validates the entry with.
 */
export function SquadBuilder({ league, catalog, onClose, onJoined }: {
  league: League; catalog: Catalog | null; onClose: () => void; onJoined: () => void;
}) {
  const { account, setBalance, refresh, openModal } = useSession();
  const [picked, setPicked] = useState<number[]>([]);
  const [captainId, setCaptainId] = useState<number | null>(null);
  const [viceId, setViceId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Position | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ text: string; deposit?: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<'pool' | 'xi'>('pool');

  const pool = useMemo(() => new Map((catalog?.players ?? []).map((p) => [p.id, p])), [catalog]);
  const clubs = useMemo(() => new Map((catalog?.teams ?? []).map((t) => [t.id, t.shortName])), [catalog]);
  const currencyMismatch = account != null && account.currency !== league.currency;

  const counts = useMemo(() => {
    const c: Record<Position, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const id of picked) { const p = pool.get(id); if (p) c[p.position] += 1; }
    return c;
  }, [picked, pool]);
  const clubCounts = useMemo(() => {
    const c = new Map<number, number>();
    for (const id of picked) { const p = pool.get(id); if (p) c.set(p.teamId, (c.get(p.teamId) ?? 0) + 1); }
    return c;
  }, [picked, pool]);
  const spent = squadCost(picked, pool);
  const pick: SquadPick = { playerIds: picked, captainId: captainId ?? -1, viceCaptainId: viceId ?? -1 };
  const issues = squadIssues(pick, pool);

  const setSquad = (ids: number[], captain: number | null, vice: number | null) => {
    setPicked(ids);
    const cap = captain != null && ids.includes(captain) ? captain : ids[0] ?? null;
    const vc = vice != null && ids.includes(vice) && vice !== cap ? vice : ids.find((id) => id !== cap) ?? null;
    setCaptainId(cap);
    setViceId(vc);
    setError(null);
  };
  const toggle = (id: number) => (picked.includes(id) ? setSquad(picked.filter((x) => x !== id), captainId, viceId) : setSquad([...picked, id], captainId, viceId));

  const blockedReason = (p: CatalogPlayer): string | null => {
    if (picked.includes(p.id)) return null;
    if (picked.length >= SQUAD_SIZE) return 'XI full';
    if (counts[p.position] >= POSITION_LIMITS[p.position].max) return `Max ${POSITION_LIMITS[p.position].max}`;
    if ((clubCounts.get(p.teamId) ?? 0) >= MAX_PER_CLUB) return `${MAX_PER_CLUB}/club`;
    return null;
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.players ?? [])
      .filter((p) => filter === 'ALL' || p.position === filter)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (clubs.get(p.teamId) ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.cost - a.cost);
  }, [catalog, filter, query, clubs]);

  const importXi = (xi: SquadPick) => {
    const available = xi.playerIds.filter((id) => pool.has(id));
    const dropped = xi.playerIds.length - available.length;
    setSquad(available, xi.captainId, xi.viceCaptainId);
    setView('xi');
    setNotice(dropped > 0
      ? `Imported ${available.length} players — ${dropped} ${dropped === 1 ? 'is' : 'are'} no longer available, pick replacements.`
      : 'Imported your FPL starting XI — check the budget and club limits before confirming.');
  };

  const submit = async () => {
    if (issues.length > 0 || submitting || currencyMismatch) return;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/fantasy-league/leagues/${encodeURIComponent(league.leagueId)}/join`, { body: pick, auth: true });
      if (account) setBalance(account.balanceMinor - league.entryFeeMinor);
      void refresh();
      onJoined();
    } catch (err) {
      if (!(err instanceof ApiError)) { setError({ text: 'Something went wrong — please try again.' }); return; }
      setError(err.code === 'INSUFFICIENT_FUNDS' ? { text: 'Your balance is too low for this entry fee.', deposit: true }
        : err.code === 'ALREADY_JOINED' ? { text: 'You have already entered this league.' }
        : err.code === 'LEAGUE_LOCKED' ? { text: 'This league has passed its deadline.' }
        : { text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const grouped = POSITIONS.map((pos) => ({ pos, players: picked.map((id) => pool.get(id)).filter((p): p is CatalogPlayer => p?.position === pos) }));

  const poolPanel = (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-col gap-3 pb-3">
        <Tabs size="sm" items={[{ key: 'ALL', label: 'All' }, ...POSITIONS.map((p) => ({ key: p, label: p }))] as ReadonlyArray<{ key: Position | 'ALL'; label: string }>}
          value={filter} onChange={setFilter} />
        <Field label="Search" placeholder="Player or club, e.g. Saka, ARS" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <ul className="sb-scroll max-h-[48vh] divide-y divide-sb-line overflow-y-auto rounded-lg border border-sb-line lg:max-h-[56vh]">
        {visible.map((p) => {
          const isPicked = picked.includes(p.id);
          const blocked = blockedReason(p);
          return (
            <li key={p.id} className={`flex items-center gap-2.5 px-3 py-2 ${isPicked ? 'bg-sb-primary/10' : ''}`}>
              <PositionTag position={p.position} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{p.name}</div>
                <div className="flex gap-1.5 text-[12px] text-sb-muted">
                  <span>{clubs.get(p.teamId)}</span>
                  {STATUS_LABEL[p.status] && <span className="text-sb-pending" title={p.news}>· {STATUS_LABEL[p.status]}</span>}
                </div>
              </div>
              <span className="w-14 shrink-0 text-right text-[13px] font-semibold sb-tabular">{formatMillions(p.cost)}</span>
              <button type="button" disabled={!!blocked} title={blocked ?? undefined} onClick={() => toggle(p.id)}
                className={`h-8 w-[72px] shrink-0 rounded-full text-[13px] font-semibold disabled:opacity-40 ${isPicked ? 'border border-sb-error text-sb-error' : 'bg-sb-primary text-white'}`}>
                {isPicked ? 'Remove' : blocked ?? 'Add'}
              </button>
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-4 py-10 text-center text-[14px] text-sb-muted">No players match.</li>}
      </ul>
    </div>
  );

  const xiPanel = (
    <div className="flex flex-col gap-3">
      <FplLinkPanel onImport={importXi} />
      <div>
        <div className="flex items-baseline justify-between text-[14px]">
          <span className="font-semibold">{picked.length} / {SQUAD_SIZE} players</span>
          <span className={`sb-tabular ${spent > BUDGET_TENTHS ? 'text-sb-error' : 'text-sb-muted'}`}>{formatMillions(spent)} / {formatMillions(BUDGET_TENTHS)}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-sb-surface2">
          <div className={`h-full rounded-full ${spent > BUDGET_TENTHS ? 'bg-sb-error' : 'bg-sb-primary'}`} style={{ width: `${Math.min(100, (spent / BUDGET_TENTHS) * 100)}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[12px] text-sb-muted sb-tabular">
          {POSITIONS.map((pos) => {
            const { min, max } = POSITION_LIMITS[pos];
            return <span key={pos} className={counts[pos] >= min && counts[pos] <= max ? 'font-semibold text-sb-success' : ''}>{pos} {counts[pos]}/{min === max ? min : `${min}–${max}`}</span>;
          })}
        </div>
      </div>
      {notice && <p className="rounded-md bg-sb-surface2 px-3 py-2 text-[13px] text-sb-muted">{notice}</p>}
      <div className="sb-scroll max-h-[34vh] overflow-y-auto lg:max-h-[40vh]">
        {picked.length === 0 ? (
          <p className="py-6 text-center text-[14px] text-sb-muted">Add players from the list, or import your FPL team.</p>
        ) : grouped.map(({ pos, players }) => players.map((p) => (
          <div key={p.id} className="flex items-center gap-2 py-1.5">
            <PositionTag position={pos} />
            <span className="min-w-0 flex-1 truncate text-[14px]">{p.name}</span>
            <button type="button" title="Captain (2× points)" aria-pressed={captainId === p.id}
              onClick={() => setSquad(picked, p.id, viceId === p.id ? captainId : viceId)}
              className={`h-7 w-7 rounded-full text-[12px] font-bold ${captainId === p.id ? 'bg-sb-primary text-white' : 'border border-sb-line text-sb-muted hover:text-sb-text'}`}>C</button>
            <button type="button" title="Vice-captain" aria-pressed={viceId === p.id}
              onClick={() => setSquad(picked, captainId === p.id ? viceId : captainId, p.id)}
              className={`h-7 w-7 rounded-full text-[12px] font-bold ${viceId === p.id ? 'bg-sb-text text-sb-bg' : 'border border-sb-line text-sb-muted hover:text-sb-text'}`}>V</button>
            <button type="button" onClick={() => toggle(p.id)} aria-label={`Remove ${p.name}`}
              className="grid h-7 w-7 place-items-center rounded-full text-sb-muted hover:text-sb-error"><Close className="h-4 w-4" /></button>
          </div>
        )))}
      </div>
    </div>
  );

  return (
    <Modal onClose={onClose} width="max-w-[1080px]" showLogo={false} padded={false} labelledBy="sb-xi-title">
      <div className="px-4 pb-5 pt-5 sm:px-8">
        <h2 id="sb-xi-title" className="pr-10 font-sb-display text-[26px] leading-tight">Pick your XI — {league.name}</h2>
        <p className="mt-1 text-[14px] text-sb-muted">
          {SQUAD_SIZE} players · {formatMillions(BUDGET_TENTHS)} budget · max {MAX_PER_CLUB} per club · captain scores double
        </p>
        {!catalog ? (
          <div className="grid place-items-center py-20"><Spinner className="h-8 w-8 text-sb-primary" /></div>
        ) : (
          <>
            <div className="mt-4 lg:hidden">
              <Tabs items={[{ key: 'pool', label: 'Players' }, { key: 'xi', label: `Your XI (${picked.length})` }] as const} value={view} onChange={setView} />
            </div>
            <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className={view === 'pool' ? '' : 'hidden lg:block'}>{poolPanel}</div>
              <div className={view === 'xi' ? '' : 'hidden lg:block'}>{xiPanel}</div>
            </div>
            <div className="mt-5 border-t border-sb-line pt-4">
              {currencyMismatch ? <ErrorNote>This league is played in {league.currency}; your account is in {account?.currency}.</ErrorNote>
                : picked.length === SQUAD_SIZE && issues.length > 0 ? <ul className="space-y-1 text-[13px] text-sb-error">{issues.map((i) => <li key={i}>· {i}</li>)}</ul> : null}
              {error && (
                <div className="mt-2">
                  <ErrorNote>{error.text}</ErrorNote>
                  {error.deposit && <Button size="sm" variant="outline" className="mt-2" onClick={() => openModal('deposit')}>Deposit</Button>}
                </div>
              )}
              <div className="mt-3 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
                <p className="text-[13px] text-sb-muted">Entry fee is charged when you confirm. Locks {new Date(league.deadline).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
                <Button size="lg" busy={submitting} disabled={issues.length > 0 || currencyMismatch} onClick={submit} className="w-full sm:w-auto">
                  Confirm XI · {moneyShort(league.entryFeeMinor, league.currency)}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function FplLinkPanel({ onImport }: { onImport: (xi: SquadPick) => void }) {
  const [link, setLink] = useState<FplLink | null | undefined>(undefined);
  const [entryId, setEntryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ link: FplLink | null }>('/api/fantasy-league/fpl-link', { auth: true }).then((r) => setLink(r.link)).catch(() => setLink(null));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong.'); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-sb-line p-3">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-sb-muted">Your FPL team</p>
      {link === undefined ? <div className="mt-2 h-10 animate-pulse rounded bg-sb-surface2" />
        : link ? (
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">{link.teamName}</p>
              <p className="truncate text-[12px] text-sb-muted">{link.managerName} · ID {link.entryId}</p>
            </div>
            <Button size="sm" busy={busy} onClick={() => run(async () => onImport(await api<SquadPick>('/api/fantasy-league/fpl-link/xi', { auth: true })))}>Import XI</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await api('/api/fantasy-league/fpl-link', { method: 'DELETE', auth: true }); setLink(null); })}>Unlink</Button>
          </div>
        ) : (
          <>
            <div className="mt-2 flex items-end gap-2">
              <Field label="FPL Team ID" className="flex-1" inputMode="numeric" placeholder="e.g. 1234567" value={entryId}
                onChange={(e) => setEntryId(e.target.value.replace(/\D/g, ''))} />
              <Button variant="outline" busy={busy} disabled={!entryId}
                onClick={() => run(async () => { const r = await api<{ link: FplLink }>('/api/fantasy-league/fpl-link', { method: 'PUT', body: { entryId: Number(entryId) }, auth: true }); setLink(r.link); setEntryId(''); })}>
                Link
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-sb-muted">Find it in your FPL Points page URL: fantasy.premierleague.com/entry/<b>1234567</b>/event/…</p>
          </>
        )}
      {error && <p className="mt-2 text-[13px] text-sb-error">{error}</p>}
    </div>
  );
}
