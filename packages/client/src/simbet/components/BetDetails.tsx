import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { describePick, gameCode, marketLabel } from '../matches/data';
import { Badge, Empty, Modal, Spinner } from './ui';

/** A settled Simulated Matches bet, as POST /api/simulate/bets and GET /api/account/bets/:id return it. */
export interface SimBetView {
  betId: string;
  mode: 'single' | 'multi';
  currency?: string;
  stakeMinor: number;
  totalOdds: number;
  won: boolean;
  payoutMinor: number;
  createdAt: string;
  legs: Array<{
    eventId: string;
    league: string | null;
    home: string | null;
    away: string | null;
    kickoff: string | null;
    market: string;
    pick: string;
    odds: number;
    won: boolean;
    score: { home: number; away: number } | null;
  }>;
  fair: { serverSeed: string; commit: string; nonce: string; rtp: number };
}

/** The design's bet-details body: summary strip, then one card per match. */
export function BetDetailsBody({ bet, currency = bet.currency ?? 'KES' }: { bet: SimBetView; currency?: string }) {
  const [fairOpen, setFairOpen] = useState(false);
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-sb-line">
        <div className="flex items-center justify-between bg-sb-surface2 px-4 py-2 text-[14px]">
          <span className="font-medium">{bet.mode === 'multi' ? 'Multi Bet' : 'Single Bet'}</span>
          <Badge tone={bet.won ? 'won' : 'lost'}>{bet.won ? 'Won' : 'Lost'}</Badge>
        </div>
        <dl className="grid grid-cols-3 gap-2 px-4 py-3 text-[14px]">
          <div><dt className="text-sb-muted">Total Odds</dt><dd className="font-semibold sb-tabular">{bet.totalOdds.toFixed(2)}</dd></div>
          <div className="text-center"><dt className="text-sb-muted">Bet Amount</dt><dd className="font-semibold sb-tabular">{money(bet.stakeMinor, currency)}</dd></div>
          <div className="text-right">
            <dt className="text-sb-muted">{bet.won ? 'Won' : 'Est. Win'}</dt>
            <dd className={`font-semibold sb-tabular ${bet.won ? 'text-sb-success' : ''}`}>
              {money(bet.won ? bet.payoutMinor : Math.floor(bet.stakeMinor * bet.totalOdds), currency)}
            </dd>
          </div>
        </dl>
      </div>

      <ol className="mt-3 flex flex-col gap-3">
        {bet.legs.map((leg, i) => (
          <li key={`${leg.eventId}-${i}`} className="rounded-lg border border-sb-line p-3 sm:p-4">
            <div className="flex items-center gap-3 text-[13px]">
              <span className="text-sb-muted">{i + 1}</span>
              {leg.kickoff && <span className="sb-tabular text-sb-muted">{dateTime(leg.kickoff).slice(0, 5)} {dateTime(leg.kickoff).slice(11)}</span>}
              <span className="font-semibold">Game ID: {gameCode(leg.eventId)}</span>
              <span className="ml-auto"><Badge tone={leg.won ? 'won' : 'lost'}>{leg.won ? 'Won' : 'Lost'}</Badge></span>
            </div>
            <p className="mt-2 text-[15px]">{leg.home ?? 'Home'} vs {leg.away ?? 'Away'}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-sb-surface2 px-3 py-2 text-[13px]">
              <div><dt className="text-sb-muted">Pick</dt><dd className="font-semibold">{describePick(leg.market, leg.pick, leg.home, leg.away)} @{leg.odds.toFixed(2)}</dd></div>
              <div className="text-center"><dt className="text-sb-muted">Market</dt><dd className="font-semibold">{marketLabel(leg.market)}</dd></div>
              <div className="text-right"><dt className="text-sb-muted">Result</dt><dd className="font-semibold sb-tabular">{leg.score ? `${leg.score.home} - ${leg.score.away}` : '—'}</dd></div>
            </dl>
          </li>
        ))}
      </ol>

      <button type="button" onClick={() => setFairOpen((o) => !o)} className="mt-4 text-[13px] font-semibold text-sb-accent hover:underline">
        {fairOpen ? 'Hide' : 'Show'} provably-fair proof
      </button>
      {fairOpen && (
        <div className="mt-2 space-y-1 break-all rounded-md bg-sb-surface2 p-3 text-[12px] text-sb-muted">
          <div><span className="font-semibold text-sb-text">Commit</span> {bet.fair.commit}</div>
          <div><span className="font-semibold text-sb-text">Server seed</span> {bet.fair.serverSeed}</div>
          <div><span className="font-semibold text-sb-text">Nonce</span> {bet.fair.nonce}</div>
          <p className="pt-1">
            The commit is SHA-256 of the server seed, fixed before the result. Each match is decided by
            HMAC-SHA256(seed, nonce:leg:eventId:pick) at {Math.round(bet.fair.rtp * 100)}% return to player.
          </p>
        </div>
      )}
    </div>
  );
}

/** Bet details for a bet id, loaded from the player's history. */
export function BetDetailsModal({ betId, onClose }: { betId: string; onClose: () => void }) {
  const [bet, setBet] = useState<SimBetView | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    api<SimBetView>(`/api/account/bets/${encodeURIComponent(betId)}`, { auth: true }).then(setBet).catch(() => setError(true));
  }, [betId]);
  return (
    <Modal onClose={onClose} width="max-w-[800px]" labelledBy="sb-bet-title">
      <div className="mb-5 text-center">
        <h2 id="sb-bet-title" className="font-sb-display text-[26px]">{betId}</h2>
        {bet && <p className="text-[14px] text-sb-muted sb-tabular">{dateTime(bet.createdAt)}</p>}
      </div>
      {error ? <Empty title="Couldn’t load this bet" body="Please try again in a moment." />
        : bet ? <BetDetailsBody bet={bet} /> : <div className="grid place-items-center py-16"><Spinner className="h-8 w-8 text-sb-primary" /></div>}
    </Modal>
  );
}
