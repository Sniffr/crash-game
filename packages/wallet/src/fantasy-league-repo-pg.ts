import type { Pool } from './pg.js';
import type { WalletLedger } from './wallet-ledger.js';
import {
  MIN_ENTRANTS,
  payouts,
  rankByPoints,
  splitPool,
  squadPoints,
  type LivePlayerPoints,
  type SquadPick,
} from '@crash/shared/fantasy';
import {
  AlreadyJoinedError,
  LeagueLockedError,
  LeagueNotFoundError,
  type FantasyEntry,
  type FantasyLeague,
  type FplLink,
  type LeagueTemplate,
  type SettlementOutcome,
} from './fantasy-league-repo.js';

interface LeagueRow {
  league_id: string;
  name: string;
  blurb: string;
  gameweek: number;
  deadline: Date;
  entry_fee_minor: string;
  currency: string;
  rake_bps: number;
  payout_bps: number[];
  status: string;
  pool_minor: string | null;
  rake_minor: string | null;
  settled_at: Date | null;
  member_count: string;
}

interface EntryRow {
  league_id: string;
  player_id: string;
  username: string;
  player_ids: number[];
  captain_id: number;
  vice_captain_id: number;
  points: number | null;
  final_rank: number | null;
  payout_minor: string | null;
  joined_at: Date;
}

const LEAGUE_SELECT = `
  SELECT l.*, (SELECT count(*) FROM fantasy_league_members m WHERE m.league_id = l.league_id)::text AS member_count
  FROM fantasy_leagues l`;

const ENTRY_SELECT = `
  SELECT m.*, p.username
  FROM fantasy_league_members m
  JOIN players p ON p.player_id = m.player_id`;

function rowToLeague(r: LeagueRow): FantasyLeague {
  return {
    leagueId: r.league_id,
    name: r.name,
    blurb: r.blurb,
    gameweek: r.gameweek,
    deadline: r.deadline.toISOString(),
    entryFeeMinor: Number(r.entry_fee_minor),
    currency: r.currency,
    rakeBps: r.rake_bps,
    payoutBps: r.payout_bps,
    status: r.status as FantasyLeague['status'],
    poolMinor: r.pool_minor == null ? null : Number(r.pool_minor),
    rakeMinor: r.rake_minor == null ? null : Number(r.rake_minor),
    settledAt: r.settled_at ? r.settled_at.toISOString() : null,
    memberCount: Number(r.member_count),
  };
}

function rowToEntry(r: EntryRow): FantasyEntry {
  return {
    leagueId: r.league_id,
    playerId: r.player_id,
    username: r.username,
    squad: { playerIds: r.player_ids, captainId: r.captain_id, viceCaptainId: r.vice_captain_id },
    points: r.points,
    finalRank: r.final_rank,
    payoutMinor: r.payout_minor == null ? null : Number(r.payout_minor),
    joinedAt: r.joined_at.toISOString(),
  };
}

const PG_UNIQUE_VIOLATION = '23505';

export class PgFantasyLeagueRepo {
  constructor(
    private readonly pool: Pool,
    private readonly wallet: WalletLedger,
  ) {}

  /** Leagues for the three most recent gameweeks, newest first. */
  async listRecent(): Promise<FantasyLeague[]> {
    const { rows } = await this.pool.query<LeagueRow>(
      `${LEAGUE_SELECT}
       WHERE l.gameweek >= (SELECT coalesce(max(gameweek), 0) FROM fantasy_leagues) - 2
       ORDER BY l.gameweek DESC, l.entry_fee_minor ASC, l.league_id ASC`,
    );
    return rows.map(rowToLeague);
  }

  async listOpen(): Promise<FantasyLeague[]> {
    const { rows } = await this.pool.query<LeagueRow>(`${LEAGUE_SELECT} WHERE l.status = 'open' ORDER BY l.gameweek`);
    return rows.map(rowToLeague);
  }

  async getById(leagueId: string): Promise<FantasyLeague | null> {
    const { rows } = await this.pool.query<LeagueRow>(`${LEAGUE_SELECT} WHERE l.league_id = $1`, [leagueId]);
    return rows[0] ? rowToLeague(rows[0]) : null;
  }

  /**
   * Idempotently create this gameweek's league from each template, and follow
   * FPL if it moves the deadline of a still-open one. Returns how many were new.
   */
  async ensureLeagues(templates: readonly LeagueTemplate[], gameweek: number, deadlineIso: string): Promise<number> {
    let created = 0;
    for (const t of templates) {
      const { rows } = await this.pool.query<{ inserted: boolean }>(
        `INSERT INTO fantasy_leagues (league_id, name, blurb, gameweek, deadline, entry_fee_minor, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (league_id) DO UPDATE SET deadline = EXCLUDED.deadline
           WHERE fantasy_leagues.status = 'open' AND fantasy_leagues.deadline <> EXCLUDED.deadline
         RETURNING (xmax = 0) AS inserted`,
        [`${t.templateId}-gw${gameweek}`, t.name, t.blurb, gameweek, deadlineIso, t.entryFeeMinor, t.currency],
      );
      if (rows[0]?.inserted) created += 1;
    }
    return created;
  }

  /** Every entry, final standings first (settled leagues), then by join order. */
  async entries(leagueId: string): Promise<FantasyEntry[]> {
    const { rows } = await this.pool.query<EntryRow>(
      `${ENTRY_SELECT} WHERE m.league_id = $1 ORDER BY m.final_rank ASC NULLS LAST, m.joined_at ASC, m.player_id ASC`,
      [leagueId],
    );
    return rows.map(rowToEntry);
  }

  async joinedLeagueIds(playerId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ league_id: string }>(
      `SELECT league_id FROM fantasy_league_members WHERE player_id = $1`,
      [playerId],
    );
    return rows.map((r) => r.league_id);
  }

  async getEntry(leagueId: string, playerId: string): Promise<FantasyEntry | null> {
    const { rows } = await this.pool.query<EntryRow>(`${ENTRY_SELECT} WHERE m.league_id = $1 AND m.player_id = $2`, [leagueId, playerId]);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  /**
   * Enter a league: membership insert and entry-fee debit commit together or
   * not at all. The squad must already be validated against the live catalog.
   * Throws LeagueNotFoundError, LeagueLockedError, AlreadyJoinedError,
   * InsufficientFundsError.
   */
  async join(leagueId: string, playerId: string, squad: SquadPick, nowMs = Date.now()): Promise<{ entry: FantasyEntry; balanceMinor: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // FOR SHARE blocks a concurrent settle() from finalising mid-join.
      const { rows } = await client.query<LeagueRow>(
        `SELECT l.*, '0' AS member_count FROM fantasy_leagues l WHERE l.league_id = $1 FOR SHARE`,
        [leagueId],
      );
      const league = rows[0] ? rowToLeague(rows[0]) : null;
      if (!league) throw new LeagueNotFoundError(leagueId);
      if (league.status !== 'open' || Date.parse(league.deadline) <= nowMs) throw new LeagueLockedError(leagueId);

      try {
        await client.query(
          `INSERT INTO fantasy_league_members (league_id, player_id, player_ids, captain_id, vice_captain_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [leagueId, playerId, squad.playerIds, squad.captainId, squad.viceCaptainId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) throw new AlreadyJoinedError(leagueId, playerId);
        throw err;
      }

      const balanceMinor = await this.wallet.betInTx(
        client, playerId, league.entryFeeMinor, `fantasy-entry:${leagueId}:${playerId}`, league.currency,
      );
      await client.query('COMMIT');
      return { entry: (await this.getEntry(leagueId, playerId))!, balanceMinor };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already aborted */ });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Finalise a league exactly once from the gameweek's official points:
   * rank everyone, take the rake, split the prize pool, credit winners. With
   * fewer than MIN_ENTRANTS it's cancelled and entry fees are refunded.
   * A second call is a no-op ('already-final').
   */
  async settle(leagueId: string, live: ReadonlyMap<number, LivePlayerPoints>): Promise<SettlementOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<LeagueRow>(
        `SELECT l.*, '0' AS member_count FROM fantasy_leagues l WHERE l.league_id = $1 FOR UPDATE`,
        [leagueId],
      );
      if (!rows[0]) throw new LeagueNotFoundError(leagueId);
      const league = rowToLeague(rows[0]);
      if (league.status !== 'open') {
        await client.query('ROLLBACK');
        return { leagueId, status: 'already-final', entrants: 0, poolMinor: league.poolMinor ?? 0, rakeMinor: league.rakeMinor ?? 0, paidMinor: 0 };
      }

      const { rows: memberRows } = await client.query<EntryRow>(
        `${ENTRY_SELECT} WHERE m.league_id = $1 ORDER BY m.joined_at ASC, m.player_id ASC`,
        [leagueId],
      );
      const entries = memberRows.map(rowToEntry);

      if (entries.length < MIN_ENTRANTS) {
        for (const e of entries) {
          await this.wallet.creditInTx(client, e.playerId, league.entryFeeMinor, 'adjust', `fantasy-refund:${leagueId}:${e.playerId}`, league.currency);
        }
        await client.query(
          `UPDATE fantasy_leagues SET status = 'cancelled', pool_minor = 0, rake_minor = 0, settled_at = now() WHERE league_id = $1`,
          [leagueId],
        );
        await client.query('COMMIT');
        return { leagueId, status: 'cancelled', entrants: entries.length, poolMinor: 0, rakeMinor: 0, paidMinor: 0 };
      }

      const ranked = rankByPoints(entries.map((e) => ({ key: e.playerId, points: squadPoints(e.squad, live) })));
      const split = splitPool(league.entryFeeMinor, entries.length, league.rakeBps);
      const { byKey, dustMinor } = payouts(ranked, split.prizePoolMinor, league.payoutBps);

      await client.query(
        `UPDATE fantasy_league_members m
         SET points = u.points, final_rank = u.rank, payout_minor = u.payout
         FROM unnest($2::uuid[], $3::int[], $4::int[], $5::bigint[]) AS u(player_id, points, rank, payout)
         WHERE m.league_id = $1 AND m.player_id = u.player_id`,
        [leagueId, ranked.map((r) => r.key), ranked.map((r) => r.points), ranked.map((r) => r.rank), ranked.map((r) => byKey.get(r.key) ?? 0)],
      );

      let paidMinor = 0;
      for (const [playerId, amount] of byKey) {
        if (amount <= 0) continue;
        await this.wallet.creditInTx(client, playerId, amount, 'win', `fantasy-payout:${leagueId}:${playerId}`, league.currency);
        paidMinor += amount;
      }

      // Rounding dust stays with the house alongside the rake.
      const rakeMinor = split.rakeMinor + dustMinor;
      await client.query(
        `UPDATE fantasy_leagues SET status = 'settled', pool_minor = $2, rake_minor = $3, settled_at = now() WHERE league_id = $1`,
        [leagueId, split.poolMinor, rakeMinor],
      );
      await client.query('COMMIT');
      return { leagueId, status: 'settled', entrants: entries.length, poolMinor: split.poolMinor, rakeMinor, paidMinor };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already aborted */ });
      throw err;
    } finally {
      client.release();
    }
  }

  async getFplLink(playerId: string): Promise<FplLink | null> {
    const { rows } = await this.pool.query<{ entry_id: number; team_name: string; manager_name: string; linked_at: Date }>(
      `SELECT entry_id, team_name, manager_name, linked_at FROM fantasy_fpl_links WHERE player_id = $1`,
      [playerId],
    );
    const r = rows[0];
    return r ? { entryId: r.entry_id, teamName: r.team_name, managerName: r.manager_name, linkedAt: r.linked_at.toISOString() } : null;
  }

  async setFplLink(playerId: string, link: Omit<FplLink, 'linkedAt'>): Promise<FplLink> {
    const { rows } = await this.pool.query<{ linked_at: Date }>(
      `INSERT INTO fantasy_fpl_links (player_id, entry_id, team_name, manager_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (player_id) DO UPDATE
         SET entry_id = EXCLUDED.entry_id, team_name = EXCLUDED.team_name,
             manager_name = EXCLUDED.manager_name, linked_at = now()
       RETURNING linked_at`,
      [playerId, link.entryId, link.teamName, link.managerName],
    );
    return { ...link, linkedAt: rows[0]!.linked_at.toISOString() };
  }

  async deleteFplLink(playerId: string): Promise<void> {
    await this.pool.query(`DELETE FROM fantasy_fpl_links WHERE player_id = $1`, [playerId]);
  }
}
