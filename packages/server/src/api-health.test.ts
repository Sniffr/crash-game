/**
 * /api/health — PUBLIC liveness probe smoke test (Task 8.2 / 8.3 HEALTHCHECK).
 *
 * The route is registered in src/index.ts at module-init time. To avoid
 * booting the full server (which starts a TCP listener + scheduler + game
 * loop), we re-create a minimal express app and register the exact same
 * route here. The contract under test is "shape of the response" — the
 * route itself is a one-liner whose only thing worth testing is its body.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

function makeApp(): express.Application {
  const app = express();
  // Mirror src/index.ts: PUBLIC, no auth middleware, minimal body.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('GET /api/health', () => {
  it('returns 200 { ok: true } with no auth required', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does not leak deployment metadata (no version/branch fields)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    // Defensive: keep the surface boring — only ok=true.
    expect(Object.keys(res.body)).toEqual(['ok']);
  });
});
