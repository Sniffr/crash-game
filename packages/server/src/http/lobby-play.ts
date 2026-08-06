import { Router } from 'express';
import type { PgGamesRepo } from '@crash/wallet';
import type { PlayersRepo } from '@crash/wallet/players-repo';
import type { WalletLedger } from '@crash/wallet/wallet-ledger';
import { requirePlayerJwt } from './lobby.js';
import { createPlayerSession } from '../store.js';

/**
 * `POST /api/lobby/play/start` — mint a REAL-money game session bound to the
 * logged-in player. Mounted at /api/lobby (alongside the auth router). The
 * client redirects into /play?session=<id>&game=<id>&mode=real; the WS bet path
 * then settles against wallet_ledger. Demo play never calls this.
 */
export function createLobbyPlayRouter(deps: {
  games: PgGamesRepo;
  players: PlayersRepo;
  wallet: WalletLedger;
}): Router {
  const router = Router();

  router.post('/play/start', requirePlayerJwt, async (req, res): Promise<void> => {
    const playerId = req.player!.playerId;
    const gameId = String((req.body ?? {}).gameId ?? '').trim();
    if (!gameId) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'gameId required' } });
      return;
    }
    const game = await deps.games.getById(gameId);
    if (!game || game.status !== 'active') {
      res.status(404).json({ error: { code: 'GAME_NOT_FOUND', message: `No active game '${gameId}'` } });
      return;
    }
    const player = await deps.players.getById(playerId);
    if (!player) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Player not found' } });
      return;
    }

    const balanceMinor = await deps.wallet.balance(playerId, player.currency);
    const session = await createPlayerSession({
      lobbyPlayerId: playerId,
      username: player.username,
      gameId,
      balanceMinor,
      currency: player.currency,
    });
    res.json({ sessionId: session.sessionId, gameId, balanceMinor });
  });

  return router;
}
