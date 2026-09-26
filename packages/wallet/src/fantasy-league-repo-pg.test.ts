import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './pg-test-support.js';
import { PgFantasyLeagueRepo } from './fantasy-league-repo-pg.js';
import { WalletLedger, InsufficientFundsError } from './wallet-ledger.js';
import { AlreadyJoinedError, LeagueLockedError, LeagueNotFoundError, type LeagueTemplate } from './fantasy-league-repo.js';
import type { LivePlayerPoints, SquadPick } from '@crash/shared/fantasy';

const FEE = 5_000;
const TEMPLATE: LeagueTemplate = { templateId: 'test', name: 'Test League', blurb: '', entryFeeMinor: FEE, currency: 'KES' };
const LEAGUE = 'test-gw6';
const FUTURE = '2099-01-01T00:00:00.000Z';

/** Squads differ only in captain, so points (and ranks) are easy to control via live data. */
const squad = (captainId: number): SquadPick => ({
  playerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  captainId,
  viceCaptainId: captainId === 1 ? 2 : 1,
});

const live = (points: Record<number, number>): Map<number, LivePlayerPoints> =>
  new Map(Object.entries(points).map(([id, p]) => [Number(id), { points: p, minutes: 90 }]));

describe('PgFantasyLeagueRepo', () => {
  let db: TestDb;
  let wallet: WalletLedger;
  let repo: PgFantasyLeagueRepo;

  async function fundedPlayer(username: string, fundMinor = 100_000): Promise<string> {
    const { rows } = await db.pool.query<{ player_id: string }>(
      `INSERT INTO players (username, password_hash) VALUES ($1, 'hash') RETURNING player_id`,
      [username],
    );
    const id = rows[0]!.player_id;
    if (fundMinor > 0) await wallet.deposit(id, fundMinor, 'KES', `fund-${username}`);
    return id;
  }

  beforeEach(async () => {
    db = await makeTestDb();
    wallet = new WalletLedger(db.pool);
    repo = new PgFantasyLeagueRepo(db.pool, wallet);
    await repo.ensureLeagues([TEMPLATE], 6, FUTURE);
  });
  afterEach(async () => { await db.cleanup(); });

  it('ensureLeagues is idempotent per gameweek', async () => {
    expect(await repo.ensureLeagues([TEMPLATE], 6, FUTURE)).toBe(0);
    expect(await repo.ensureLeagues([TEMPLATE], 7, FUTURE)).toBe(1);
    const recent = await repo.listRecent();
    expect(recent.map((l) => l.leagueId)).toEqual(['test-gw7', 'test-gw6']);
    expect(recent[0]).toMatchObject({ gameweek: 7, rakeBps: 1000, payoutBps: [5000, 3000, 2000], status: 'open' });
  });

  describe('join', () => {
    it('stores the squad and debits the fee in one transaction', async () => {
      const p = await fundedPlayer('alice');
      const { entry, balanceMinor } = await repo.join(LEAGUE, p, squad(3));
      expect(entry.squad).toEqual(squad(3));
      expect(balanceMinor).toBe(100_000 - FEE);
      expect(await wallet.balance(p)).toBe(100_000 - FEE);
      expect((await repo.getById(LEAGUE))?.memberCount).toBe(1);
    });

    it('rejects a second entry without charging again', async () => {
      const p = await fundedPlayer('bob');
      await repo.join(LEAGUE, p, squad(3));
      await expect(repo.join(LEAGUE, p, squad(4))).rejects.toBeInstanceOf(AlreadyJoinedError);
      expect(await wallet.balance(p)).toBe(100_000 - FEE);
    });

    it('leaves no membership behind when the player cannot pay', async () => {
      const p = await fundedPlayer('broke', 0);
      await expect(repo.join(LEAGUE, p, squad(3))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await repo.getEntry(LEAGUE, p)).toBeNull();
    });

    it('rejects entries after the deadline', async () => {
      const p = await fundedPlayer('late');
      await expect(repo.join(LEAGUE, p, squad(3), Date.parse(FUTURE) + 1)).rejects.toBeInstanceOf(LeagueLockedError);
      expect(await wallet.balance(p)).toBe(100_000);
    });

    it('rejects an unknown league', async () => {
      const p = await fundedPlayer('lost');
      await expect(repo.join('nope', p, squad(3))).rejects.toBeInstanceOf(LeagueNotFoundError);
    });
  });

  describe('settle', () => {
    it('ranks by points, takes 10% rake, pays 50/30/20 and credits wallets — exactly once', async () => {
      const players = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((u) => fundedPlayer(u)));
      // Captains 3/4/5/6 → the captain's points decide the order.
      for (const [i, p] of players.entries()) await repo.join(LEAGUE, p, squad(i + 3));
      const points = live({ 3: 10, 4: 8, 5: 6, 6: 4 });

      const out = await repo.settle(LEAGUE, points);
      expect(out).toMatchObject({ status: 'settled', entrants: 4, poolMinor: 4 * FEE, rakeMinor: 2_000, paidMinor: 18_000 });

      const board = await repo.entries(LEAGUE);
      expect(board.map((e) => [e.username, e.finalRank, e.payoutMinor])).toEqual([
        ['p1', 1, 9_000], ['p2', 2, 5_400], ['p3', 3, 3_600], ['p4', 4, 0],
      ]);
      expect(board[0]!.points).toBe(28 + 10); // XI total + captain doubled

      expect(await wallet.balance(players[0]!)).toBe(100_000 - FEE + 9_000);
      expect(await wallet.balance(players[3]!)).toBe(100_000 - FEE);

      const again = await repo.settle(LEAGUE, points);
      expect(again.status).toBe('already-final');
      expect(await wallet.balance(players[0]!)).toBe(100_000 - FEE + 9_000);
      expect((await repo.getById(LEAGUE))?.status).toBe('settled');
    });

    it('cancels and refunds a league with too few entrants', async () => {
      const p = await fundedPlayer('lonely');
      await repo.join(LEAGUE, p, squad(3));
      const out = await repo.settle(LEAGUE, live({}));
      expect(out.status).toBe('cancelled');
      expect(await wallet.balance(p)).toBe(100_000);
      expect((await repo.getById(LEAGUE))?.status).toBe('cancelled');
    });

    it('closes the league to new entries once settled', async () => {
      const [a, b, late] = await Promise.all([fundedPlayer('a'), fundedPlayer('b'), fundedPlayer('late2')]);
      await repo.join(LEAGUE, a, squad(3));
      await repo.join(LEAGUE, b, squad(4));
      await repo.settle(LEAGUE, live({}));
      await expect(repo.join(LEAGUE, late, squad(5))).rejects.toBeInstanceOf(LeagueLockedError);
    });
  });

  describe('FPL links', () => {
    it('sets, replaces and removes a link', async () => {
      const p = await fundedPlayer('linker');
      expect(await repo.getFplLink(p)).toBeNull();
      await repo.setFplLink(p, { entryId: 1, teamName: 'A', managerName: 'M' });
      await repo.setFplLink(p, { entryId: 2, teamName: 'B', managerName: 'N' });
      expect(await repo.getFplLink(p)).toMatchObject({ entryId: 2, teamName: 'B' });
      await repo.deleteFplLink(p);
      expect(await repo.getFplLink(p)).toBeNull();
    });
  });
});
