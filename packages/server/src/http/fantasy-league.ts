/**
 * Fantasy League HTTP router — mounted at /api/fantasy-league.
 *
 *   GET    /catalog              PUBLIC  upcoming gameweek + selectable players/teams
 *   GET    /leagues              PUBLIC  recent leagues with their phase
 *   GET    /leagues/:id          PUBLIC  league + standings (live during the gameweek)
 *   GET    /my-leagues           player  ids of the leagues I've entered
 *   GET    /leagues/:id/me       player  my entry, points, rank, payout
 *   POST   /leagues/:id/join     player  enter with an XI; debits the entry fee
 *   GET    /fpl-link             player  my linked FPL team
 *   PUT    /fpl-link             player  link an FPL team by its public Team ID
 *   DELETE /fpl-link             player  unlink
 *   GET    /fpl-link/xi          player  my linked team's latest XI, to pre-fill a draft
 */

import { Router, type Request, type Response } from 'express';
import type { PgFantasyLeagueRepo } from '@crash/wallet/fantasy-league-repo-pg';
import { AlreadyJoinedError, LeagueLockedError, LeagueNotFoundError } from '@crash/wallet/fantasy-league-repo';
import type { PlayersRepo } from '@crash/wallet/players-repo';
import { InsufficientFundsError } from '@crash/wallet/wallet-ledger';
import { squadIssues, type SquadPick, type SquadPlayer } from '@crash/shared/fantasy';
import { requirePlayerJwt } from './lobby.js';
import { ProviderUnavailableError, type FantasyProvider } from '../fantasy/provider.js';
import { phaseOf, standings } from '../fantasy/standings.js';

export interface FantasyLeagueRouterDeps {
  leagues: PgFantasyLeagueRepo;
  players: PlayersRepo;
  provider: FantasyProvider;
  now?: () => number;
}

const STANDINGS_LIMIT = 100;

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

function parseSquad(body: unknown): SquadPick | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const ids = b['playerIds'];
  const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
  if (!Array.isArray(ids) || !ids.every(isId) || !isId(b['captainId']) || !isId(b['viceCaptainId'])) return null;
  return { playerIds: ids, captainId: b['captainId'], viceCaptainId: b['viceCaptainId'] };
}

export function createFantasyLeagueRouter(deps: FantasyLeagueRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  // Express 4 drops async rejections; every handler goes through this.
  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        if (res.headersSent) return;
        if (err instanceof ProviderUnavailableError) {
          fail(res, 503, 'PROVIDER_UNAVAILABLE', 'Fantasy data is temporarily unavailable — try again shortly.');
          return;
        }
        console.error('[fantasy-league] request failed:', err);
        fail(res, 500, 'INTERNAL', 'internal error');
      }
    };

  router.get('/catalog', handle(async (_req, res) => {
    const cat = await deps.provider.catalog();
    const t = now();
    const upcoming = cat.gameweeks.filter((g) => Date.parse(g.deadline) > t).sort((a, b) => a.id - b.id)[0] ?? null;
    res.json({
      gameweek: upcoming && { id: upcoming.id, name: upcoming.name, deadline: upcoming.deadline },
      teams: cat.teams,
      players: cat.players.filter((p) => p.canSelect).map(({ canSelect: _c, ...p }) => p),
    });
  }));

  router.get('/leagues', handle(async (_req, res) => {
    const t = now();
    const items = (await deps.leagues.listRecent()).map((l) => ({ ...l, phase: phaseOf(l, t) }));
    res.json({ items });
  }));

  router.get('/my-leagues', requirePlayerJwt, handle(async (req, res) => {
    res.json({ leagueIds: await deps.leagues.joinedLeagueIds(req.player!.playerId) });
  }));

  router.get('/leagues/:id', handle(async (req, res) => {
    const league = await deps.leagues.getById(String(req.params.id));
    if (!league) return fail(res, 404, 'LEAGUE_NOT_FOUND', 'league not found');
    const t = now();
    const table = await standings(league, deps.leagues, deps.provider, t);
    res.json({ league: { ...league, phase: phaseOf(league, t) }, standings: table.slice(0, STANDINGS_LIMIT), total: table.length });
  }));

  router.get('/leagues/:id/me', requirePlayerJwt, handle(async (req, res) => {
    const playerId = req.player!.playerId;
    const league = await deps.leagues.getById(String(req.params.id));
    if (!league) return fail(res, 404, 'LEAGUE_NOT_FOUND', 'league not found');
    const entry = await deps.leagues.getEntry(league.leagueId, playerId);
    if (!entry) {
      res.json({ entry: null });
      return;
    }
    const mine = (await standings(league, deps.leagues, deps.provider, now())).find((s) => s.playerId === playerId);
    res.json({
      entry: {
        squad: entry.squad,
        joinedAt: entry.joinedAt,
        rank: mine?.rank ?? null,
        points: mine?.points ?? null,
        payoutMinor: mine?.payoutMinor ?? null,
      },
    });
  }));

  router.post('/leagues/:id/join', requirePlayerJwt, handle(async (req, res) => {
    const playerId = req.player!.playerId;
    const league = await deps.leagues.getById(String(req.params.id));
    if (!league) return fail(res, 404, 'LEAGUE_NOT_FOUND', 'league not found');
    if (phaseOf(league, now()) !== 'open') return fail(res, 400, 'LEAGUE_LOCKED', 'this league has passed its deadline');

    const squad = parseSquad(req.body);
    if (!squad) return fail(res, 400, 'INVALID_SQUAD', 'playerIds, captainId and viceCaptainId are required');

    const player = await deps.players.getById(playerId);
    if (!player) return fail(res, 401, 'UNAUTHORIZED', 'player not found');
    if (player.currency !== league.currency) {
      return fail(res, 400, 'CURRENCY_MISMATCH', `this league is played in ${league.currency}; your account is in ${player.currency}`);
    }

    const { players } = await deps.provider.catalog();
    const pool = new Map<number, SquadPlayer>(players.filter((p) => p.canSelect).map((p) => [p.id, p]));
    const issues = squadIssues(squad, pool);
    if (issues.length > 0) return fail(res, 400, 'INVALID_SQUAD', issues[0]!, { issues });

    try {
      const { entry, balanceMinor } = await deps.leagues.join(league.leagueId, playerId, squad, now());
      res.status(201).json({ entry, balanceMinor });
    } catch (err) {
      if (err instanceof AlreadyJoinedError) return fail(res, 409, 'ALREADY_JOINED', 'you have already joined this league');
      if (err instanceof LeagueLockedError) return fail(res, 400, 'LEAGUE_LOCKED', 'this league has passed its deadline');
      if (err instanceof LeagueNotFoundError) return fail(res, 404, 'LEAGUE_NOT_FOUND', 'league not found');
      if (err instanceof InsufficientFundsError) return fail(res, 402, 'INSUFFICIENT_FUNDS', "balance too low for this league's entry fee");
      throw err;
    }
  }));

  router.get('/fpl-link', requirePlayerJwt, handle(async (req, res) => {
    res.json({ link: await deps.leagues.getFplLink(req.player!.playerId) });
  }));

  router.put('/fpl-link', requirePlayerJwt, handle(async (req, res) => {
    const entryId = Number((req.body ?? {}).entryId);
    if (!Number.isInteger(entryId) || entryId <= 0) return fail(res, 400, 'INVALID_ENTRY_ID', 'enter your numeric FPL Team ID');
    const entry = await deps.provider.entry(entryId);
    if (!entry) return fail(res, 404, 'FPL_TEAM_NOT_FOUND', `no FPL team with ID ${entryId}`);
    const link = await deps.leagues.setFplLink(req.player!.playerId, {
      entryId: entry.entryId, teamName: entry.teamName, managerName: entry.managerName,
    });
    res.json({ link });
  }));

  router.delete('/fpl-link', requirePlayerJwt, handle(async (req, res) => {
    await deps.leagues.deleteFplLink(req.player!.playerId);
    res.status(204).end();
  }));

  router.get('/fpl-link/xi', requirePlayerJwt, handle(async (req, res) => {
    const link = await deps.leagues.getFplLink(req.player!.playerId);
    if (!link) return fail(res, 404, 'NOT_LINKED', 'link your FPL team first');
    const entry = await deps.provider.entry(link.entryId);
    // FPL hides a gameweek's picks until its deadline, so the latest visible XI is the current one.
    const gw = entry?.currentGameweek;
    const xi = gw ? await deps.provider.entryXi(link.entryId, gw) : null;
    if (!gw || !xi) return fail(res, 404, 'NO_FPL_PICKS', 'your FPL team has no picks to import yet');
    res.json({ gameweek: gw, ...xi });
  }));

  return router;
}
