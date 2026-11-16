// /v1/{pwhl|ahl|echl}/power-rankings  and
// /v1/{pwhl|ahl|echl}/teams/{teamId}/power-ranking
//
// PWHL/AHL/ECHL only: their rankings use no MoneyPuck input. The NHL's
// do (WAR, xGF%), so they come with the CC BY-NC routes later.

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, HockeyTechLeague, IsoDate, Locale, meta, NumericId, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

const ComponentRanks = z.record(z.string(), z.number().int()).openapi('PowerRankingComponentRanks', {
  description: 'League rank (1 = best) in each part of the score: pts_pct (points percentage), l10_pts_pct (last 10 games), gd_pg (goal difference per game), special_teams.',
  example: { pts_pct: 1, l10_pts_pct: 1, gd_pg: 2, special_teams: 2 },
});

export const PowerRankingRow = z.object({
  rank: z.number().int(),
  previousRank: z.number().int().nullable().openapi({ description: 'Rank in the previous run; null on a team\'s first run.' }),
  team: TeamRef,
  score: z.number().openapi({ description: 'Weighted score, 0 to 1.' }),
  componentRanks: ComponentRanks,
}).openapi('PowerRankingRow');

const SeasonEcho = z.number().int().nullable().openapi({ description: 'The season asked for; null when none was given (the latest run).' });

export const PowerRankings = z.object({
  season: SeasonEcho,
  runDate: IsoDate.nullable(),
  teams: z.array(PowerRankingRow).openapi({ description: 'Best first. Empty before the season\'s first run.' }),
}).openapi('PowerRankings');

export const TeamPowerRanking = z.object({
  season: SeasonEcho,
  runDate: IsoDate.nullable(),
  ranking: PowerRankingRow.nullable().openapi({ description: 'Null before the season\'s first run.' }),
  narrative: z.string().nullable().openapi({ description: 'EyeWall AI\'s paragraph on the team\'s ranking, in the requested language. Null when none was written for this run.' }),
  history: z.array(z.object({ runDate: IsoDate, rank: z.number().int() })).openapi({ description: 'This season\'s recent runs, oldest first (up to 28).' }),
}).openapi('TeamPowerRanking');

function shapeRow(r, index) {
  const t = index.find(r.team_id);
  if (!t) return null;
  const ranks = r.components?.ranks ?? {};
  return {
    rank: Number(r.rank),
    previousRank: r.prior_rank != null ? Number(r.prior_rank) : null,
    team: teamRef(t),
    score: Number(r.score),
    componentRanks: Object.fromEntries(Object.entries(ranks).filter(([, v]) => Number.isInteger(v))),
  };
}

// The poller's latest rows carry no season or run date; a team's history
// gives the run date, and the season query is echoed back.
export function shapePowerRankings(raw, index, season = null) {
  const teams = (raw?.latest ?? []).map(r => shapeRow(r, index)).filter(Boolean).sort((a, b) => a.rank - b.rank);
  return { season, runDate: raw?.runDate ?? null, teams };
}

export function shapeTeamPowerRanking(raw, index, teamId, season = null) {
  const row = (raw?.latest ?? []).find(r => String(r.team_id) === String(teamId));
  const history = (raw?.history ?? []).map(h => ({ runDate: h.run_date, rank: Number(h.rank) }));
  return {
    season,
    runDate: raw?.narrative?.run_date ?? history.at(-1)?.runDate ?? null,
    ranking: row ? shapeRow(row, index) : null,
    narrative: raw?.narrative?.text ?? null,
    history,
  };
}

const seasonQuery = z.object({
  season: z.string().regex(/^\d{1,8}$/).optional().openapi({ param: { name: 'season', in: 'query' }, description: 'Season id (see /seasons). Defaults to the latest run.' }),
});

export function registerPowerRankings(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/power-rankings', operationId: 'getPowerRankings', tags: ['Rankings'],
    summary: 'Power rankings (PWHL, AHL, ECHL)',
    description: 'EyeWall\'s nightly power rankings: points percentage, the last 10 games, goal difference per game and special teams, weighted into one score. NHL rankings use MoneyPuck inputs and are not in this release.',
    request: { params: z.object({ league: HockeyTechLeague.openapi({ param: { name: 'league', in: 'path' } }) }), query: seasonQuery },
    responses: {
      200: { description: 'Power rankings', content: { 'application/json': { schema: envelope('PowerRankingsResponse', PowerRankings) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const { season } = c.req.valid('query');
    const q = season ? `&season=${season}` : '';
    // One team's view of the same run carries its run date in `history`.
    const [raw, index] = await Promise.all([
      poller(c.env, `/${league}/power-rankings?limit=100${q}`),
      teamIndex(c.env, league),
    ]);
    const data = shapePowerRankings(raw, index, season ? Number(season) : null);
    if (data.teams.length) {
      const top = await poller(c.env, `/${league}/power-rankings?teamId=${raw.latest[0].team_id}&limit=1${q}`);
      data.runDate = top?.history?.at(-1)?.run_date ?? null; // oldest first
    }
    return send(c, data, meta(league, 'EyeWall power rankings', data.runDate), data.teams.length ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/teams/{teamId}/power-ranking', operationId: 'getTeamPowerRanking', tags: ['Rankings'],
    summary: 'One team\'s power ranking, with EyeWall AI\'s paragraph (PWHL, AHL, ECHL)',
    request: {
      params: z.object({
        league: HockeyTechLeague.openapi({ param: { name: 'league', in: 'path' } }),
        teamId: NumericId('teamId', '328'),
      }),
      query: seasonQuery.extend({
        locale: Locale.optional().openapi({ param: { name: 'locale', in: 'query' } }),
      }),
    },
    responses: {
      200: { description: 'Team power ranking', content: { 'application/json': { schema: envelope('TeamPowerRankingResponse', TeamPowerRanking) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league, teamId } = c.req.valid('param');
    const { season, locale = 'en' } = c.req.valid('query');
    const index = await teamIndex(c.env, league);
    if (!index.find(teamId)) return problem(c, 404, 'Not Found', `no current ${league.toUpperCase()} team with id ${teamId} (see /v1/${league}/teams)`);
    const q = season ? `&season=${season}` : '';
    const raw = await poller(c.env, `/${league}/power-rankings?teamId=${teamId}&limit=100&locale=${locale}${q}`);
    const data = shapeTeamPowerRanking(raw, index, teamId, season ? Number(season) : null);
    return send(c, data, meta(league, 'EyeWall power rankings + EyeWall AI', data.runDate), data.ranking ? 3600 : 300);
  });
}
