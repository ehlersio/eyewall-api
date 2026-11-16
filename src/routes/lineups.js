// /v1/nhl/teams/{team}/projected-lines  and  /v1/nhl/games/{gameId}/goalie-starts

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, IsoDate, meta, NumericId, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

const LinePlayer = z.object({
  id: z.number().int().openapi({ description: 'NHL player id.' }),
  name: z.string(),
  position: z.string().nullable().openapi({ example: 'C' }),
  filledIn: z.boolean().openapi({ description: 'True for a player who wasn\'t in the lineup the projection is based on (replacing an injured or moved player): the least certain part.' }),
}).openapi('LinePlayer');

const Unit = z.object({ rank: z.number().int(), players: z.array(LinePlayer) }).openapi('LineUnit');

export const ProjectedLines = z.object({
  team: TeamRef,
  basis: z.enum(['last_game', 'preseason']).nullable().openapi({ description: '"last_game": the last game\'s pairings, adjusted for who is out. "preseason": pooled preseason pairings before a team\'s first game. Null when there is no projection yet.' }),
  basisGameId: z.number().int().nullable(),
  generatedAt: z.string().nullable(),
  forwardLines: z.array(Unit).openapi({ description: 'Left wing, center, right wing; top line first.' }),
  defensePairs: z.array(Unit),
}).openapi('ProjectedLines');

const GoalieStart = z.object({
  goalie: z.object({ id: z.number().int(), name: z.string() }),
  startProbability: z.number().min(0).max(1),
  factors: z.object({
    daysRest: z.number().int().nullable(),
    backToBack: z.boolean().nullable(),
    startedLastGame: z.boolean().nullable(),
    shareOfLast10Starts: z.number().nullable(),
    noRecentStarts: z.boolean().nullable(),
  }).openapi({ description: 'The inputs the model weighed.' }),
}).openapi('GoalieStart');

export const GoalieStarts = z.object({
  gameId: z.number().int(),
  date: IsoDate.nullable(),
  loggedOn: IsoDate.nullable(),
  teams: z.array(z.object({ team: TeamRef, goalies: z.array(GoalieStart) })).openapi({ description: 'Each team\'s goalies, most likely starter first.' }),
}).openapi('GoalieStarts');

const bool = v => (typeof v === 'boolean' ? v : null);
const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function unit(u) {
  return {
    rank: Number(u.rank),
    players: (u.players ?? []).map(p => ({ id: Number(p.id), name: p.name, position: p.pos ?? null, filledIn: Boolean(p.filled) })),
  };
}

export function shapeProjectedLines(raw, team) {
  return {
    team: teamRef(team),
    basis: raw?.basis === 'last_game' || raw?.basis === 'preseason' ? raw.basis : null,
    basisGameId: num(raw?.basisGameId),
    generatedAt: raw?.generatedAt ?? null,
    forwardLines: (raw?.lines ?? []).map(unit),
    defensePairs: (raw?.pairs ?? []).map(unit),
  };
}

// ESPN's injury status (factors.injury_status) is left out: it isn't
// EyeWall's data.
export function shapeGoalieStarts(raw, index) {
  const teams = Object.entries(raw?.teams ?? {})
    .map(([code, goalies]) => ({ t: index.find(code), goalies }))
    .filter(({ t }) => t)
    .map(({ t, goalies }) => ({
      team: teamRef(t),
      goalies: (goalies ?? [])
        .map(g => ({
          goalie: { id: Number(g.goalie_id), name: g.goalie_name },
          startProbability: Number(g.start_prob),
          factors: {
            daysRest: num(g.factors?.days_rest),
            backToBack: bool(g.factors?.back_to_back),
            startedLastGame: bool(g.factors?.started_last),
            shareOfLast10Starts: num(g.factors?.share_last10),
            noRecentStarts: bool(g.factors?.no_recent),
          },
        }))
        .sort((a, b) => b.startProbability - a.startProbability),
    }));
  return { gameId: Number(raw.gameId), date: raw.gameDate ?? null, loggedOn: raw.runDate ?? null, teams };
}

export function registerLineups(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/teams/{team}/projected-lines', operationId: 'getProjectedLines', tags: ['Lineups'],
    summary: 'Projected lines for a team\'s next game (NHL)',
    description: 'EyeWall\'s nightly projection of each team\'s forward lines and defense pairs for its next game.',
    request: {
      params: z.object({ team: z.string().regex(/^[A-Za-z]{3}$/).openapi({ param: { name: 'team', in: 'path' }, example: 'CAR' }) }),
    },
    responses: {
      200: { description: 'Projected lines', content: { 'application/json': { schema: envelope('ProjectedLinesResponse', ProjectedLines) } } },
      ...problemResponses,
    },
  }), async c => {
    const code = c.req.valid('param').team.toUpperCase();
    const index = await teamIndex(c.env, 'nhl');
    const team = index.find(code);
    if (!team) return problem(c, 404, 'Not Found', `no current NHL team ${code} (see /v1/nhl/teams)`);
    const data = shapeProjectedLines(await poller(c.env, `/projected-lines?team=${code}`), team);
    return send(c, data, meta('nhl', 'EyeWall projected lines', data.generatedAt), data.basis ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/games/{gameId}/goalie-starts', operationId: 'getGoalieStarts', tags: ['Lineups'],
    summary: 'Starting goalie probabilities for a game (NHL)',
    description: 'Each goalie\'s chance of starting, logged the morning of the game (and the day before). Graded on /v1/nhl/scorecard as startingGoalie.',
    request: { params: z.object({ gameId: NumericId('gameId', '2026020333') }) },
    responses: {
      200: { description: 'Goalie starts', content: { 'application/json': { schema: envelope('GoalieStartsResponse', GoalieStarts) } } },
      ...problemResponses,
    },
  }), async c => {
    const { gameId } = c.req.valid('param');
    const [raw, index] = await Promise.all([
      poller(c.env, `/probable-starters?game=${gameId}`),
      teamIndex(c.env, 'nhl'),
    ]);
    const data = shapeGoalieStarts(raw, index);
    if (!data.teams.length) return problem(c, 404, 'Not Found', 'no start probabilities are logged for this game (logged the day before and the morning of)');
    return send(c, data, meta('nhl', 'EyeWall starting goalie model', data.loggedOn), 1800);
  });
}
