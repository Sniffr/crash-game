/**
 * Bundled sample fixtures for Simulate.
 *
 * Served when the real S3 feed is unavailable (before the first harvest, local
 * dev, S3 down). Kickoffs are computed RELATIVE TO NOW so the today / tomorrow
 * / this-week windows are always populated with a plausible spread — a static
 * dated file would go stale the day after it's committed.
 */

import type { FixturesFeed, Fixture } from './fixtures.js';

interface SampleMatch {
  league: string;
  home: string;
  away: string;
  /** Days from today (0 = today). */
  dayOffset: number;
  /** UTC hour of kickoff. */
  hour: number;
  odds: { home: number; draw: number; away: number };
}

// A spread across today, tomorrow and the coming week, real-ish leagues + odds.
const SAMPLE: SampleMatch[] = [
  { league: 'England Premier League', home: 'Arsenal', away: 'Chelsea', dayOffset: 0, hour: 17, odds: { home: 2.10, draw: 3.40, away: 3.35 } },
  { league: 'England Premier League', home: 'Liverpool', away: 'Man City', dayOffset: 0, hour: 19, odds: { home: 2.55, draw: 3.60, away: 2.60 } },
  { league: 'Spain LaLiga', home: 'Real Madrid', away: 'Barcelona', dayOffset: 1, hour: 20, odds: { home: 2.35, draw: 3.50, away: 2.90 } },
  { league: 'Italy Serie A', home: 'Inter', away: 'Juventus', dayOffset: 1, hour: 18, odds: { home: 2.05, draw: 3.30, away: 3.70 } },
  { league: 'Germany Bundesliga', home: 'Bayern', away: 'Dortmund', dayOffset: 2, hour: 16, odds: { home: 1.75, draw: 4.00, away: 4.20 } },
  { league: 'France Ligue 1', home: 'PSG', away: 'Marseille', dayOffset: 3, hour: 19, odds: { home: 1.55, draw: 4.40, away: 5.50 } },
  { league: 'England Premier League', home: 'Tottenham', away: 'Newcastle', dayOffset: 4, hour: 14, odds: { home: 2.20, draw: 3.55, away: 3.10 } },
  { league: 'Netherlands Eredivisie', home: 'Ajax', away: 'PSV', dayOffset: 5, hour: 13, odds: { home: 2.45, draw: 3.60, away: 2.70 } },
  { league: 'Portugal Primeira Liga', home: 'Benfica', away: 'Porto', dayOffset: 6, hour: 20, odds: { home: 2.30, draw: 3.20, away: 3.05 } },
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function buildSampleFeed(nowMs: number): FixturesFeed {
  const fixtures: Fixture[] = SAMPLE.map((m) => {
    const d = new Date(nowMs + m.dayOffset * 86_400_000);
    d.setUTCHours(m.hour, 0, 0, 0);
    const kickoff = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      eventId: `${slug(m.home)}-${slug(m.away)}-SAMPLE`,
      sport: 'football',
      league: m.league,
      home: m.home,
      away: m.away,
      kickoff,
      markets: { '1x2': m.odds },
    };
  });
  return {
    feedVersion: 1,
    generatedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'sample',
    sport: 'football',
    fixtures,
  };
}
