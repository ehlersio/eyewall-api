// /v1/leagues, /v1/{league}/seasons, /v1/{league}/teams

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, League, LeagueParam, meta, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';

const LEAGUE_INFO = [
  { id: 'nhl', name: 'National Hockey League', idSource: 'NHL' },
  { id: 'pwhl', name: "Professional Women's Hockey League", idSource: 'HockeyTech' },
  { id: 'ahl', name: 'American Hockey League', idSource: 'HockeyTech' },
  { id: 'echl', name: 'ECHL', idSource: 'HockeyTech' },
];

export const LeagueInfo = z.object({
  id: League,
  name: z.string(),
  idSource: z.enum(['NHL', 'HockeyTech']).openapi({ description: 'Where the league\'s team, game and player ids come from.' }),
}).openapi('LeagueInfo');

const SeasonType = z.enum(['regular', 'playoffs', 'preseason', 'allstar']).nullable().openapi('SeasonType', {
  description: 'HockeyTech season type. Null for the NHL, whose season id covers preseason, regular season and playoffs (game type is per game).',
});

const Season = z.object({
  id: z.number().int().openapi({ example: 20262027 }),
  label: z.string().openapi({ example: '2026-27' }),
  type: SeasonType,
  startYear: z.number().int().nullable(),
}).openapi('Season');

const CurrentSeason = z.object({
  id: z.number().int(),
  type: SeasonType,
  startDate: z.string().nullable().optional(),
}).openapi('CurrentSeason');

export const Seasons = z.object({
  current: CurrentSeason.openapi({ description: 'The season EyeWall treats as current. For the PWHL this is the latest regular season until the next one starts.' }),
  next: CurrentSeason.nullable().openapi({ description: 'PWHL only: the next regular season once it is scheduled. Null otherwise.' }),
  seasons: z.array(Season).openapi({ description: 'Seasons EyeWall has team data for, newest first.' }),
}).openapi('Seasons');

const nhlLabel = id => {
  const y = Math.floor(Number(id) / 10000);
  return `${y}-${String(y + 1).slice(2)}`;
};

const KNOWN_TYPES = new Set(['regular', 'playoffs', 'preseason', 'allstar']);
const seasonType = t => (KNOWN_TYPES.has(t) ? t : null);

// `names`: AHL/ECHL [{ seasonId, seasonName }] from the poller's season
// list, since their comparison entries carry no label.
export function shapeSeasons(league, config, comparison, names = []) {
  const nameById = new Map((names ?? []).map(s => [Number(s.seasonId), s.seasonName]));
  const nhl = league === 'nhl';
  const cur = config?.[league];
  if (!cur?.seasonId) return null;
  const list = (comparison?.[league]?.seasons ?? []).map(s => (nhl
    ? { id: Number(s.season), label: nhlLabel(s.season), type: null, startYear: Math.floor(Number(s.season) / 10000) }
    : { id: Number(s.seasonId), label: s.label ?? nameById.get(Number(s.seasonId)) ?? String(s.seasonId), type: seasonType(s.seasonType), startYear: s.startYear ?? null }));
  list.sort((a, b) => b.id - a.id);
  const next = league === 'pwhl' && cur.next?.seasonId
    ? { id: Number(cur.next.seasonId), type: seasonType(cur.next.seasonType), startDate: cur.next.startDate ?? null }
    : null;
  return {
    current: { id: Number(cur.seasonId), type: nhl ? null : seasonType(cur.seasonType) },
    next,
    seasons: list,
  };
}

export function registerReference(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/leagues', operationId: 'listLeagues', tags: ['Reference'],
    summary: 'Leagues covered',
    responses: {
      200: { description: 'Leagues', content: { 'application/json': { schema: envelope('LeaguesResponse', z.array(LeagueInfo)) } } },
      429: problemResponses[429],
    },
  }), c => send(c, LEAGUE_INFO, meta(null, 'static'), 86400));

  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/seasons', operationId: 'getSeasons', tags: ['Reference'],
    summary: 'Current season and seasons with data',
    request: { params: LeagueParam },
    responses: {
      200: { description: 'Seasons', content: { 'application/json': { schema: envelope('SeasonsResponse', Seasons) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const [config, comparison, names] = await Promise.all([
      poller(c.env, '/config/seasons'),
      poller(c.env, '/config/seasons/comparison'),
      league === 'ahl' || league === 'echl' ? poller(c.env, `/config/seasons/${league}-seasons`) : [],
    ]);
    const data = shapeSeasons(league, config, comparison, names);
    if (!data) return problem(c, 503, 'Service Unavailable', 'season data unavailable');
    return send(c, data, meta(league, 'eyewall-poller /config/seasons'), 3600);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/teams', operationId: 'listTeams', tags: ['Reference'],
    summary: 'Current teams',
    description: 'Team ids, codes and names, for joining EyeWall data to the league\'s own feeds.',
    request: { params: LeagueParam },
    responses: {
      200: { description: 'Teams', content: { 'application/json': { schema: envelope('TeamsResponse', z.array(TeamRef)) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const { teams } = await poller(c.env, `/config/teams?league=${league}`);
    return send(c, teams.map(t => ({ id: t.id, code: t.code, name: t.name ?? null })), meta(league, 'eyewall-poller /config/teams'), 86400);
  });
}
