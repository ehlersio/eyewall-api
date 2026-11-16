// Calls to eyewall-poller over the POLLER Service Binding. The host in the
// URL is ignored by a binding; the path and query are what the poller sees.

export class UpstreamError extends Error {
  constructor(status, detail) {
    super(detail || `upstream ${status}`);
    this.status = status;
  }
}

// GET a poller path and parse its JSON. A non-2xx answer, or a body with
// `unavailable: true` (the poller's "the read failed, try later" shape),
// throws UpstreamError, which the app turns into a problem response.
export async function poller(env, path) {
  if (!env?.POLLER) throw new UpstreamError(503, 'POLLER binding missing');
  const res = await env.POLLER.fetch(new Request(`https://eyewall-poller${path}`));
  if (!res.ok) throw new UpstreamError(res.status >= 500 ? 502 : res.status, `poller answered ${res.status} for ${path.split('?')[0]}`);
  const body = await res.json();
  if (body && typeof body === 'object' && !Array.isArray(body) && body.unavailable === true) {
    throw new UpstreamError(503, 'the data source is temporarily unavailable');
  }
  return body;
}
