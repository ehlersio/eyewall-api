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
import { registerPlayoffOdds } from './routes/playoffOdds.js';
import { registerScorecard } from './routes/scorecard.js';

const DESCRIPTION = `Hockey models built by [EyeWall Analytics](https://eyewallanalytics.com) for the NHL, PWHL, AHL and ECHL: Elo ratings, pre-game win probabilities, playoff odds and a public scorecard of how the models have done.

**What's here.** Only numbers EyeWall produces. Box scores, play-by-play, rosters, standings and schedules belong to the leagues and aren't served here; responses carry league ids and team codes so you can join to those feeds yourself.

**Licence.** Data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit "${ATTRIBUTION}" wherever it appears. Each response's \`meta.license\` and \`meta.attribution\` say exactly what applies. Code is MIT ([github.com/ehlersio/eyewall-api](https://github.com/ehlersio/eyewall-api)).

**Limits.** 60 requests a minute per IP, no key needed. Responses are cached; most data changes once a night.

**Stability.** \`/v1\` only changes by adding things. A breaking change gets a \`/v2\`, and \`/v1\` keeps working for at least a full season after.

Probabilities are model estimates, not betting odds.`;

export const OPENAPI_CONFIG = {
  openapi: '3.1.0',
  info: {
    title: 'EyeWall API',
    version: API_VERSION,
    description: DESCRIPTION,
    license: { name: 'MIT (code); data CC BY 4.0', identifier: 'MIT' },
    contact: { name: 'EyeWall Analytics', url: 'https://eyewallanalytics.com' },
  },
  servers: [{ url: 'https://api.eyewallanalytics.com' }],
  // No authentication: every route is public.
  security: [],
  tags: [
    { name: 'Reference', description: 'Leagues, seasons and teams, for joining to other data.' },
    { name: 'Ratings', description: 'Team strength models.' },
    { name: 'Games', description: 'Per-game predictions.' },
    { name: 'Playoff odds', description: 'Season simulations.' },
    { name: 'Model grades', description: 'How the models have done.' },
  ],
};

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
  app.use('/v1/*', async (c, next) => {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (!cache || c.req.method !== 'GET') return next();
    const hit = await cache.match(c.req.raw);
    if (hit) return new Response(hit.body, hit);
    await next();
    if (c.res.status === 200 && /max-age=[1-9]/.test(c.res.headers.get('Cache-Control') || '')) {
      c.executionCtx.waitUntil(cache.put(c.req.raw, c.res.clone()));
    }
  });

  registerReference(app);
  registerElo(app);
  registerGames(app);
  registerPlayoffOdds(app);
  registerScorecard(app);

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
