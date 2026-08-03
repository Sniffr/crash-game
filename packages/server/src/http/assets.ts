/**
 * Asset upload HTTP router — Wave A (Contabo S3 asset storage).
 *
 * Mounted at /api/assets by index.ts. Admin-only: the Creator logs in for a
 * short-lived admin JWT, then POSTs each theme binary asset here to swap the
 * base64 `data:` URL for a public S3 URL before publishing the game.
 *
 *   - POST /upload  { gameId, assetKey, dataUrl } → { url, bytes, contentType }
 *
 * Guarded by requireAdminJwt (JWT signature + expiry). A local revocation set is
 * used since this router is mounted independently of the admin router; tokens are
 * short-lived so logout-revocation is not material for a write-only upload path.
 */

import { Router } from 'express';
import { uploadAsset, isDataUrl } from '@crash/wallet/s3';
import { requireAdminJwt } from './middleware/admin-auth.js';

export function createAssetsRouter(): Router {
  const router = Router();

  const revoked = new Set<string>();
  router.use(requireAdminJwt({ revoked }));

  // POST /upload — parse a data URL, store to S3, return the public URL.
  router.post('/upload', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { gameId?: unknown; assetKey?: unknown; dataUrl?: unknown };
      const { gameId, assetKey, dataUrl } = body;

      if (typeof gameId !== 'string' || gameId.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'gameId is required' } });
        return;
      }
      if (typeof assetKey !== 'string' || assetKey.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'assetKey is required' } });
        return;
      }
      if (!isDataUrl(dataUrl)) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'dataUrl must be a data: URL' } });
        return;
      }

      const result = await uploadAsset({ gameId, assetKey, dataUrl });
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      // Malformed data URLs / bad segment names are client errors; everything
      // else (S3 outage, missing config) is a 500.
      const isClientError = /Malformed data URL|may only contain|is required/.test(message);
      res
        .status(isClientError ? 400 : 500)
        .json({ error: { code: isClientError ? 'INVALID_INPUT' : 'UPLOAD_FAILED', message } });
    }
  });

  return router;
}
