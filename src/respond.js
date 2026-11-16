// Success responses: `{ data, meta }` with Cache-Control. Browsers and the
// Worker's edge cache keep a response `maxAge` seconds.

export const MAX_MAX_AGE = 86400;

export function send(c, data, meta, maxAge) {
  const age = Math.max(0, Math.min(MAX_MAX_AGE, Math.round(maxAge)));
  return c.json({ data, meta }, 200, { 'Cache-Control': `public, max-age=${age}` });
}

export function problem(c, status, title, detail) {
  const body = { type: 'about:blank', title, status };
  if (detail) body.detail = detail;
  return c.json(body, status, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' });
}
