// /v1/{league}/elo

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, LeagueParam, meta, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

export const ELO_FORMULA = 'P(home win) = 1 / (1 + 10^((awayRating - (homeRating + homeAdvantage)) / 400)); no home advantage at a neutral site';

const EloRating = z.object({
  team: TeamRef,
  rating: z.number().openapi({ example: 1577.5 }),
}).openapi('EloRating');

export const Elo = z.object({
  homeAdvantage: z.number().openapi({ description: 'Elo points added to the home team.', example: 35 }),
  formula: z.string().openapi({ example: ELO_FORMULA }),
  ratings: z.array(EloRating).openapi({ description: 'Current teams with a rating, highest first. A team with no games in EyeWall\'s replay yet (e.g. an expansion team before its first game) is left out.' }),
}).openapi('Elo');

export function shapeElo(raw, index) {
  const ratings = Object.entries(raw?.ratings ?? {})
    .map(([key, rating]) => ({ team: index.find(key), rating: Number(rating) }))
    .filter(r => r.team && Number.isFinite(r.rating))
    .map(r => ({ team: teamRef(r.team), rating: Math.round(r.rating * 100) / 100 }))
    .sort((a, b) => b.rating - a.rating);
  return { homeAdvantage: Number(raw?.homeAdvantage), formula: ELO_FORMULA, ratings };
}

export function registerElo(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/elo', operationId: 'getElo', tags: ['Ratings'],
    summary: 'Elo team ratings',
    description: 'EyeWall\'s Elo ratings, recomputed nightly from scratch: every NHL regular-season game, or every PWHL/AHL/ECHL regular-season and playoff game since 2023-24, with teams regressed toward the mean between seasons. Win probabilities on `/games` use these ratings and the formula given here.',
    request: { params: LeagueParam },
    responses: {
      200: { description: 'Ratings', content: { 'application/json': { schema: envelope('EloResponse', Elo) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const [raw, index] = await Promise.all([
      poller(c.env, `/elo/ratings?league=${league}`),
      teamIndex(c.env, league),
    ]);
    return send(c, shapeElo(raw, index), meta(league, 'EyeWall Elo (nightly replay)'), 3600);
  });
}
