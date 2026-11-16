// Shared OpenAPI schemas: the response envelope, errors, leagues, teams.

import { z } from '@hono/zod-openapi';

export const API_VERSION = '1.3.1';
export const DOCS_URL = 'https://api.eyewallanalytics.com/docs';

export const LICENSE_CC_BY = 'CC-BY-4.0';
export const ATTRIBUTION = 'EyeWall Analytics (eyewallanalytics.com)';

// Models with MoneyPuck inputs: MoneyPuck's data is free for
// non-commercial use with credit, so these carry both.
export const LICENSE_CC_BY_NC = 'CC-BY-NC-4.0';
export const ATTRIBUTION_MONEYPUCK = 'EyeWall Analytics (eyewallanalytics.com), using data from MoneyPuck.com';
export const NC_DESCRIPTION = 'Built on MoneyPuck inputs: CC BY-NC 4.0, non-commercial use only, credit EyeWall Analytics and MoneyPuck.com.';

export const LEAGUES = ['nhl', 'pwhl', 'ahl', 'echl'];
export const HOCKEYTECH_LEAGUES = ['pwhl', 'ahl', 'echl'];

export const HockeyTechLeague = z.enum(HOCKEYTECH_LEAGUES).openapi('HockeyTechLeague', {
  description: 'PWHL, AHL or ECHL (HockeyTech ids).',
  example: 'ahl',
});

export const Locale = z.enum(['en', 'fr']).openapi('Locale', { description: 'Language of EyeWall AI text.', example: 'en' });

// A HockeyTech, NHL or game id in a path.
export const NumericId = (name, example) => z.string().regex(/^\d{1,15}$/)
  .openapi({ param: { name, in: 'path' }, example });

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

export function metaNC(league, source, generatedAt = null) {
  return meta(league, source, generatedAt, { license: LICENSE_CC_BY_NC, attribution: ATTRIBUTION_MONEYPUCK });
}

export const NhlTeamParam = z.object({
  team: z.string().regex(/^[A-Za-z]{3}$/).openapi({ param: { name: 'team', in: 'path' }, example: 'CAR' }),
});

export function meta(league, source, generatedAt = null, { license = LICENSE_CC_BY, attribution = ATTRIBUTION } = {}) {
  return {
    league,
    source,
    license,
    attribution,
    generatedAt,
    docs: DOCS_URL,
  };
}
