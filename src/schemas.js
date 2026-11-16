// Shared OpenAPI schemas: the response envelope, errors, leagues, teams.

import { z } from '@hono/zod-openapi';

export const API_VERSION = '1.0.0';
export const DOCS_URL = 'https://api.eyewallanalytics.com/docs';

export const LICENSE_CC_BY = 'CC-BY-4.0';
export const ATTRIBUTION = 'EyeWall Analytics (eyewallanalytics.com)';

export const LEAGUES = ['nhl', 'pwhl', 'ahl', 'echl'];
export const HOCKEYTECH_LEAGUES = ['pwhl', 'ahl', 'echl'];

export const League = z.enum(LEAGUES).openapi('League', {
  description: 'League id. NHL ids come from the NHL; PWHL, AHL and ECHL ids are HockeyTech ids.',
  example: 'nhl',
});

export const LeagueParam = z.object({
  league: League.openapi({ param: { name: 'league', in: 'path' } }),
});

export const Meta = z.object({
  league: League.nullable(),
  source: z.string().openapi({ description: 'Which EyeWall model or table the data comes from.' }),
  license: z.string().openapi({ example: LICENSE_CC_BY }),
  attribution: z.string().openapi({ description: 'Credit line to show wherever the data appears.', example: ATTRIBUTION }),
  generatedAt: z.string().nullable().openapi({ description: 'When EyeWall produced this data (ISO 8601 date or timestamp), null when unknown.' }),
  docs: z.string(),
}).openapi('Meta');

// `{ data, meta }` with `data` of the given schema.
export function envelope(name, data) {
  return z.object({ data, meta: Meta }).openapi(name);
}

export const Problem = z.object({
  type: z.string().openapi({ example: 'about:blank' }),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
}).openapi('Problem', { description: 'RFC 9457 problem details.' });

export const problemResponses = {
  400: { description: 'Invalid parameter', content: { 'application/problem+json': { schema: Problem } } },
  404: { description: 'Not found', content: { 'application/problem+json': { schema: Problem } } },
  429: { description: 'Rate limit exceeded (60 requests a minute per IP)', content: { 'application/problem+json': { schema: Problem } } },
  502: { description: 'The data source answered with an error', content: { 'application/problem+json': { schema: Problem } } },
  503: { description: 'The data source is temporarily unavailable', content: { 'application/problem+json': { schema: Problem } } },
};

export const TeamRef = z.object({
  id: z.number().int().openapi({ description: 'League team id (NHL team id, or HockeyTech team id).', example: 12 }),
  code: z.string().openapi({ example: 'CAR' }),
  name: z.string().nullable().openapi({ example: 'Carolina Hurricanes' }),
}).openapi('TeamRef');

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '2026-11-16' });

export function meta(league, source, generatedAt = null) {
  return {
    league,
    source,
    license: LICENSE_CC_BY,
    attribution: ATTRIBUTION,
    generatedAt,
    docs: DOCS_URL,
  };
}
