import { randomInt } from 'node:crypto';
import type { Pool, PoolClient } from './pg.js';
import type { WalletLedger } from './wallet-ledger.js';

// ---------------------------------------------------------------------------
// Real-money Simulated Matches bets. Each bet is resolved by the provably-fair
// engine before it reaches here; this repo records it and moves the money:
// stake debit, bet + legs rows and any win credit commit together or not at all.
// ---------------------------------------------------------------------------

export type SimBetMode = 'single' | 'multi';

export interface SimBetLeg {
  eventId: string;
  league: string | null;
  home: string | null;
  away: string | null;
  kickoff: string | null;
  market: string;
  pick: string;
  label: string | null;
  odds: number;
  won: boolean;
  score: { home: number; away: number } | null;
  goalRates: unknown;
  timeline: unknown;
}

export interface SimBetInput {
  mode: SimBetMode;
  stakeMinor: number;
  totalOdds: number;
  won: boolean;
  payoutMinor: number;
  serverSeed: string;
  commit: string;
  nonce: string;
  rtp: number;
  legs: SimBetLeg[];
}

export interface SimBet extends SimBetInput {
  betId: string;
  currency: string;
  createdAt: string;
}

interface BetRow {
  bet_id: string;
  mode: string;
  currency: string;
  stake_minor: string;
  total_odds: number;
  won: boolean;
  payout_minor: string;
  server_seed: string;
  commit: string;
  nonce: string;
  rtp: number;
  created_at: Date;
}

interface LegRow {
  bet_id: string;
  idx: number;
  event_id: string;
  league: string | null;
  home: string | null;
  away: string | null;
  kickoff: Date | null;
  market: string;
  pick: string;
  label: string | null;
  odds: number;
  won: boolean;
  score_home: number | null;
  score_away: number | null;
  goal_rates: unknown;
  timeline: unknown;
}

export function rowToLeg(r: LegRow): SimBetLeg {
  return {
    eventId: r.event_id,
    league: r.league,
    home: r.home,
    away: r.away,
    kickoff: r.kickoff?.toISOString() ?? null,
    market: r.market,
    pick: r.pick,
    label: r.label,
    odds: r.odds,
    won: r.won,
    score: r.score_home == null || r.score_away == null ? null : { home: r.score_home, away: r.score_away },
    goalRates: r.goal_rates,
    timeline: r.timeline,
  };
}

function rowToBet(r: BetRow, legs: SimBetLeg[]): SimBet {
  return {
    betId: r.bet_id,
    mode: r.mode as SimBetMode,
    currency: r.currency,
    stakeMinor: Number(r.stake_minor),
    totalOdds: r.total_odds,
    won: r.won,
    payoutMinor: Number(r.payout_minor),
    serverSeed: r.server_seed,
    commit: r.commit,
    nonce: r.nonce,
    rtp: r.rtp,
    createdAt: r.created_at.toISOString(),
    legs,
  };
}

/** Player-facing bet reference, e.g. SIM2894245. */
const newBetId = (): string => `SIM${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;

export class PgSimBetsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly wallet: WalletLedger,
  ) {}

  /**
   * Record already-resolved bets and settle them. Throws InsufficientFundsError
   * (nothing is written) if the player can't cover every stake.
   */
  async place(playerId: string, currency: string, bets: SimBetInput[]): Promise<{ bets: SimBet[]; balanceMinor: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const placed: SimBet[] = [];
      for (const bet of bets) {
        const { betId, createdAt } = await this.insertBet(client, playerId, currency, bet);
        await this.wallet.betInTx(client, playerId, bet.stakeMinor, `sim-bet:${betId}`, currency);
        if (bet.payoutMinor > 0) {
          await this.wallet.creditInTx(client, playerId, bet.payoutMinor, 'win', `sim-win:${betId}`, currency);
        }
        placed.push({ ...bet, betId, currency, createdAt });
      }
      const { rows } = await client.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS balance FROM wallet_ledger WHERE player_id = $1 AND currency = $2`,
        [playerId, currency],
      );
      await client.query('COMMIT');
      return { bets: placed, balanceMinor: Number(rows[0]!.balance) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already aborted */ });
      throw err;
    } finally {
      client.release();
    }
  }

  async get(playerId: string, betId: string): Promise<SimBet | null> {
    const { rows } = await this.pool.query<BetRow>(
      `SELECT * FROM sim_bets WHERE bet_id = $1 AND player_id = $2`,
      [betId, playerId],
    );
    if (!rows[0]) return null;
    const legs = await this.pool.query<LegRow>(`SELECT * FROM sim_bet_legs WHERE bet_id = $1 ORDER BY idx`, [betId]);
    return rowToBet(rows[0], legs.rows.map(rowToLeg));
  }

  private async insertBet(client: PoolClient, playerId: string, currency: string, bet: SimBetInput): Promise<{ betId: string; createdAt: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const betId = newBetId();
      const { rows } = await client.query<{ created_at: Date }>(
        `INSERT INTO sim_bets (bet_id, player_id, mode, currency, stake_minor, total_odds, won, payout_minor, server_seed, commit, nonce, rtp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (bet_id) DO NOTHING RETURNING created_at`,
        [betId, playerId, bet.mode, currency, bet.stakeMinor, bet.totalOdds, bet.won, bet.payoutMinor, bet.serverSeed, bet.commit, bet.nonce, bet.rtp],
      );
      if (!rows[0]) continue; // id collision — draw another
      for (const [idx, leg] of bet.legs.entries()) {
        await client.query(
          `INSERT INTO sim_bet_legs (bet_id, idx, event_id, league, home, away, kickoff, market, pick, label, odds, won, score_home, score_away, goal_rates, timeline)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            betId, idx, leg.eventId, leg.league, leg.home, leg.away, leg.kickoff, leg.market, leg.pick, leg.label, leg.odds, leg.won,
            leg.score?.home ?? null, leg.score?.away ?? null,
            leg.goalRates == null ? null : JSON.stringify(leg.goalRates),
            leg.timeline == null ? null : JSON.stringify(leg.timeline),
          ],
        );
      }
      return { betId, createdAt: rows[0].created_at.toISOString() };
    }
    throw new Error('could not allocate a unique bet id');
  }
}
