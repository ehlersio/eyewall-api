// /v1/{league}/playoff-odds

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, IsoDate, League, meta, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

const Probability = z.number().min(0).max(1).nullable();

const TeamOdds = z.object({
  team: TeamRef,
  playoffProbability: Probability.openapi({ description: 'Share of simulations in which the team makes the playoffs. Null when the league hasn\'t published this season\'s playoff format.' }),
  divisionProbability: Probability.openapi({ description: 'Share of simulations in which the team wins its division. Null where the format has no division title.' }),
  projectedPoints: z.object({
    mean: z.number().nullable().openapi({ description: 'NHL only.' }),
    p10: z.number().nullable(),
    p50: z.number().nullable().openapi({ description: 'PWHL/AHL/ECHL only.' }),
    p90: z.number().nullable(),
  }).openapi({ description: 'Final standings points across the simulations.' }),
  currentPoints: z.number().nullable(),
  gamesPlayed: z.number().int().nullable(),
  gamesRemaining: z.number().int().nullable(),
  eloRating: z.number().nullable().openapi({ description: 'NHL only: the rating the simulation started from.' }),
}).openapi('TeamPlayoffOdds');

export const PlayoffOdds = z.object({
  season: z.number().int().nullable(),
  runDate: IsoDate.nullable().openapi({ description: 'The nightly run these numbers come from.' }),
  stale: z.boolean().openapi({ description: 'True when the latest run is older than expected (the nightly job missed a run).' }),
  simulations: z.number().int().nullable(),
  format: z.string().nullable().openapi({ description: 'PWHL/AHL/ECHL: the playoff format the simulation used, or "unverified".' }),
  note: z.string().nullable(),
  teams: z.array(TeamOdds).openapi({ description: 'Highest playoff probability first.' }),
}).openapi('PlayoffOdds');

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const int = v => (num(v) == null ? null : Math.round(Number(v)));

export function shapePlayoffOdds(league, raw, index) {
  const nhl = league === 'nhl';
  const teams = (raw?.teams ?? [])
    .map(r => ({ r, t: index.find(nhl ? r.team : r.team_id) }))
    .filter(({ t }) => t)
    .map(({ r, t }) => (nhl
      ? {
          team: teamRef(t),
          playoffProbability: num(r.playoff_pct),
          divisionProbability: num(r.division_pct),
          projectedPoints: { mean: num(r.proj_points), p10: num(r.points_p10), p50: null, p90: num(r.points_p90) },
          currentPoints: num(r.current_points),
          gamesPlayed: int(r.games_played),
          gamesRemaining: int(r.games_remaining),
          eloRating: num(r.elo_rating),
          sims: int(r.sims),
          format: null,
        }
      : {
          team: teamRef(t),
          playoffProbability: num(r.make_playoffs_pct),
          divisionProbability: num(r.win_division_pct),
          projectedPoints: { mean: null, p10: num(r.proj_points_p10), p50: num(r.proj_points_p50), p90: num(r.proj_points_p90) },
          currentPoints: num(r.current_points),
          gamesPlayed: int(r.games_played),
          gamesRemaining: int(r.games_remaining),
          eloRating: null,
          sims: int(r.sims),
          format: r.format ?? null,
        }));

  const simulations = teams.find(t => t.sims != null)?.sims ?? null;
  const format = teams.find(t => t.format)?.format ?? null;
  const out = teams.map(({ sims: _s, format: _f, ...rest }) => rest);
  const key = t => [t.playoffProbability ?? -1, t.projectedPoints.p50 ?? t.projectedPoints.mean ?? -1];
  out.sort((a, b) => {
    const [ap, aq] = key(a); const [bp, bq] = key(b);
    return bp - ap || bq - aq || a.team.code.localeCompare(b.team.code);
  });
  const anyNullPlayoff = out.length > 0 && out.every(t => t.playoffProbability == null);
  return {
    season: num(raw?.season),
    runDate: raw?.runDate ?? null,
    stale: Boolean(raw?.stale),
    simulations,
    format,
    note: anyNullPlayoff
      ? 'The league has not published this season\'s playoff format, so playoff probabilities are null; projected points are still simulated.'
      : null,
    teams: out,
  };
}

export function registerPlayoffOdds(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/playoff-odds', operationId: 'getPlayoffOdds', tags: ['Playoff odds'],
    summary: 'Playoff probabilities for every team',
    description: 'A nightly Monte Carlo simulation of the rest of the regular season from EyeWall\'s Elo ratings. Probabilities are model estimates, not odds.',
    request: {
      params: z.object({ league: League.openapi({ param: { name: 'league', in: 'path' } }) }),
      query: z.object({
        season: z.string().regex(/^\d{1,8}$/).optional().openapi({ param: { name: 'season', in: 'query' }, description: 'Season id (see /seasons). Defaults to the latest run.', example: '20262027' }),
      }),
    },
    responses: {
      200: { description: 'Playoff odds', content: { 'application/json': { schema: envelope('PlayoffOddsResponse', PlayoffOdds) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const { season } = c.req.valid('query');
    const [raw, index] = await Promise.all([
      poller(c.env, `/playoff-odds/league?league=${league}${season ? `&season=${season}` : ''}`),
      teamIndex(c.env, league),
    ]);
    const data = shapePlayoffOdds(league, raw, index);
    return send(c, data, meta(league, 'EyeWall playoff odds simulation', data.runDate), data.teams.length ? 3600 : 300);
  });
}
