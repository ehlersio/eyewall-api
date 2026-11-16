// /v1/nhl/scorecard

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, meta, problemResponses } from '../schemas.js';
import { poller } from '../poller.js';
import { send } from '../respond.js';

const Grade = z.object({
  model: z.string(),
  kind: z.enum(['live', 'backtest']),
  period: z.string().openapi({ example: '2026-27' }),
  status: z.string().openapi({ description: '"ok", or "pending" before there is anything to grade.' }),
  n: z.number().int().openapi({ description: 'Predictions graded.' }),
  accuracy: z.number().nullable(),
  brier: z.number().nullable(),
  logLoss: z.number().nullable(),
  baseline: z.object({
    name: z.string(),
    brier: z.number().nullable(),
    accuracy: z.number().nullable(),
  }).nullable().openapi({ description: 'A naive rule to beat, scored on the same predictions.' }),
  calibration: z.array(z.object({
    bucket: z.number().int(),
    predicted: z.number(),
    actual: z.number(),
    n: z.number().int(),
  })),
  recent: z.array(z.record(z.string(), z.unknown())).openapi({ description: 'The latest graded predictions (live grades only).' }),
  note: z.string().nullable(),
  updatedAt: z.string().nullable(),
}).openapi('ModelGrade');

export const Scorecard = z.object({
  updatedAt: z.string().nullable(),
  models: z.record(z.string(), z.object({
    live: Grade.nullable(),
    backtest: Grade.nullable(),
  })).openapi({ description: 'Keyed by model: gameWinner, startingGoalie, playoffOdds.' }),
}).openapi('Scorecard');

const camel = s => s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

export function camelize(v) {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelize(x)]));
  return v;
}

export function shapeScorecard(raw) {
  const models = {};
  for (const [name, grades] of Object.entries(raw?.models ?? {})) {
    models[camel(name)] = {
      live: grades?.live ? camelize(grades.live) : null,
      backtest: grades?.backtest ? camelize(grades.backtest) : null,
    };
  }
  return { updatedAt: raw?.updatedAt ?? null, models };
}

export function registerScorecard(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/scorecard', operationId: 'getNhlScorecard', tags: ['Model grades'],
    summary: 'How EyeWall\'s NHL models have done',
    description: 'Each model graded against results: this season\'s live predictions (logged before puck drop) and a backtest over past seasons, with accuracy, Brier score, log loss, a naive baseline and calibration buckets.',
    responses: {
      200: { description: 'Scorecard', content: { 'application/json': { schema: envelope('ScorecardResponse', Scorecard) } } },
      ...problemResponses,
    },
  }), async c => {
    const data = shapeScorecard(await poller(c.env, '/scorecard'));
    return send(c, data, meta('nhl', 'EyeWall prediction scorecard', data.updatedAt), 3600);
  });
}
