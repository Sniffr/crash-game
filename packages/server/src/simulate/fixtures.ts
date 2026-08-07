/**
 * Simulate fixtures feed loader.
 *
 * The harvester (services/harvester) scrapes real odds and uploads a feed to
 * S3 at `simulate/fixtures/latest.json`. This module fetches + caches that feed
 * and falls back to a bundled sample so Simulate always has something to show
 * (e.g. before the first scrape, or if S3 is unreachable).
 *
 * Config (env): the same S3_* vars the wallet uses. If they are absent the
 * loader silently serves the sample feed — handy for local dev.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { buildSampleFeed } from './sampleFixtures.js';

// ---------------------------------------------------------------------------
// Types — the on-the-wire feed contract (mirrors services/harvester/normalize.py)
// ---------------------------------------------------------------------------

export interface Market1x2 {
  home: number;
  draw: number;
  away: number;
}

export interface Fixture {
  eventId: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  /** ISO-8601 UTC kickoff, e.g. "2026-08-07T17:30:00Z". */
  kickoff: string;
  markets: { '1x2'?: Market1x2 } & Record<string, unknown>;
}

export interface FixturesFeed {
  feedVersion: number;
  generatedAt: string;
  source: string;
  sport: string;
  fixtures: Fixture[];
}

export type FixtureWindow = 'today' | 'tomorrow' | 'week' | 'later';

// ---------------------------------------------------------------------------
// S3 client (lazy, env-driven)
// ---------------------------------------------------------------------------

const FEED_KEY = 'simulate/fixtures/latest.json';

let cachedClient: S3Client | null = null;
function s3Client(): S3Client | null {
  const endpoint = process.env['S3_ENDPOINT'];
  const region = process.env['S3_REGION'];
  const accessKeyId = process.env['S3_ACCESS_KEY'];
  const secretAccessKey = process.env['S3_SECRET_KEY'];
  const bucket = process.env['S3_BUCKET'];
  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) return null;
  if (!cachedClient) {
    cachedClient = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return cachedClient;
}

async function fetchFeedFromS3(): Promise<FixturesFeed | null> {
  const client = s3Client();
  const bucket = process.env['S3_BUCKET'];
  if (!client || !bucket) return null;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: FEED_KEY }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    const feed = JSON.parse(body) as FixturesFeed;
    if (!feed || !Array.isArray(feed.fixtures)) return null;
    return feed;
  } catch (err) {
    console.warn('[simulate] could not fetch feed from S3, using sample:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cached provider
// ---------------------------------------------------------------------------

const TTL_MS = Number(process.env['SIMULATE_FEED_TTL_MS'] ?? 60_000);

let cache: { feed: FixturesFeed; at: number } | null = null;

/** Return the current feed, refreshing from S3 at most once per TTL. */
export async function getFeed(nowMs: number = Date.now()): Promise<FixturesFeed> {
  if (cache && nowMs - cache.at < TTL_MS) return cache.feed;
  const s3Feed = await fetchFeedFromS3();
  const feed = s3Feed ?? buildSampleFeed(nowMs);
  cache = { feed, at: nowMs };
  return feed;
}

/** Test/ops hook — drop the cache so the next getFeed re-reads. */
export function clearFeedCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Windowing (UTC-day based; clients render kickoff in local time)
// ---------------------------------------------------------------------------

function utcDayIndex(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 86_400_000);
}

/** Bucket a fixture relative to `now`. */
export function windowFor(kickoffIso: string, nowMs: number): FixtureWindow {
  const day = utcDayIndex(kickoffIso);
  const today = Math.floor(nowMs / 86_400_000);
  if (day <= today) return 'today';
  if (day === today + 1) return 'tomorrow';
  if (day <= today + 7) return 'week';
  return 'later';
}

/** A fixture annotated with its window bucket. */
export type WindowedFixture = Fixture & { window: FixtureWindow };

/**
 * Fixtures for a window. `window`:
 *   'today'    → today only
 *   'tomorrow' → tomorrow only
 *   'week'     → today .. +7 days (inclusive of today & tomorrow)
 *   'all'      → everything upcoming (default)
 * Past-kickoff fixtures are always dropped.
 */
export async function getFixtures(
  window: FixtureWindow | 'all' = 'all',
  nowMs: number = Date.now(),
): Promise<WindowedFixture[]> {
  const feed = await getFeed(nowMs);
  const out: WindowedFixture[] = [];
  for (const fx of feed.fixtures) {
    const w = windowFor(fx.kickoff, nowMs);
    // Only fixtures that have NOT kicked off are simulatable (POST /play rejects
    // started events), so the listing hides them too.
    if (new Date(fx.kickoff).getTime() <= nowMs) continue;
    if (window === 'all') {
      out.push({ ...fx, window: w });
    } else if (window === 'week') {
      if (w === 'today' || w === 'tomorrow' || w === 'week') out.push({ ...fx, window: w });
    } else if (w === window) {
      out.push({ ...fx, window: w });
    }
  }
  return out;
}
