// The edge-cache middleware, with a fake caches.default: a copy is stored
// with the route's Cache-Control, and a hit (which Cloudflare hands back
// with the zone's 4-hour Browser Cache TTL) gets it back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, restoreCacheControl, ROUTE_CACHE_CONTROL } from '../src/app.js';
import { makeEnv } from './helpers.js';

afterEach(() => { delete globalThis.caches; });

function fakeCache() {
  const store = new Map();
  return {
    store,
    match: vi.fn(async req => store.get(new URL(req.url).pathname)?.clone() ?? undefined),
    put: vi.fn(async (req, res) => { store.set(new URL(req.url).pathname, res); }),
  };
}

describe('edge cache', () => {
  it('stores the route\'s Cache-Control with the copy', async () => {
    const cache = fakeCache();
    globalThis.caches = { default: cache };
    const pending = [];
    const res = await app.request('/v1/leagues', {}, makeEnv(), { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get(ROUTE_CACHE_CONTROL)).toBeNull();
    expect(cache.store.get('/v1/leagues').headers.get(ROUTE_CACHE_CONTROL)).toBe('public, max-age=86400');
  });

  it('a hit gets the route\'s max-age back, not the zone\'s 4 hours', async () => {
    const cache = fakeCache();
    cache.store.set('/v1/nhl/elo', new Response('{"data":1}', {
      headers: { 'Cache-Control': 'public, max-age=14400', [ROUTE_CACHE_CONTROL]: 'public, max-age=3600', 'cf-cache-status': 'HIT' },
    }));
    globalThis.caches = { default: cache };
    const env = makeEnv();
    const res = await app.request('/v1/nhl/elo', {}, env, { waitUntil: () => {} });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(res.headers.get(ROUTE_CACHE_CONTROL)).toBeNull();
    expect(await res.json()).toEqual({ data: 1 });
    expect(env.POLLER.fetch).not.toHaveBeenCalled();
  });

  it('a copy stored before this change keeps whatever it has', () => {
    const res = restoreCacheControl(new Response('x', { headers: { 'Cache-Control': 'public, max-age=14400' } }));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=14400');
  });
});
