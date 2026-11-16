// /v1/{league}/games?date=  and  /v1/{league}/games/{gameId}/win-probability

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, IsoDate, League, meta, problemResponses } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex } from '../teams.js';

const GameTeam = z.object({
  id: z.number().int().nullable(),
  code: z.string().nullable(),
  name: z.string().nullable(),
}).openapi('GameTeam', { description: 'A team in a game. Fields are null only for a team that is no longer current (e.g. relocated).' });

export const Game = z.object({
  gameId: z.number().int().openapi({ example: 2026020331 }),
  date: IsoDate,
  season: z.number().int().nullable(),
  gameType: z.enum(['regular', 'playoffs']).nullable().openapi({ description: 'NHL only; null for PWHL/AHL/ECHL (see the season\'s type).' }),
  homeTeam: GameTeam,
  awayTeam: GameTeam,
  neutralSite: z.boolean().nullable().openapi({ description: 'NHL only; null for PWHL/AHL/ECHL.' }),
  homeRating: z.number().nullable(),
  awayRating: z.number().nullable(),
  homeWinProbability: z.number().min(0).max(1).openapi({ example: 0.4517 }),
  awayWinProbability: z.number().min(0).max(1).openapi({ example: 0.5483 }),
  loggedOn: IsoDate.nullable().openapi({ description: 'The morning (America/New_York) the probability was logged. The last pre-game log is kept, and is what EyeWall\'s public scorecard grades.' }),
}).openapi('GameWinProbability');

export const GamesForDate = z.object({
  date: IsoDate,
  games: z.array(Game),
}).openapi('GamesForDate');

const NHL_GAME_TYPES = { 2: 'regular', 3: 'playoffs' };

const round4 = x => Math.round(x * 10000) / 10000;

export function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function gameTeam(index, key, code) {
  const t = index.find(key);
  if (t) return { id: t.id, code: t.code, name: t.name ?? null };
  return { id: code ? null : Number(key) || null, code: code ?? null, name: null };
}

export function shapeGame(league, row, index) {
  const nhl = league === 'nhl';
  const p = Number(row.home_win_prob);
  return {
    gameId: Number(row.game_id),
    date: row.game_date,
    season: (nhl ? row.season : row.season_id) != null ? Number(nhl ? row.season : row.season_id) : null,
    gameType: nhl ? (NHL_GAME_TYPES[row.game_type] ?? null) : null,
    homeTeam: nhl ? gameTeam(index, row.home_team, row.home_team) : gameTeam(index, row.home_team_id),
    awayTeam: nhl ? gameTeam(index, row.away_team, row.away_team) : gameTeam(index, row.away_team_id),
    neutralSite: nhl ? Boolean(row.neutral) : null,
    homeRating: row.home_rating != null ? Number(row.home_rating) : null,
    awayRating: row.away_rating != null ? Number(row.away_rating) : null,
    homeWinProbability: round4(p),
    awayWinProbability: round4(1 - p),
    loggedOn: row.run_date ?? null,
  };
}

const usable = row => Number.isFinite(Number(row?.home_win_prob));

const GAMES_DESCRIPTION = 'Pre-game Elo win probabilities, logged each morning for that day\'s and the next day\'s games. ' +
  'NHL preseason and all-star games are not predicted. Probabilities are model estimates, not odds.';

export function registerGames(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/games', operationId: 'listGames', tags: ['Games'],
    summary: 'Win probabilities for a day\'s games',
    description: GAMES_DESCRIPTION,
    request: {
      params: z.object({ league: League.openapi({ param: { name: 'league', in: 'path' } }) }),
      query: z.object({
        date: IsoDate.optional().openapi({ param: { name: 'date', in: 'query' }, description: 'Game date (league local schedule date). Defaults to today in America/New_York.' }),
      }),
    },
    responses: {
      200: { description: 'Games', content: { 'application/json': { schema: envelope('GamesResponse', GamesForDate) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const date = c.req.valid('query').date ?? todayET();
    const [raw, index] = await Promise.all([
      poller(c.env, `/win-probs?league=${league}&date=${date}`),
      teamIndex(c.env, league),
    ]);
    const games = (raw.games ?? []).filter(usable).map(r => shapeGame(league, r, index));
    const generatedAt = games.reduce((max, g) => (g.loggedOn && (!max || g.loggedOn > max) ? g.loggedOn : max), null);
    // An empty day can fill in the next morning's run: keep it briefly.
    return send(c, { date, games }, meta(league, 'EyeWall Elo win probability log', generatedAt), games.length ? 1800 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/games/{gameId}/win-probability', operationId: 'getGameWinProbability', tags: ['Games'],
    summary: 'Win probability for one game',
    description: GAMES_DESCRIPTION,
    request: {
      params: z.object({
        league: League.openapi({ param: { name: 'league', in: 'path' } }),
        gameId: z.string().regex(/^\d{1,15}$/).openapi({ param: { name: 'gameId', in: 'path' }, example: '2026020331' }),
      }),
    },
    responses: {
      200: { description: 'Game', content: { 'application/json': { schema: envelope('GameWinProbabilityResponse', Game) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league, gameId } = c.req.valid('param');
    const [raw, index] = await Promise.all([
      poller(c.env, `/win-probs?league=${league}&gameId=${gameId}`),
      teamIndex(c.env, league),
    ]);
    const row = (raw.games ?? []).find(usable);
    if (!row) return problem(c, 404, 'Not Found', 'no win probability is logged for this game (it may be too far ahead, a preseason game, or not a game id in this league)');
    const game = shapeGame(league, row, index);
    return send(c, game, meta(league, 'EyeWall Elo win probability log', game.loggedOn), 1800);
  });
}
