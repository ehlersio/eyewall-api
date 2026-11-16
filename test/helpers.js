// Test harness: the app with a fake POLLER binding that answers from
// fixtures, keyed by path + query exactly as the routes ask.

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { app } from '../src/app.js';

export const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

// `routes`: { '/path?query': body | { status, body } }.
export function makeEnv(routes = {}, { limit = true } = {}) {
  const fetch = vi.fn(async (req) => {
    const u = new URL(req.url);
    const key = u.pathname + u.search;
    if (!(key in routes)) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    const r = routes[key];
    const wrapped = r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 2 && 'status' in r && 'body' in r;
    const status = wrapped ? r.status : 200;
    const body = wrapped ? r.body : r;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return {
    POLLER: { fetch },
    API_LIMITER: { limit: vi.fn(async () => ({ success: limit })) },
  };
}

export const teamsRoutes = league => ({ [`/config/teams?league=${league}`]: fixture(`teams-${league}`) });

export async function get(path, env, headers = {}) {
  const res = await app.request(path, { headers }, env);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { res, status: res.status, body };
}
