// /v1/{pwhl|ahl|echl}/players/{playerId}/percentiles
// /v1/{pwhl|ahl|echl}/goalies/{playerId}/percentiles
//
// Percentile ranks EyeWall computes against the league's qualified pool,
// plus EyeWall's own shot-quality numbers (xG from shot location, goals
// saved above expected). The league's raw counting stats aren't repeated.

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, HockeyTechLeague, meta, NumericId, problemResponses } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

const Percentile = z.object({
  percentile: z.number().int().min(0).max(100).nullable().openapi({ description: '0-100 rank against the league pool. Null when the player is below the sample floor or the stat has no data.' }),
  label: z.string(),
  description: z.string(),
}).openapi('Percentile');

const PlayerHeader = {
  playerId: z.number().int(),
  team: z.object({ id: z.number().int(), code: z.string(), name: z.string().nullable() }).nullable(),
  season: z.number().int().nullable(),
  seasonType: z.string().nullable(),
  rateBasis: z.string().nullable().openapi({ description: 'What the rates are per, e.g. "perGP" (per game played) where the league publishes no ice time.' }),
};

export const SkaterPercentiles = z.object({
  ...PlayerHeader,
  expectedGoals: z.number().nullable().openapi({ description: 'EyeWall xG from shot locations.' }),
  goalsAboveExpected: z.number().nullable(),
  percentiles: z.record(z.string(), Percentile).openapi({ description: 'Keyed by stat: goals, a1 (primary assists), penalties, finishing.' }),
}).openapi('SkaterPercentiles');

export const GoaliePercentiles = z.object({
  ...PlayerHeader,
  goalsSavedAboveExpected: z.number().nullable().openapi({ description: 'From EyeWall\'s danger-zone xG on the shots faced.' }),
  goalsSavedAboveExpectedPerGame: z.number().nullable(),
  savePercentage: z.object({
    evenStrength: z.number().nullable(),
    highDanger: z.number().nullable(),
    mediumDanger: z.number().nullable(),
    penaltyKill: z.number().nullable(),
  }).openapi({ description: 'Save percentage by situation and danger zone, 0-100.' }),
  percentiles: z.record(z.string(), Percentile).openapi({ description: 'Keyed by stat: gsax, gsax60, evSv, hdSv, mdSv, pkSv.' }),
}).openapi('GoaliePercentiles');

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function shapePercentiles(p) {
  return Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, {
    percentile: v?.pct == null ? null : Math.round(Number(v.pct)),
    label: v?.label ?? k,
    description: v?.note ?? '',
  }]));
}

function header(raw, index) {
  const t = raw?.team_id != null ? index.find(raw.team_id) : null;
  return {
    playerId: Number(raw.player_id),
    team: t ? teamRef(t) : null,
    season: num(raw.season_id),
    seasonType: raw.season_type ?? null,
    rateBasis: raw.rateBasis ?? null,
  };
}

export function shapeSkater(raw, index) {
  return {
    ...header(raw, index),
    expectedGoals: num(raw.xg_for),
    goalsAboveExpected: num(raw.finishing),
    percentiles: shapePercentiles(raw.percentiles),
  };
}

export function shapeGoalie(raw, index) {
  return {
    ...header(raw, index),
    goalsSavedAboveExpected: num(raw.gsax),
    goalsSavedAboveExpectedPerGame: num(raw.gsax60),
    savePercentage: {
      evenStrength: num(raw.evSvPct),
      highDanger: num(raw.hdSvPct),
      mediumDanger: num(raw.mdSvPct),
      penaltyKill: num(raw.pkSvPct),
    },
    percentiles: shapePercentiles(raw.percentiles),
  };
}

const request = {
  params: z.object({
    league: HockeyTechLeague.openapi({ param: { name: 'league', in: 'path' } }),
    playerId: NumericId('playerId', '10978'),
  }),
  query: z.object({
    season: z.string().regex(/^\d{1,8}$/).optional().openapi({ param: { name: 'season', in: 'query' }, description: 'Season id (see /seasons). Defaults to the latest regular season.' }),
  }),
};

function register(app, kind) {
  const goalie = kind === 'goalie';
  app.openapi(createRoute({
    method: 'get',
    path: `/v1/{league}/${goalie ? 'goalies' : 'players'}/{playerId}/percentiles`,
    operationId: goalie ? 'getGoaliePercentiles' : 'getSkaterPercentiles',
    tags: ['Players'],
    summary: goalie ? 'Goalie percentiles (PWHL, AHL, ECHL)' : 'Skater percentiles (PWHL, AHL, ECHL)',
    description: 'Percentile ranks against the league\'s qualified pool for the season. Player ids are HockeyTech ids.',
    request,
    responses: {
      200: {
        description: 'Percentiles',
        content: { 'application/json': { schema: envelope(goalie ? 'GoaliePercentilesResponse' : 'SkaterPercentilesResponse', goalie ? GoaliePercentiles : SkaterPercentiles) } },
      },
      ...problemResponses,
    },
  }), async c => {
    const { league, playerId } = c.req.valid('param');
    const { season } = c.req.valid('query');
    const [raw, index] = await Promise.all([
      poller(c.env, `/${league}/${kind}/percentiles?id=${playerId}${season ? `&season=${season}` : ''}`),
      teamIndex(c.env, league),
    ]);
    // The poller answers an unknown id (or a skater asked as a goalie) with
    // an all-null row and no season.
    if (!raw || raw.player_id == null || raw.season_id == null || !raw.percentiles) {
      return problem(c, 404, 'Not Found', `no ${kind} season row for this id${season ? ' and season' : ''}`);
    }
    const data = goalie ? shapeGoalie(raw, index) : shapeSkater(raw, index);
    return send(c, data, meta(league, 'EyeWall percentiles'), 3600);
  });
}

export function registerPercentiles(app) {
  register(app, 'player');
  register(app, 'goalie');
}
