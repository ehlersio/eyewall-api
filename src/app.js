// The EyeWall public API: routes, middleware and the generated OpenAPI 3.1
// document. Kept apart from index.js so tests and scripts/write-openapi.js
// can import the app without a Workers runtime.

import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { Scalar } from '@scalar/hono-api-reference';
import { API_VERSION, ATTRIBUTION, DOCS_URL, LICENSE_CC_BY } from './schemas.js';
import { UpstreamError } from './poller.js';
import { problem } from './respond.js';
import { registerReference } from './routes/reference.js';
import { registerElo } from './routes/elo.js';
import { registerGames } from './routes/games.js';
import { registerGameXg } from './routes/gameXg.js';
import { registerPlayoffOdds } from './routes/playoffOdds.js';
import { registerScorecard } from './routes/scorecard.js';
import { registerPowerRankings } from './routes/powerRankings.js';
import { registerPercentiles } from './routes/percentiles.js';
import { registerLineups } from './routes/lineups.js';
import { registerNhlModels } from './routes/nhlModels.js';
import { registerNhlText } from './routes/nhlText.js';
import { CONTRACTS_TAG_DESCRIPTION, registerContracts } from './routes/contracts.js';

const DESCRIPTION = `Hockey models built by [EyeWall Analytics](https://eyewallanalytics.com) for the NHL, PWHL, AHL and ECHL: Elo ratings, pre-game win probabilities, expected goals per game, playoff odds, power rankings, player percentiles, projected lines, starting-goalie probabilities and a public scorecard of how the models have done; and NHL contracts from EyeWall's open [nhl-contracts](https://github.com/ehlersio/nhl-contracts) dataset.

**What's here.** Only numbers EyeWall produces, and the contracts dataset EyeWall collects. Box scores, play-by-play, rosters, standings and schedules belong to the leagues and aren't served here; responses carry league ids and team codes so you can join to those feeds yourself.

**Licence.** Data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit "${ATTRIBUTION}" wherever it appears. The exception is NHL models built on [MoneyPuck](https://moneypuck.com) inputs (WAR, NHL power rankings, team needs, trade fit, and EyeWall AI's NHL text): those are [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), non-commercial only, crediting MoneyPuck.com as well. NHL contracts are [CC0](https://creativecommons.org/publicdomain/zero/1.0/) (no credit required), like the dataset they come from. Each response's \`meta.license\` and \`meta.attribution\` say exactly what applies. Code is MIT ([github.com/ehlersio/eyewall-api](https://github.com/ehlersio/eyewall-api)).

**Limits.** 60 requests a minute per IP, no key needed. Responses are cached; most data changes once a night.

**Stability.** \`/v1\` only changes by adding things. A breaking change gets a \`/v2\`, and \`/v1\` keeps working for at least a full season after.

Probabilities are model estimates, not betting odds.`;

export const OPENAPI_CONFIG = {
  openapi: '3.1.0',
  info: {
    title: 'EyeWall API',
    version: API_VERSION,
    description: DESCRIPTION,
    license: { name: 'MIT (code); data CC BY 4.0, CC BY-NC 4.0 or CC0 per route', identifier: 'MIT' },
    contact: { name: 'EyeWall Analytics', url: 'https://eyewallanalytics.com' },
  },
  servers: [{ url: 'https://api.eyewallanalytics.com' }],
  // No authentication: every route is public.
  security: [],
  tags: [
    { name: 'Reference', description: 'Leagues, seasons and teams, for joining to other data.' },
    { name: 'Ratings', description: 'Team strength models.' },
    { name: 'Games', description: 'Per-game predictions and expected goals.' },
    { name: 'Playoff odds', description: 'Season simulations.' },
    { name: 'Rankings', description: 'Power rankings, with EyeWall AI\'s paragraph per team.' },
    { name: 'Players', description: 'Per-player percentiles and shot-quality numbers.' },
    { name: 'Lineups', description: 'Projected lines, team needs and starting goalies.' },
    { name: 'EyeWall AI', description: 'Recaps, previews and scouting reports written by EyeWall AI from EyeWall\'s data.' },
    { name: 'Contracts', description: CONTRACTS_TAG_DESCRIPTION },
    { name: 'Model grades', description: 'How the models have done.' },
  ],
};

// Header holding a route's own Cache-Control on its edge-cached copy.
export const ROUTE_CACHE_CONTROL = 'X-EyeWall-Cache-Control';

// A cached response with the route's Cache-Control back in place, and the
// internal header removed.
export function restoreCacheControl(hit) {
  const res = new Response(hit.body, hit);
  const original = res.headers.get(ROUTE_CACHE_CONTROL);
  if (original) res.headers.set('Cache-Control', original);
  res.headers.delete(ROUTE_CACHE_CONTROL);
  return res;
}

export function createApp() {
  const app = new OpenAPIHono({
    // A request that fails its schema (bad league, date, id) answers 400.
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues?.[0];
        const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
        return problem(c, 400, 'Bad Request', `${where}${issue?.message ?? 'invalid request'}`);
      }
    },
  });

  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'], maxAge: 86400 }));

  // Per-IP rate limit on the data routes.
  app.use('/v1/*', async (c, next) => {
    const limiter = c.env?.API_LIMITER;
    if (limiter) {
      const key = c.req.header('CF-Connecting-IP') || 'unknown';
      const { success } = await limiter.limit({ key });
      if (!success) {
        const res = problem(c, 429, 'Too Many Requests', 'limit is 60 requests a minute per IP; for whole tables use the bulk files');
        res.headers.set('Retry-After', '60');
        return res;
      }
    }
    await next();
  });

  // Edge cache: a hit never reaches the poller. Workers' Cache API only
  // exists on a custom domain, which is where this runs; elsewhere (tests,
  // workers.dev) the step is skipped.
  //
  // A cached copy comes back with the zone's Browser Cache TTL (4 hours)
  // in place of a shorter max-age, so every hit told browsers to keep it 4
  // hours. The route's own Cache-Control is stored next to the copy and put
  // back on a hit.
  app.use('/v1/*', async (c, next) => {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (!cache || c.req.method !== 'GET') return next();
    const hit = await cache.match(c.req.raw);
    if (hit) return restoreCacheControl(hit);
    await next();
    const cacheControl = c.res.headers.get('Cache-Control') || '';
    if (c.res.status === 200 && /max-age=[1-9]/.test(cacheControl)) {
      const copy = c.res.clone();
      const stored = new Response(copy.body, copy);
      stored.headers.set(ROUTE_CACHE_CONTROL, cacheControl);
      c.executionCtx.waitUntil(cache.put(c.req.raw, stored));
    }
  });

  registerReference(app);
  registerElo(app);
  registerGames(app);
  registerGameXg(app);
  registerPlayoffOdds(app);
  registerScorecard(app);
  // NHL routes before the {league} ones: /v1/nhl/power-rankings must not
  // match /v1/{league}/power-rankings (PWHL/AHL/ECHL only, a 400 for nhl).
  registerNhlModels(app);
  registerNhlText(app);
  registerContracts(app);
  registerPowerRankings(app);
  registerPercentiles(app);
  registerLineups(app);

  app.doc31('/openapi.json', OPENAPI_CONFIG);
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'EyeWall API' }));
  app.get('/', c => c.json({
    name: 'EyeWall API',
    version: API_VERSION,
    docs: DOCS_URL,
    openapi: 'https://api.eyewallanalytics.com/openapi.json',
    license: LICENSE_CC_BY,
    attribution: ATTRIBUTION,
  }, 200, { 'Cache-Control': 'public, max-age=3600' }));

  // A plain-text index for AI agents and crawlers (llmstxt.org), built
  // from the same OpenAPI document so it lists every route.
  app.get('/llms.txt', c => {
    const doc = app.getOpenAPI31Document(OPENAPI_CONFIG);
    const lines = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.values(ops).map(op => `- GET ${path}: ${op.summary}`));
    const text = [
      '# EyeWall API',
      '',
      `> ${OPENAPI_CONFIG.info.description.split('\n')[0]}`,
      '',
      'No key needed; 60 requests a minute per IP. Every success is { data, meta }; meta.license and meta.attribution say how to credit it. NHL models built on MoneyPuck inputs are CC BY-NC 4.0 (non-commercial).',
      '',
      '## Docs',
      '',
      '- [OpenAPI 3.1 spec](https://api.eyewallanalytics.com/openapi.json): parameters and response schemas for every route',
      `- [Interactive docs](${DOCS_URL})`,
      '- [Bulk files](https://github.com/ehlersio/eyewall-api/releases/tag/data): nightly JSON and CSV of every league-wide table',
      '',
      '## Routes',
      '',
      ...lines,
      '',
    ].join('\n');
    return c.text(text, 200, { 'Cache-Control': 'public, max-age=3600' });
  });

  app.notFound(c => problem(c, 404, 'Not Found', 'see /docs for the routes'));
  app.onError((err, c) => {
    if (err instanceof UpstreamError) {
      if (err.status === 404) return problem(c, 404, 'Not Found');
      if (err.status === 400) return problem(c, 400, 'Bad Request', err.message);
      return problem(c, err.status === 503 ? 503 : 502, err.status === 503 ? 'Service Unavailable' : 'Bad Gateway', err.message);
    }
    console.error(err);
    return problem(c, 500, 'Internal Server Error');
  });

  return app;
}

export const app = createApp();
