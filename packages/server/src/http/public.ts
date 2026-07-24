// NOTE: Route mounting order matters.
// /launch MUST be registered BEFORE the SPA `*` fallback at the bottom of
// this file so that the launch-error HTML response is returned by /launch
// and not swallowed by the index.html catch-all.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import {
  crashPointForMessage,
  crashMessage,
  commitSeed,
  verifyRound,
  DEFAULT_GAME_ID,
  type Commit,
  type Reveal,
  type RngConfig,
} from '@crash/shared/rng';
import { WalletError } from '@crash/wallet';
import {
  createSession,
  createOperatorSession,
  getSession,
  getStats,
  getHistory,
  StoreOfflineError,
} from '../store';
import { getActiveTheme } from '../theme/loader';
import { getAllHistory } from '../game/history';
import * as round from '../game/round';
import type { WalletClientCache } from '../wallet/client-cache';
import type { GamesRepo } from '@crash/wallet';
import { observeWalletCall } from '../observability/metrics.js';

/** RNG config for verifying a game: default → round CONFIG, else the game's own RTP. */
function verifyConfigForGame(deps: PublicRouteDeps, gameId: string): RngConfig {
  if (gameId !== DEFAULT_GAME_ID) {
    const g = deps.games.getById(gameId);
    if (g) return { rtp: g.rtp, maxMultiplier: round.CONFIG.maxMultiplier };
  }
  return round.CONFIG;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDist = path.join(__dirname, '../../../client/dist');

// ─── Launch error HTML template (loaded once at module initialisation) ────────
const LAUNCH_ERROR_TEMPLATE_PATH = path.join(__dirname, '../views/launch-error.html');
let _launchErrorTemplate: string | null = null;

function getLaunchErrorTemplate(): string {
  if (_launchErrorTemplate === null) {
    try {
      _launchErrorTemplate = fs.readFileSync(LAUNCH_ERROR_TEMPLATE_PATH, 'utf8');
    } catch {
      // Fallback in case the file is missing (shouldn't happen in production)
      _launchErrorTemplate = `<!DOCTYPE html><html><body><p>{{message}}</p>{{lobbyButton}}</body></html>`;
    }
  }
  return _launchErrorTemplate;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Returns the URL unchanged if it is http(s), otherwise null.
 * Blocks javascript:, data:, and any other non-http(s) schemes — escapeHtml
 * alone does NOT protect href attributes because javascript: contains no
 * HTML-special characters.
 * Relative or malformed URLs are rejected (error-page links must be absolute).
 */
function isSafeReturnUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? url : null;
  } catch {
    return null;  // relative or malformed → reject for error-page link
  }
}

function replaceAll(str: string, search: string, replacement: string): string {
  return str.split(search).join(replacement);
}

function renderLaunchError(opts: { title: string; message: string; lobbyUrl?: string }): string {
  const title = escapeHtml(opts.title);
  const message = escapeHtml(opts.message);
  const lobbyButton = opts.lobbyUrl
    ? `<a href="${escapeHtml(opts.lobbyUrl)}" class="btn">Return to lobby</a>`
    : '';
  let html = getLaunchErrorTemplate();
  html = replaceAll(html, '{{title}}', title);
  html = replaceAll(html, '{{message}}', message);
  html = replaceAll(html, '{{lobbyButton}}', lobbyButton);
  return html;
}

// ─── Public route deps ────────────────────────────────────────────────────────

export interface PublicRouteDeps {
  walletClientCache: WalletClientCache;
  games: GamesRepo;
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function sendStoreError(res: express.Response, err: unknown) {
  if (err instanceof StoreOfflineError) {
    return res.status(503).json({ error: 'session store offline — start Dragonfly: docker compose up -d dragonfly' });
  }
  console.error('[api] error:', err);
  return res.status(500).json({ error: (err as Error).message });
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerPublicRoutes(app: express.Application, deps: PublicRouteDeps) {
  // ─── Static client ─────────────────────────────────────────────────────────
  app.use(express.static(clientDist));

  // ─── Games catalogue (public) ────────────────────────────────────────────────
  // Lobbies + the Creator list active games. No theme_json here — the theme
  // ships at launch / via /api/theme?game=.
  app.get('/api/games', (_req, res) => {
    res.json({
      items: deps.games.list().map((g) => ({ gameId: g.gameId, name: g.name, gameType: g.gameType })),
    });
  });

  // ─── Theme ─────────────────────────────────────────────────────────────────
  // ?game=<id> returns that catalogue game's theme; falls back to the single
  // active-theme.json when no game is given or the game is unknown (back-compat).
  app.get('/api/theme', (req, res) => {
    const gameId = String(req.query.game ?? '').trim();
    if (gameId) {
      const g = deps.games.getById(gameId);
      if (g && g.status === 'active') { res.json(g.theme); return; }
    }
    const activeTheme = getActiveTheme();
    if (activeTheme == null) { res.status(204).end(); return; }
    res.json(activeTheme);
  });

  // ─── Health ────────────────────────────────────────────────────────────────
  // The PUBLIC /api/health liveness probe (Task 8.3 Dockerfile HEALTHCHECK target)
  // is registered in index.ts BEFORE this router runs, and returns the minimal
  // {ok:true} — no version, no roundNumber, no theme/store internals (no
  // leakage to unauthed scanners). Per-operator stats live behind JWT at
  // /admin/v1/health/summary (spec §10.1). Do NOT re-add a /api/health handler
  // here — the old verbose handler was deleted in Phase-8 holistic review (S1).

  // ─── History ───────────────────────────────────────────────────────────────
  app.get('/api/history', (_req, res) => res.json(getAllHistory().slice(-50)));

  // ─── Verify (GET) ──────────────────────────────────────────────────────────
  // ?game=<id> verifies a non-default game (domain-separated nonce + its RTP).
  // Omitting game verifies the default game exactly as before.
  app.get('/api/verify', (req, res) => {
    const seed = String(req.query.seed ?? '');
    const rn = String(req.query.roundNumber ?? '');
    const gameId = String(req.query.game ?? '').trim() || DEFAULT_GAME_ID;
    if (!seed || !rn) return res.status(400).json({ error: 'Missing seed or roundNumber' });
    const roundNum = parseInt(rn, 10);
    if (!Number.isFinite(roundNum)) return res.status(400).json({ error: 'roundNumber must be an integer' });
    try {
      const cfg = verifyConfigForGame(deps, gameId);
      const crashPoint = crashPointForMessage(seed, crashMessage(roundNum, gameId), cfg);
      const hashCommit = commitSeed(seed);
      res.json({ roundNumber: roundNum, gameId, serverSeed: seed, crashPoint, hashCommit });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Verify (POST) ─────────────────────────────────────────────────────────
  app.post('/api/verify', (req, res) => {
    const { seed, roundNumber: rn, game } = (req.body ?? {}) as { seed?: string; roundNumber?: number; game?: string };
    if (!seed || rn == null) return res.status(400).json({ error: 'Missing seed or roundNumber' });
    const gameId = (game ?? '').trim() || DEFAULT_GAME_ID;
    try {
      const cfg = verifyConfigForGame(deps, gameId);
      const commit: Commit = { roundNumber: rn, hashCommit: commitSeed(seed) };
      const reveal: Reveal = {
        roundNumber: rn,
        serverSeed: seed,
        crashPoint: crashPointForMessage(seed, crashMessage(rn, gameId), cfg),
      };
      const result = verifyRound(commit, reveal);
      res.json({ ...result, gameId, computedCrash: reveal.crashPoint, revealedSeed: seed });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Session API ───────────────────────────────────────────────────────────

  /** Create a fresh anonymous session. Returns the session id + URL hint. */
  app.post('/api/session', async (req, res) => {
    try {
      const { displayName, balance } = (req.body ?? {}) as { displayName?: string; balance?: number };
      const safeBalance = balance != null && Number.isFinite(balance) && balance > 0
        ? Math.min(balance, 100_000)
        : undefined;
      const session = await createSession({ displayName, balance: safeBalance });
      res.json(session);
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const stats = await getStats(req.params.id);
      res.json({ session, stats });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  app.get('/api/sessions/:id/history', async (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50)));
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const history = await getHistory(req.params.id, limit);
      res.json({ history });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  // ─── Launch endpoint (spec §3 / §5.1) ─────────────────────────────────────
  // Must be registered BEFORE the SPA `*` fallback below.
  app.get('/launch', async (req, res) => {
    const operator  = String(req.query.operator  ?? '').trim();
    const token     = String(req.query.token     ?? '').trim();
    const currency  = String(req.query.currency  ?? '').trim();
    const gameId    = String(req.query.game      ?? '').trim() || DEFAULT_GAME_ID;
    const lobbyUrl  = String(req.query.lobby_url ?? '').trim();
    const returnUrl = String(req.query.return_url ?? '').trim();
    // Optional: lang, jurisdiction, mode — not used server-side yet (Task 3.2 handles client-side)

    // Sanitize lobby_url / return_url: reject non-http(s) schemes (e.g. javascript:, data:)
    // before they are rendered in href attributes or echoed into the redirect query string.
    // escapeHtml alone is insufficient for href — javascript: contains no HTML-special chars.
    const safeLobbyUrl  = isSafeReturnUrl(lobbyUrl);
    const safeReturnUrl = isSafeReturnUrl(returnUrl);

    // Per spec §3, the error-page "Return to lobby" button points at return_url, with
    // lobby_url as the fallback when return_url is absent.
    const errorButtonUrl = safeReturnUrl ?? safeLobbyUrl;

    // 1. Validate required params
    if (!operator || !token || !currency) {
      res.status(400).send(renderLaunchError({
        title: 'Launch Error',
        message: 'Missing required launch parameters.',
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }

    // 2. Resolve the operator's WalletClient (returns null for unknown or paused)
    const client = deps.walletClientCache.get(operator);
    if (!client) {
      res.status(404).send(renderLaunchError({
        title: 'Unknown Operator',
        message: 'Unknown operator.',
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }

    // 2b. Resolve the requested game and confirm it is enabled for this operator.
    //     effectiveRtp returns null when the game is unknown/archived OR not
    //     enabled for the operator (default-deny). Distinguish the two for a
    //     clearer error page.
    const game = deps.games.getById(gameId);
    if (!game || game.status !== 'active') {
      res.status(404).send(renderLaunchError({
        title: 'Unknown Game',
        message: `Unknown game '${escapeHtml(gameId)}'.`,
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }
    if (deps.games.effectiveRtp(operator, gameId) === null) {
      res.status(403).send(renderLaunchError({
        title: 'Game Unavailable',
        message: 'This game is not enabled for your operator.',
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }

    // 3. Authenticate the launch token against the operator's wallet (spec §5.1)
    //    Wrapped for metrics — transparent: rethrows the original error unchanged.
    let authResp: Awaited<ReturnType<typeof client.authenticate>>;
    try {
      authResp = await observeWalletCall(
        { operator, endpoint: 'authenticate' },
        () => client.authenticate({
          token,
          ip: req.ip ?? '',
          userAgent: req.get('user-agent') ?? '',
          gameId,
        }),
      );
    } catch (err) {
      // Translate operator errors to player-friendly messages
      let message = 'Could not start the game. Please try again.';
      let status = 500;

      if (err instanceof WalletError) {
        status = err.httpStatus >= 400 && err.httpStatus < 500 ? 401 : 500;
        if (err.code === 'INVALID_TOKEN') {
          message = 'Launch token expired. Please return to the lobby.';
          status = 401;
        } else if (err.code === 'PLAYER_BLOCKED') {
          message = 'Your account is currently restricted. Please contact support.';
          status = 403;
        } else if (err.code === 'SESSION_EXPIRED') {
          message = 'Your session has expired. Please return to the lobby.';
          status = 401;
        }
      }

      console.error(`[launch] authenticate failed for operator=${operator}:`, err instanceof WalletError ? `${err.code} ${err.message}` : err);
      // Per spec §3: error button uses return_url ∥ lobby_url (errorButtonUrl already set above)
      res.status(status).send(renderLaunchError({
        title: 'Launch Failed',
        message,
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }

    // 4. Currency mismatch check
    if (authResp.currency !== currency) {
      res.status(422).send(renderLaunchError({
        title: 'Currency Mismatch',
        message: `Currency mismatch: launch URL requested ${escapeHtml(currency)} but operator returned ${escapeHtml(authResp.currency)}.`,
        // Per spec §3: error button uses return_url ∥ lobby_url
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }

    // 5. Mint an operator session
    let session: Awaited<ReturnType<typeof createOperatorSession>>;
    try {
      session = await createOperatorSession({
        operatorId: operator,
        playerId: authResp.playerId,
        currency: authResp.currency,
        balanceMinor: authResp.balance,
        displayName: authResp.displayName,
        rgLimits: authResp.rgLimits,
        gameId,
      });
    } catch (err) {
      console.error('[launch] createOperatorSession failed:', err);
      // Per spec §3: error button uses return_url ∥ lobby_url
      res.status(500).send(renderLaunchError({
        title: 'Launch Failed',
        message: 'Could not start the game. Please try again.',
        lobbyUrl: errorButtonUrl ?? undefined,
      }));
      return;
    }

    // 6. Redirect into the SPA with the session id + optional lobby/return URLs.
    // Use sanitized URLs so we never echo a javascript: scheme into the redirect
    // query string (belt-and-suspenders; the SPA has its own safety responsibilities
    // per Task 3.2, but we don't reflect unsafe URLs from our server).
    let location = `/?session=${encodeURIComponent(session.sessionId)}&game=${encodeURIComponent(gameId)}`;
    if (safeLobbyUrl)  location += `&lobby=${encodeURIComponent(safeLobbyUrl)}`;
    if (safeReturnUrl) location += `&return=${encodeURIComponent(safeReturnUrl)}`;

    res.redirect(302, location);
  });

  // ─── SPA fallback ──────────────────────────────────────────────────────────
  // Anything that isn't an /api/* route nor a static asset hands back index.html
  // so the SPA can render. Direct loads of /?session=abc and similar work.
  // Must come AFTER express.static and all /api routes.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/ws') return next();
    const indexHtml = path.join(clientDist, 'index.html');
    if (!fs.existsSync(indexHtml)) return next();
    res.sendFile(indexHtml);
  });
}
