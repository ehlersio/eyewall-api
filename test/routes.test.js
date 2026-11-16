// Every /v1 route against fixture poller responses: status, shape (each
// response parsed with the schema the OpenAPI document publishes), the
// envelope, caching headers and error handling.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from '@hono/zod-openapi';
import { fixture, get, makeEnv, teamsRoutes } from './helpers.js';
import { Meta } from '../src/schemas.js';
import { LeagueInfo, Seasons } from '../src/routes/reference.js';
import { Elo, ELO_FORMULA } from '../src/routes/elo.js';
import { Game, GamesForDate, todayET } from '../src/routes/games.js';
import { PlayoffOdds } from '../src/routes/playoffOdds.js';
import { Scorecard } from '../src/routes/scorecard.js';

afterEach(() => vi.useRealTimers());

// Parses `body` as `{ data: <schema>, meta: Meta }` and returns it.
const expectEnvelope = (body, schema) => z.object({ data: schema, meta: Meta }).strict().parse(body);

describe('GET /v1/leagues', () => {
  it('lists the four leagues with CC BY metadata', async () => {
    const { status, body, res } = await get('/v1/leagues', makeEnv());
    expect(status).toBe(200);
    const parsed = expectEnvelope(body, z.array(LeagueInfo));
    expect(parsed.data.map(l => l.id)).toEqual(['nhl', 'pwhl', 'ahl', 'echl']);
    expect(parsed.meta).toMatchObject({ license: 'CC-BY-4.0', attribution: 'EyeWall Analytics (eyewallanalytics.com)' });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('GET /v1/{league}/teams', () => {
  it('NHL: 32 teams', async () => {
    const { status, body } = await get('/v1/nhl/teams', makeEnv(teamsRoutes('nhl')));
    expect(status).toBe(200);
    expect(body.data).toHaveLength(32);
    expect(body.data).toContainEqual({ id: 12, code: 'CAR', name: 'Carolina Hurricanes' });
  });

  it('400 for an unknown league, as problem+json', async () => {
    const { status, body, res } = await get('/v1/khl/teams', makeEnv());
    expect(status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('application/problem+json');
    expect(body).toMatchObject({ status: 400, title: 'Bad Request' });
  });
});

describe('GET /v1/{league}/seasons', () => {
  const routes = {
    '/config/seasons': fixture('seasons'),
    '/config/seasons/comparison': fixture('seasons-comparison'),
    '/config/seasons/ahl-seasons': fixture('ahl-seasons'),
  };

  it('NHL: current season, typeless, labelled seasons newest first', async () => {
    const { body } = await get('/v1/nhl/seasons', makeEnv(routes));
    const { data } = expectEnvelope(body, Seasons);
    expect(data.current).toEqual({ id: 20262027, type: null });
    expect(data.next).toBeNull();
    expect(data.seasons[0]).toEqual({ id: 20262027, label: '2026-27', type: null, startYear: 2026 });
  });

  it('PWHL: current regular season plus the next one', async () => {
    const { body } = await get('/v1/pwhl/seasons', makeEnv(routes));
    const { data } = expectEnvelope(body, Seasons);
    expect(data.current).toEqual({ id: 8, type: 'regular' });
    expect(data.next).toEqual({ id: 11, type: 'regular', startDate: '2026-12-04' });
  });

  it('AHL: labels come from the season list', async () => {
    const { body } = await get('/v1/ahl/seasons', makeEnv(routes));
    const { data } = expectEnvelope(body, Seasons);
    expect(data.seasons.find(s => s.id === 94)).toEqual({ id: 94, label: '2026-27 Regular Season', type: 'regular', startYear: 2026 });
  });
});

describe('GET /v1/{league}/elo', () => {
  it('NHL: current teams only (no ARI), highest first, with the formula', async () => {
    const env = makeEnv({ '/elo/ratings?league=nhl': fixture('elo-nhl'), ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/elo', env);
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, Elo);
    expect(data.homeAdvantage).toBe(35);
    expect(data.formula).toBe(ELO_FORMULA);
    expect(data.ratings.some(r => r.team.code === 'ARI')).toBe(false);
    expect(data.ratings).toHaveLength(32);
    expect(data.ratings[0].rating).toBeGreaterThanOrEqual(data.ratings[1].rating);
    expect(data.ratings.find(r => r.team.code === 'CAR')).toEqual({
      team: { id: 12, code: 'CAR', name: 'Carolina Hurricanes' }, rating: 1577.5,
    });
  });

  it('PWHL: keyed by team id; unrated expansion teams are left out', async () => {
    const env = makeEnv({ '/elo/ratings?league=pwhl': fixture('elo-pwhl'), ...teamsRoutes('pwhl') });
    const { data } = expectEnvelope((await get('/v1/pwhl/elo', env)).body, Elo);
    expect(data.ratings).toHaveLength(8);
    expect(data.ratings.find(r => r.team.id === 3).team.code).toBe('MTL');
  });

  it('a poller failure is a 503 problem, not a 500', async () => {
    const env = makeEnv({ '/elo/ratings?league=nhl': { ratings: {}, homeAdvantage: 35, unavailable: true }, ...teamsRoutes('nhl') });
    const { status, body, res } = await get('/v1/nhl/elo', env);
    expect(status).toBe(503);
    expect(body.title).toBe('Service Unavailable');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('a poller 5xx is a 502', async () => {
    const env = makeEnv({ '/elo/ratings?league=nhl': { status: 500, body: { error: 'x' } }, ...teamsRoutes('nhl') });
    expect((await get('/v1/nhl/elo', env)).status).toBe(502);
  });
});

describe('GET /v1/{league}/games', () => {
  const nhlRows = [
    { game_id: 2026020331, game_date: '2026-11-16', game_type: 2, season: 20262027, home_team: 'NYR', away_team: 'MTL',
      neutral: false, home_rating: 1497.1, away_rating: 1532, home_win_prob: 0.4517, run_date: '2026-11-16' },
    { game_id: 2026020332, game_date: '2026-11-16', game_type: 2, season: 20262027, home_team: 'UTA', away_team: 'VAN',
      neutral: false, home_rating: 1491.7, away_rating: 1399.5, home_win_prob: 0.6789, run_date: '2026-11-16' },
  ];

  it('NHL by date: teams joined, both probabilities, gameType named', async () => {
    const env = makeEnv({ '/win-probs?league=nhl&date=2026-11-16': { league: 'nhl', games: nhlRows }, ...teamsRoutes('nhl') });
    const { status, body, res } = await get('/v1/nhl/games?date=2026-11-16', env);
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, GamesForDate);
    expect(data.date).toBe('2026-11-16');
    expect(data.games[0]).toEqual({
      gameId: 2026020331, date: '2026-11-16', season: 20262027, gameType: 'regular',
      homeTeam: { id: 3, code: 'NYR', name: 'New York Rangers' },
      awayTeam: { id: 8, code: 'MTL', name: 'Montreal Canadiens' },
      neutralSite: false, homeRating: 1497.1, awayRating: 1532,
      homeWinProbability: 0.4517, awayWinProbability: 0.5483, loggedOn: '2026-11-16',
    });
    expect(meta.generatedAt).toBe('2026-11-16');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=1800');
  });

  it('defaults to today in America/New_York', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T03:30:00Z')); // 22:30 ET on the 16th
    expect(todayET()).toBe('2026-11-16');
    const env = makeEnv({ '/win-probs?league=ahl&date=2026-11-16': { league: 'ahl', games: [] }, ...teamsRoutes('ahl') });
    const { body, res } = await get('/v1/ahl/games', env);
    expect(body.data).toEqual({ date: '2026-11-16', games: [] });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('HockeyTech: ids joined to codes; NHL-only fields null', async () => {
    const row = { game_id: 1029331, season_id: 94, game_date: '2026-11-17', home_team_id: 373, away_team_id: 457,
      home_rating: 1495.2, away_rating: 1466.1, home_win_prob: 0.59, run_date: '2026-11-16' };
    const env = makeEnv({ '/win-probs?league=ahl&date=2026-11-17': { league: 'ahl', games: [row] }, ...teamsRoutes('ahl') });
    const { data } = expectEnvelope((await get('/v1/ahl/games?date=2026-11-17', env)).body, GamesForDate);
    expect(data.games[0]).toMatchObject({
      gameId: 1029331, season: 94, gameType: null, neutralSite: null,
      homeTeam: { id: 373, code: 'CLE', name: 'Cleveland Monsters' },
      awayTeam: { id: 457, code: 'HAM', name: 'Hamilton Hammers' },
      homeWinProbability: 0.59, awayWinProbability: 0.41,
    });
  });

  it('a team that is no longer current keeps its key, with nulls', async () => {
    const row = { game_id: 1, season_id: 90, game_date: '2026-01-02', home_team_id: 317, away_team_id: 373,
      home_rating: 1500, away_rating: 1500, home_win_prob: 0.55, run_date: '2026-01-02' };
    const env = makeEnv({ '/win-probs?league=ahl&date=2026-01-02': { league: 'ahl', games: [row] }, ...teamsRoutes('ahl') });
    const { data } = expectEnvelope((await get('/v1/ahl/games?date=2026-01-02', env)).body, GamesForDate);
    expect(data.games[0].homeTeam).toEqual({ id: 317, code: null, name: null });
  });

  it('400 for a malformed date, without calling the poller', async () => {
    const env = makeEnv();
    const { status } = await get('/v1/nhl/games?date=11-16-2026', env);
    expect(status).toBe(400);
    expect(env.POLLER.fetch).not.toHaveBeenCalled();
  });
});

describe('GET /v1/{league}/games/{gameId}/win-probability', () => {
  it('one game', async () => {
    const row = { game_id: 353, season_id: 10, game_date: '2026-11-22', home_team_id: 12, away_team_id: 2,
      home_rating: 1500, away_rating: 1516.2, home_win_prob: 0.4789, run_date: '2026-11-21' };
    const env = makeEnv({ '/win-probs?league=pwhl&gameId=353': { league: 'pwhl', games: [row] }, ...teamsRoutes('pwhl') });
    const { status, body } = await get('/v1/pwhl/games/353/win-probability', env);
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, Game);
    expect(data.homeTeam).toEqual({ id: 12, code: 'LV', name: 'Vegas Vanguards' });
    expect(meta.generatedAt).toBe('2026-11-21');
  });

  it('404 when nothing is logged', async () => {
    const env = makeEnv({ '/win-probs?league=nhl&gameId=2026010001': { league: 'nhl', games: [] }, ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/games/2026010001/win-probability', env);
    expect(status).toBe(404);
    expect(body.detail).toMatch(/no win probability/);
  });

  it('400 for a non-numeric id', async () => {
    expect((await get('/v1/nhl/games/abc/win-probability', makeEnv())).status).toBe(400);
  });
});

describe('GET /v1/{league}/playoff-odds', () => {
  it('NHL: every team, highest first, mean projection', async () => {
    const raw = {
      league: 'nhl', season: 20262027, runDate: '2026-11-16', stale: false,
      teams: [
        { team: 'NJD', season: 20262027, run_date: '2026-11-16', playoff_pct: 0.7939, division_pct: 0.1405, proj_points: 102.3,
          points_p10: 90, points_p90: 114, current_points: 28, games_played: 20, games_remaining: 64, elo_rating: 1516.4, sims: 10000 },
        { team: 'CAR', season: 20262027, run_date: '2026-11-16', playoff_pct: 0.9839, division_pct: 0.7411, proj_points: 115.3,
          points_p10: 103, points_p90: 127, current_points: 34, games_played: 21, games_remaining: 63, elo_rating: 1577.5, sims: 10000 },
      ],
    };
    const env = makeEnv({ '/playoff-odds/league?league=nhl': raw, ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/playoff-odds', env);
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, PlayoffOdds);
    expect(data).toMatchObject({ season: 20262027, runDate: '2026-11-16', stale: false, simulations: 10000, format: null, note: null });
    expect(data.teams.map(t => t.team.code)).toEqual(['CAR', 'NJD']);
    expect(data.teams[0]).toEqual({
      team: { id: 12, code: 'CAR', name: 'Carolina Hurricanes' },
      playoffProbability: 0.9839, divisionProbability: 0.7411,
      projectedPoints: { mean: 115.3, p10: 103, p50: null, p90: 127 },
      currentPoints: 34, gamesPlayed: 21, gamesRemaining: 63, eloRating: 1577.5,
    });
    expect(meta.generatedAt).toBe('2026-11-16');
  });

  it('AHL with an unverified format: null playoff probability and a note', async () => {
    const raw = {
      league: 'ahl', season: 94, runDate: '2026-11-16', stale: false,
      teams: [
        { season_id: 94, team_id: 373, run_date: '2026-11-16', make_playoffs_pct: null, win_division_pct: null,
          proj_points_p10: 64, proj_points_p50: 76, proj_points_p90: 88, current_points: 14, games_remaining: 57,
          sims: 10000, format: 'unverified', games_played: 15 },
        { season_id: 94, team_id: 328, run_date: '2026-11-16', make_playoffs_pct: null, win_division_pct: null,
          proj_points_p10: 80, proj_points_p50: 92, proj_points_p90: 103, current_points: 28, games_remaining: 55,
          sims: 10000, format: 'unverified', games_played: 17 },
      ],
    };
    const env = makeEnv({ '/playoff-odds/league?league=ahl&season=94': raw, ...teamsRoutes('ahl') });
    const { data } = expectEnvelope((await get('/v1/ahl/playoff-odds?season=94', env)).body, PlayoffOdds);
    expect(data.format).toBe('unverified');
    expect(data.note).toMatch(/not published/);
    expect(data.teams.map(t => t.team.code)).toEqual(['GR', 'CLE']); // by projected points
    expect(data.teams[0].projectedPoints).toEqual({ mean: null, p10: 80, p50: 92, p90: 103 });
  });

  it('no run yet: empty teams, short cache', async () => {
    const env = makeEnv({ '/playoff-odds/league?league=echl': { league: 'echl', season: null, runDate: null, stale: false, teams: [] }, ...teamsRoutes('echl') });
    const { body, res } = await get('/v1/echl/playoff-odds', env);
    expect(body.data.teams).toEqual([]);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });
});

describe('GET /v1/nhl/scorecard', () => {
  it('camelCases the grades and keeps every model', async () => {
    const { status, body } = await get('/v1/nhl/scorecard', makeEnv({ '/scorecard': fixture('scorecard') }));
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, Scorecard);
    expect(Object.keys(data.models).sort()).toEqual(['gameWinner', 'playoffOdds', 'startingGoalie']);
    expect(data.models.gameWinner.live).toMatchObject({ model: 'game_winner', kind: 'live', logLoss: 0.6659 });
    expect(data.models.gameWinner.live.recent[0]).toHaveProperty('homeWinProb');
    expect(data.models.playoffOdds.live.status).toBe('pending');
  });
});

describe('cross-cutting', () => {
  it('rate limit: 429 problem with Retry-After, poller not called', async () => {
    const env = makeEnv({}, { limit: false });
    const { status, res } = await get('/v1/leagues', env, { 'CF-Connecting-IP': '203.0.113.9' });
    expect(status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(env.API_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
  });

  it('unknown path: 404 problem', async () => {
    const { status, body } = await get('/v2/anything', makeEnv());
    expect(status).toBe(404);
    expect(body.title).toBe('Not Found');
  });

  it('/llms.txt lists every route from the spec', async () => {
    const { status, body, res } = await get('/llms.txt', makeEnv());
    expect(status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(body).toContain('# EyeWall API');
    expect(body).toContain('- GET /v1/{league}/playoff-odds: Playoff probabilities for every team');
    expect(body).toContain('- GET /v1/nhl/war: WAR for every NHL player');
  });

  // ChatGPT GPT Actions reject an operation description over 300
  // characters, and need an operationId on every operation.
  it('every operation fits GPT Action limits', async () => {
    const { body } = await get('/openapi.json', makeEnv());
    const ops = Object.values(body.paths).flatMap(p => Object.values(p));
    expect(ops.length).toBeGreaterThan(20);
    for (const op of ops) {
      expect(op.operationId).toMatch(/^[A-Za-z]+$/);
      expect((op.description ?? '').length, op.operationId).toBeLessThanOrEqual(300);
      expect((op.summary ?? '').length, op.operationId).toBeLessThanOrEqual(300);
    }
    expect(body.servers).toEqual([{ url: 'https://api.eyewallanalytics.com' }]);
  });

  it('serves the OpenAPI document and the docs page', async () => {
    const spec = await get('/openapi.json', makeEnv());
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths)).toContain('/v1/{league}/playoff-odds');
    const docs = await get('/docs', makeEnv());
    expect(docs.status).toBe(200);
    expect(docs.res.headers.get('Content-Type')).toContain('text/html');
  });
});
