import { describe, it, expect } from 'vitest';
import { FplProvider } from './fpl.js';
import { ProviderUnavailableError } from './provider.js';

const BOOTSTRAP = {
  teams: [{ id: 1, name: 'Arsenal', short_name: 'ARS' }],
  elements: [
    { id: 10, web_name: 'Saka', team: 1, element_type: 3, now_cost: 100, status: 'a', news: '', can_select: true },
    { id: 11, web_name: 'Gone', team: 1, element_type: 4, now_cost: 45, status: 'u', news: 'Left', can_select: true },
  ],
  events: [{ id: 6, name: 'Gameweek 6', deadline_time: '2026-10-10T10:00:00Z', finished: false, data_checked: false, is_current: false, is_next: true }],
};

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (url: string) => {
    const path = url.replace('https://fpl.test', '');
    calls.push(path);
    if (routes[path] === 'boom') return new Response('nope', { status: 500 });
    if (!(path in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('FplProvider', () => {
  it('maps the bootstrap into players, teams and gameweeks', async () => {
    const fpl = new FplProvider('https://fpl.test', fakeFetch({ '/bootstrap-static/': BOOTSTRAP }));
    const cat = await fpl.catalog();
    expect(cat.players[0]).toMatchObject({ id: 10, name: 'Saka', position: 'MID', cost: 100, canSelect: true });
    expect(cat.players[1]).toMatchObject({ id: 11, canSelect: false });
    expect(cat.gameweeks[0]).toMatchObject({ id: 6, deadline: '2026-10-10T10:00:00Z', isNext: true });
  });

  it('caches the catalog between calls', async () => {
    const calls: string[] = [];
    const fpl = new FplProvider('https://fpl.test', fakeFetch({ '/bootstrap-static/': BOOTSTRAP }, calls));
    await fpl.catalog();
    await fpl.catalog();
    expect(calls).toEqual(['/bootstrap-static/']);
  });

  it('extracts the starting XI and armbands from picks', async () => {
    const picks = Array.from({ length: 15 }, (_, i) => ({
      element: 100 + i, position: i + 1, is_captain: i === 3, is_vice_captain: i === 4,
    }));
    const fpl = new FplProvider('https://fpl.test', fakeFetch({ '/entry/42/event/5/picks/': { picks } }));
    const xi = await fpl.entryXi(42, 5);
    expect(xi?.playerIds).toEqual(Array.from({ length: 11 }, (_, i) => 100 + i));
    expect(xi).toMatchObject({ captainId: 103, viceCaptainId: 104 });
  });

  it('returns null for an unknown team and throws ProviderUnavailableError on upstream errors', async () => {
    const fpl = new FplProvider('https://fpl.test', fakeFetch({ '/bootstrap-static/': 'boom' }));
    expect(await fpl.entry(999)).toBeNull();
    await expect(fpl.catalog()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
