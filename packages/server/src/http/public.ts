import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import {
  crashPointFor,
  commitSeed,
  verifyRound,
  type Commit,
  type Reveal,
} from '@crash/shared/rng';
import {
  createSession,
  getSession,
  getStats,
  getHistory,
  StoreOfflineError,
  isOnline as storeOnline,
} from '../store';
import { getActiveTheme } from '../theme/loader';
import { getAllHistory } from '../game/history';
import * as round from '../game/round';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDist = path.join(__dirname, '../../../client/dist');

function sendStoreError(res: express.Response, err: unknown) {
  if (err instanceof StoreOfflineError) {
    return res.status(503).json({ error: 'session store offline — start Dragonfly: docker compose up -d dragonfly' });
  }
  console.error('[api] error:', err);
  return res.status(500).json({ error: (err as Error).message });
}

export function registerPublicRoutes(app: express.Application) {
  // ─── Static client ─────────────────────────────────────────────────────────
  app.use(express.static(clientDist));

  // ─── Theme ─────────────────────────────────────────────────────────────────
  app.get('/api/theme', (_req, res) => {
    const activeTheme = getActiveTheme();
    if (activeTheme == null) { res.status(204).end(); return; }
    res.json(activeTheme);
  });

  // ─── Health ────────────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({
    ok: true,
    roundNumber: round.roundNumber,
    hasTheme: getActiveTheme() != null,
    storeOnline: storeOnline(),
  }));

  // ─── History ───────────────────────────────────────────────────────────────
  app.get('/api/history', (_req, res) => res.json(getAllHistory().slice(-50)));

  // ─── Verify (GET) ──────────────────────────────────────────────────────────
  app.get('/api/verify', (req, res) => {
    const seed = String(req.query.seed ?? '');
    const rn = String(req.query.roundNumber ?? '');
    if (!seed || !rn) return res.status(400).json({ error: 'Missing seed or roundNumber' });
    const roundNum = parseInt(rn, 10);
    if (!Number.isFinite(roundNum)) return res.status(400).json({ error: 'roundNumber must be an integer' });
    try {
      const crashPoint = crashPointFor(seed, roundNum, round.CONFIG);
      const hashCommit = commitSeed(seed);
      res.json({ roundNumber: roundNum, serverSeed: seed, crashPoint, hashCommit });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Verify (POST) ─────────────────────────────────────────────────────────
  app.post('/api/verify', (req, res) => {
    const { seed, roundNumber: rn } = (req.body ?? {}) as { seed?: string; roundNumber?: number };
    if (!seed || rn == null) return res.status(400).json({ error: 'Missing seed or roundNumber' });
    try {
      const commit: Commit = { roundNumber: rn, hashCommit: commitSeed(seed) };
      const reveal: Reveal = {
        roundNumber: rn,
        serverSeed: seed,
        crashPoint: crashPointFor(seed, rn, round.CONFIG),
      };
      const result = verifyRound(commit, reveal);
      res.json({ ...result, computedCrash: reveal.crashPoint, revealedSeed: seed });
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
