import { createHash } from 'node:crypto';
import type { Pool } from './pg.js';
import { rowToLeg, type SimBetLeg } from './sim-bets-repo-pg.js';

// ---------------------------------------------------------------------------
// Read models for a player's Bet History (simulated bets + fantasy entries)
// and Transactions (deposits + withdrawals). Both are paged newest-first.
// ---------------------------------------------------------------------------

export interface Page {
  page: number;
  pageSize: number;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

export type HistoryStatus = 'active' | 'won' | 'lost' | 'cancelled';

export interface HistoryBet {
  id: string;
  kind: 'sim' | 'fantasy';
  type: 'single' | 'multi' | 'fantasy';
  placedAt: string;
  status: HistoryStatus;
  currency: string;
  stakeMinor: number;
  /** What a win pays: the actual payout once won, else stake × odds (sim) or null (fantasy). */
  potentialWinMinor: number | null;
  payoutMinor: number | null;
  totalOdds: number | null;
  legs: SimBetLeg[];
  fantasy: { leagueId: string; name: string; gameweek: number; rank: number | null; points: number | null } | null;
}

export type TxnType = 'deposit' | 'withdrawal';
export type TxnStatus = 'pending' | 'success' | 'failed';

export interface HistoryTxn {
  reference: string;
  displayId: string;
  type: TxnType;
  status: TxnStatus;
  amountMinor: number;
  currency: string;
  createdAt: string;
}

/** Short, stable, player-facing id for a long internal reference, e.g. SIM9203435. */
export function displayIdFor(reference: string): string {
  const n = parseInt(createHash('sha1').update(reference).digest('hex').slice(0, 8), 16) % 10_000_000;
  return `SIM${String(n).padStart(7, '0')}`;
}

function clampPage(p: Page): { limit: number; offset: number } {
  const pageSize = Math.min(Math.max(Math.floor(p.pageSize) || 20, 1), 50);
  const page = Math.max(Math.floor(p.page) || 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

function rangeSql(col: string, range: DateRange, params: unknown[]): string {
  let sql = '';
  if (range.from) { params.push(range.from); sql += ` AND ${col} >= $${params.length}`; }
  if (range.to) { params.push(range.to); sql += ` AND ${col} < $${params.length}`; }
  return sql;
}

export class PgPlayerHistory {
  constructor(private readonly pool: Pool) {}

  async bets(
    playerId: string,
    opts: { status: 'all' | 'active' | 'settled' } & DateRange & Page,
  ): Promise<{ items: HistoryBet[]; total: number }> {
    const { limit, offset } = clampPage(opts);
    // Simulated bets settle the moment they're placed, so they're never "active".
    const wantSim = opts.status !== 'active';
    const fantasyStatus = opts.status === 'active' ? `AND l.status = 'open'` : opts.status === 'settled' ? `AND l.status <> 'open'` : '';

    const simParams: unknown[] = [playerId];
    const simWhere = `WHERE b.player_id = $1${rangeSql('b.created_at', opts, simParams)}`;
    const fanParams: unknown[] = [playerId];
    const fanWhere = `WHERE m.player_id = $1 ${fantasyStatus}${rangeSql('m.joined_at', opts, fanParams)}`;

    const [simRows, simCount, fanRows, fanCount] = await Promise.all([
      wantSim
        ? this.pool.query(`SELECT b.* FROM sim_bets b ${simWhere} ORDER BY b.created_at DESC LIMIT ${limit + offset}`, simParams)
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      wantSim
        ? this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sim_bets b ${simWhere}`, simParams)
        : Promise.resolve({ rows: [{ n: '0' }] }),
      this.pool.query(
        `SELECT m.*, l.name, l.gameweek, l.status AS league_status, l.entry_fee_minor, l.currency
         FROM fantasy_league_members m JOIN fantasy_leagues l ON l.league_id = m.league_id
         ${fanWhere} ORDER BY m.joined_at DESC LIMIT ${limit + offset}`,
        fanParams,
      ),
      this.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM fantasy_league_members m JOIN fantasy_leagues l ON l.league_id = m.league_id ${fanWhere}`,
        fanParams,
      ),
    ]);

    const sims: HistoryBet[] = simRows.rows.map((r) => {
      const stake = Number(r['stake_minor']);
      const odds = Number(r['total_odds']);
      const won = Boolean(r['won']);
      return {
        id: String(r['bet_id']),
        kind: 'sim',
        type: r['mode'] === 'multi' ? 'multi' : 'single',
        placedAt: (r['created_at'] as Date).toISOString(),
        status: won ? 'won' : 'lost',
        currency: String(r['currency']),
        stakeMinor: stake,
        potentialWinMinor: won ? Number(r['payout_minor']) : Math.floor(stake * odds),
        payoutMinor: Number(r['payout_minor']),
        totalOdds: odds,
        legs: [],
        fantasy: null,
      };
    });

    const fantasy: HistoryBet[] = fanRows.rows.map((r) => {
      const leagueStatus = String(r['league_status']);
      const payout = r['payout_minor'] == null ? null : Number(r['payout_minor']);
      const status: HistoryStatus = leagueStatus === 'open' ? 'active'
        : leagueStatus === 'cancelled' ? 'cancelled'
        : (payout ?? 0) > 0 ? 'won' : 'lost';
      return {
        id: `${r['league_id']}:${r['player_id']}`,
        kind: 'fantasy',
        type: 'fantasy',
        placedAt: (r['joined_at'] as Date).toISOString(),
        status,
        currency: String(r['currency']),
        stakeMinor: Number(r['entry_fee_minor']),
        potentialWinMinor: payout,
        payoutMinor: payout,
        totalOdds: null,
        legs: [],
        fantasy: {
          leagueId: String(r['league_id']),
          name: String(r['name']),
          gameweek: Number(r['gameweek']),
          rank: r['final_rank'] == null ? null : Number(r['final_rank']),
          points: r['points'] == null ? null : Number(r['points']),
        },
      };
    });

    const page = [...sims, ...fantasy]
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .slice(offset, offset + limit);

    const simIds = page.filter((b) => b.kind === 'sim').map((b) => b.id);
    if (simIds.length > 0) {
      const legs = await this.pool.query(`SELECT * FROM sim_bet_legs WHERE bet_id = ANY($1) ORDER BY bet_id, idx`, [simIds]);
      const byBet = new Map<string, SimBetLeg[]>();
      for (const row of legs.rows) {
        const list = byBet.get(row.bet_id) ?? [];
        list.push(rowToLeg(row));
        byBet.set(row.bet_id, list);
      }
      for (const b of page) if (b.kind === 'sim') b.legs = byBet.get(b.id) ?? [];
    }

    return { items: page, total: Number(simCount.rows[0]!.n) + Number(fanCount.rows[0]!.n) };
  }

  async transactions(
    playerId: string,
    opts: { type: 'all' | TxnType } & DateRange & Page,
  ): Promise<{ items: HistoryTxn[]; total: number }> {
    const { limit, offset } = clampPage(opts);
    const params: unknown[] = [playerId];
    const range = (col: string) => rangeSql(col, opts, params);
    const parts: string[] = [];
    if (opts.type !== 'withdrawal') {
      parts.push(`SELECT reference, 'deposit' AS type,
                    CASE status WHEN 'settled' THEN 'success' ELSE status END AS status,
                    amount_minor, currency, created_at
                  FROM deposits WHERE player_id = $1${range('created_at')}`);
    }
    if (opts.type !== 'deposit') {
      parts.push(`SELECT reference, 'withdrawal' AS type,
                    CASE status WHEN 'processing' THEN 'pending' ELSE status END AS status,
                    amount_minor, currency, created_at
                  FROM withdrawals WHERE player_id = $1${range('created_at')}`);
    }
    const union = parts.join(' UNION ALL ');
    const [rows, count] = await Promise.all([
      this.pool.query(`SELECT * FROM (${union}) t ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${union}) t`, params),
    ]);
    return {
      items: rows.rows.map((r) => ({
        reference: String(r.reference),
        displayId: displayIdFor(String(r.reference)),
        type: r.type as TxnType,
        status: r.status as TxnStatus,
        amountMinor: Number(r.amount_minor),
        currency: String(r.currency),
        createdAt: (r.created_at as Date).toISOString(),
      })),
      total: Number(count.rows[0]!.n),
    };
  }
}
