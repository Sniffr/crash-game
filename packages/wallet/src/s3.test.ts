import { config } from 'dotenv';
// Load repo-root .env (vitest cwd is the package dir).
config({ path: '../../.env' });

import { describe, it, expect } from 'vitest';
import { parseDataUrl, isDataUrl, uploadAsset } from './s3.js';

// A tiny 1x1 transparent PNG as a base64 data URL.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

describe('isDataUrl', () => {
  it('accepts data: URLs and rejects everything else', () => {
    expect(isDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isDataUrl('https://example.com/x.png')).toBe(false);
    expect(isDataUrl('')).toBe(false);
    expect(isDataUrl(null)).toBe(false);
    expect(isDataUrl(undefined)).toBe(false);
    expect(isDataUrl(123)).toBe(false);
  });
});

describe('parseDataUrl', () => {
  it('round-trips a known data URL (bytes + contentType)', () => {
    const known = 'data:text/plain;base64,' + Buffer.from('hello').toString('base64');
    const { bytes, contentType } = parseDataUrl(known);
    expect(contentType).toBe('text/plain');
    expect(bytes.toString('utf8')).toBe('hello');
  });

  it('parses the tiny PNG', () => {
    const { bytes, contentType } = parseDataUrl(TINY_PNG);
    expect(contentType).toBe('image/png');
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic number.
    expect(bytes[0]).toBe(0x89);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('rejects malformed input', () => {
    expect(() => parseDataUrl('not-a-data-url')).toThrow();
    expect(() => parseDataUrl('data:image/png')).toThrow(); // no comma
    expect(() => parseDataUrl('data:image/png,rawtext')).toThrow(); // not base64
    expect(() => parseDataUrl('data:;base64,')).toThrow(); // empty payload
  });
});

// Real integration check — skips gracefully when S3 creds are absent, but MUST
// run here because .env is present.
const hasS3 = !!process.env['S3_ACCESS_KEY'];

describe('uploadAsset (integration)', () => {
  it.skipIf(!hasS3)('uploads a PNG and the public URL serves matching bytes', async () => {
    const assetKey = `agentA-${Date.now()}.png`;
    const expected = parseDataUrl(TINY_PNG).bytes;

    const result = await uploadAsset({ gameId: '_selftest', assetKey, dataUrl: TINY_PNG });
    expect(result.contentType).toBe('image/png');
    expect(result.bytes).toBe(expected.length);
    expect(result.url).toContain(`games/_selftest/${assetKey}`);

    const res = await fetch(result.url);
    expect(res.status).toBe(200);
    const fetched = Buffer.from(await res.arrayBuffer());
    expect(fetched.length).toBe(expected.length);
    expect(fetched.equals(expected)).toBe(true);

    // Surface the URL in test output for the report.
    console.log('[s3.test] uploaded to:', result.url);
  }, 30_000);
});
