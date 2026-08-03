/**
 * Contabo S3 asset storage — Wave A.
 *
 * Uploads Creator theme binary assets (sprites, backgrounds, GIFs, sounds) that
 * arrive as base64 `data:` URLs to a PUBLIC-read S3 bucket, returning the public
 * URL so the stored theme carries only URLs instead of megabytes of base64.
 *
 * Config comes from S3_* env (loaded via `import 'dotenv/config'` at process
 * boot). Objects are keyed `games/<gameId>/<assetKey>`; the bucket is public-read
 * so an object at that key is fetchable at `${S3_PUBLIC_BASE}/games/<gameId>/<assetKey>`.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

/** Images larger than this are re-encoded to WebP before upload. */
const COMPRESS_THRESHOLD_BYTES = 1_000_000; // 1 MB

/**
 * Compress an over-threshold image to WebP (animation preserved for gif/webp).
 * Returns the original untouched for non-images, small images, or on any
 * failure — compression must never block a publish.
 */
async function maybeCompress(
  bytes: Buffer,
  contentType: string,
): Promise<{ body: Buffer; contentType: string }> {
  if (!contentType.startsWith('image/') || bytes.length <= COMPRESS_THRESHOLD_BYTES) {
    return { body: bytes, contentType };
  }
  try {
    const animated = contentType === 'image/gif' || contentType === 'image/webp';
    const out = await sharp(bytes, { animated }).webp({ quality: 62, effort: 4 }).toBuffer();
    // Only adopt the re-encode if it actually got smaller.
    if (out.length < bytes.length) {
      return { body: out, contentType: 'image/webp' };
    }
  } catch (err) {
    console.error('[s3] image compression failed — storing original:', err instanceof Error ? err.message : err);
  }
  return { body: bytes, contentType };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let cachedClient: S3Client | null = null;

/**
 * Lazily build (and cache) the S3 client from S3_* env. Reads env at call time
 * so `import 'dotenv/config'` has a chance to populate it first.
 */
function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const endpoint = requireEnv('S3_ENDPOINT');
  const region = requireEnv('S3_REGION');
  const accessKeyId = requireEnv('S3_ACCESS_KEY');
  const secretAccessKey = requireEnv('S3_SECRET_KEY');
  cachedClient = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ---------------------------------------------------------------------------
// data: URL parsing
// ---------------------------------------------------------------------------

/** True when `v` is a string that looks like a `data:` URL. */
export function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:');
}

/**
 * Parse a `data:<mime>;base64,<data>` URL into its raw bytes + content type.
 * Only base64-encoded data URLs are supported.
 *
 * @throws Error on malformed input.
 */
export function parseDataUrl(dataUrl: string): { bytes: Buffer; contentType: string } {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Malformed data URL: must start with "data:"');
  }
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URL: missing "," separator');

  const header = dataUrl.slice(5, comma); // strip "data:"
  const payload = dataUrl.slice(comma + 1);

  const parts = header.split(';');
  const isBase64 = parts[parts.length - 1] === 'base64';
  if (!isBase64) throw new Error('Malformed data URL: only base64 encoding is supported');

  const contentType = parts[0] && parts[0].length > 0 ? parts[0] : 'application/octet-stream';

  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, 'base64');
  } catch {
    throw new Error('Malformed data URL: invalid base64 payload');
  }
  if (bytes.length === 0) throw new Error('Malformed data URL: empty payload');

  return { bytes, contentType };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Sanitize a path segment: allow only `[a-zA-Z0-9._-]`. Rejects empty input and
 * anything with path-traversal characters (`/`, `\`, `..`).
 */
function sanitizeSegment(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} may only contain [a-zA-Z0-9._-]`);
  }
  return value;
}

/**
 * Parse a data URL and PutObject it to `games/<gameId>/<assetKey>` in the
 * configured bucket, returning the public URL plus size + content type.
 */
export async function uploadAsset(opts: {
  gameId: string;
  assetKey: string;
  dataUrl: string;
}): Promise<{ url: string; bytes: number; contentType: string }> {
  const gameId = sanitizeSegment('gameId', opts.gameId);
  const assetKey = sanitizeSegment('assetKey', opts.assetKey);
  const parsed = parseDataUrl(opts.dataUrl);

  // Compress images over 1 MB (→ WebP) before storing.
  const { body, contentType } = await maybeCompress(parsed.bytes, parsed.contentType);

  const bucket = requireEnv('S3_BUCKET');
  const publicBase = requireEnv('S3_PUBLIC_BASE').replace(/\/+$/, '');
  const key = `games/${gameId}/${assetKey}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return {
    url: `${publicBase}/${key}`,
    bytes: body.length,
    contentType,
  };
}
