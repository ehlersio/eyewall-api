// /v1/{league}/xg  and  /v1/{league}/games/{gameId}/xg -- each team's
// expected goals per game from EyeWall's own shot models (eyewall-pipeline's
// game_shot_xg.py, through the poller's /game-shot-xg). Never MoneyPuck's
// game xG, so this is CC BY like the rest of tier A.

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, IsoDate, League, meta, problemResponses } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex } from '../teams.js';
import { GameTeam, gameTeam } from './games.js';

const XgLine = z.object({
  attempts: z.number().int().openapi({ description: 'Attempts that carry xG (see the model).', example: 48 }),
  goals: z.number().int().openapi({ example: 3 }),
  xg: z.number().openapi({ description: 'Expected goals: the sum of each attempt\'s chance of scoring.', example: 4.632 }),
}).openapi('XgLine');

const XgSide = z.object({
  team: GameTeam,
  all: XgLine,
  fiveOnFive: XgLine.nullable().openapi({ description: 'NHL only: 5-on-5 with both goalies in. Null for PWHL/AHL/ECHL, whose feeds don\'t give strength for every attempt.' }),
}).openapi('XgSide');

export const GameXg = z.object({
  gameId: z.number().int().openapi({ example: 2026020345 }),
  date: IsoDate.nullable(),
  season: z.number().int().openapi({ description: 'NHL season (20262027) or HockeyTech season id.', example: 20262027 }),
  gameType: z.enum(['preseason', 'regular', 'playoffs']).nullable().openapi({ description: 'NHL only; null for PWHL/AHL/ECHL (see seasonType).' }),
  seasonType: z.string().nullable().openapi({ description: 'PWHL/AHL/ECHL only (regular, playoffs, ...); null for the NHL.' }),
  model: z.string().openapi({ description: 'logistic-<fit date> (NHL): a logistic model of unblocked attempts by distance, angle, shot type, strength and rebounds. distance-bands-season-fit (PWHL/AHL/ECHL): three distance bands at the season\'s own goal rates, over goals and shots on goal. Shootouts and penalty shots never count.', example: 'logistic-2026-11-18' }),
  home: XgSide,
  away: XgSide,
}).openapi('GameXg');

export const XgList = z.object({
  date: IsoDate.nullable().openapi({ description: 'The date asked for; null for a season.' }),
  season: z.number().int().nullable(),
  games: z.array(GameXg),
}).openapi('GameXgList');

export const XG_DESCRIPTION = 'Each team\'s expected goals per game from EyeWall\'s own shot models (see model). Leagues aren\'t comparable: each feed records different attempts.';

const NHL_GAME_TYPES = { 1: 'preseason', 2: 'regular', 3: 'playoffs' };
const line = r => ({ attempts: Number(r.attempts), goals: Number(r.goals), xg: Number(r.xg) });
const zero = { attempts: 0, goals: 0, xg: 0 };

// Rows from /game-shot-xg -> one GameXg per game, in game id order.
export function shapeGameXgs(league, rows, index) {
  const nhl = league === 'nhl';
  const byGame = new Map();
  for (const r of rows) {
    const id = Number(r.game_id);
    if (!byGame.has(id)) byGame.set(id, []);
    byGame.get(id).push(r);
  }
  const out = [];
  for (const [gameId, gameRows] of [...byGame].sort((a, b) => a[0] - b[0])) {
    const first = gameRows[0];
    const side = isHome => {
      const mine = gameRows.filter(r => Boolean(r.is_home) === isHome);
      if (!mine.length) return null;
      const all = nhl ? mine.find(r => r.situation === 'all') : mine[0];
      if (!all) return null;
      const five = nhl ? mine.find(r => r.situation === '5v5') : null;
      return {
        team: nhl ? gameTeam(index, all.team, all.team) : gameTeam(index, all.team_id),
        all: line(all),
        fiveOnFive: nhl ? (five ? line(five) : zero) : null,
      };
    };
    const home = side(true);
    const away = side(false);
    if (!home || !away) continue;
    out.push({
      gameId,
      date: first.game_date ?? null,
      season: Number(nhl ? first.season : first.season_id),
      gameType: nhl ? (NHL_GAME_TYPES[first.game_type] ?? null) : null,
      seasonType: nhl ? null : (first.season_type ?? null),
      model: first.model,
      home,
      away,
    });
  }
  return out;
}

const latestUpdate = rows => rows.reduce((max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max), null);
const source = league => (league === 'nhl' ? 'EyeWall NHL shot model' : 'EyeWall shot-location model');

export function yesterdayET(now = new Date()) {
  const d = new Date(now.getTime() - 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function registerGameXg(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/xg', operationId: 'listGameXg', tags: ['Games'],
    summary: 'Expected goals for a day\'s or a season\'s games',
    description: `${XG_DESCRIPTION} Pass date or season; with neither, yesterday's games (America/New_York).`,
    request: {
      params: z.object({ league: League.openapi({ param: { name: 'league', in: 'path' } }) }),
      query: z.object({
        date: IsoDate.optional().openapi({ param: { name: 'date', in: 'query' } }),
        season: z.string().regex(/^(\d{1,8}|latest)$/).optional()
          .openapi({ param: { name: 'season', in: 'query' }, description: 'NHL season (20252026), HockeyTech season id, or latest. A whole season is large; the bulk files have it too.', example: 'latest' }),
      }),
    },
    responses: {
      200: { description: 'Games', content: { 'application/json': { schema: envelope('GameXgListResponse', XgList) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league } = c.req.valid('param');
    const { date: asked, season } = c.req.valid('query');
    if (asked && season) return problem(c, 400, 'Bad Request', 'pass date or season, not both');
    const date = season ? null : (asked ?? yesterdayET());
    const query = season ? `season=${season}` : `date=${date}`;
    const [raw, index] = await Promise.all([
      poller(c.env, `/game-shot-xg?league=${league}&${query}`),
      teamIndex(c.env, league),
    ]);
    const rows = raw.rows ?? [];
    const games = shapeGameXgs(league, rows, index);
    const seasonOut = raw.season != null ? Number(raw.season) : (games[0]?.season ?? null);
    return send(c, { date, season: seasonOut, games }, meta(league, source(league), latestUpdate(rows)), games.length ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/{league}/games/{gameId}/xg', operationId: 'getGameXg', tags: ['Games'],
    summary: 'Expected goals for one game',
    description: `${XG_DESCRIPTION} A game appears after the nightly run that follows it.`,
    request: {
      params: z.object({
        league: League.openapi({ param: { name: 'league', in: 'path' } }),
        gameId: z.string().regex(/^\d{1,15}$/).openapi({ param: { name: 'gameId', in: 'path' }, example: '2026020345' }),
      }),
    },
    responses: {
      200: { description: 'Game', content: { 'application/json': { schema: envelope('GameXgResponse', GameXg) } } },
      ...problemResponses,
    },
  }), async c => {
    const { league, gameId } = c.req.valid('param');
    const [raw, index] = await Promise.all([
      poller(c.env, `/game-shot-xg?league=${league}&gameId=${gameId}`),
      teamIndex(c.env, league),
    ]);
    const rows = raw.rows ?? [];
    const [game] = shapeGameXgs(league, rows, index);
    if (!game) return problem(c, 404, 'Not Found', 'no xG for this game yet: games are scored by the nightly run after they finish');
    return send(c, game, meta(league, source(league), latestUpdate(rows)), 21600);
  });
}
