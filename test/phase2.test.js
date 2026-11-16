// Phase 2 routes: power rankings, percentiles, projected lines, goalie
// starts. Fixtures are real poller responses from 2026-11-16.

import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { fixture, get, makeEnv, teamsRoutes } from './helpers.js';
import { Meta } from '../src/schemas.js';
import { PowerRankings, TeamPowerRanking } from '../src/routes/powerRankings.js';
import { GoaliePercentiles, SkaterPercentiles } from '../src/routes/percentiles.js';
import { GoalieStarts, ProjectedLines } from '../src/routes/lineups.js';

const expectEnvelope = (body, schema) => z.object({ data: schema, meta: Meta }).strict().parse(body);

describe('GET /v1/{league}/power-rankings', () => {
  const routes = {
    '/ahl/power-rankings?limit=100': fixture('pr-ahl'),
    '/ahl/power-rankings?teamId=328&limit=1': fixture('pr-ahl-328-top'),
    ...teamsRoutes('ahl'),
  };

  it('AHL: every team best first, component ranks, run date from history', async () => {
    const { status, body } = await get('/v1/ahl/power-rankings', makeEnv(routes));
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, PowerRankings);
    expect(data.teams).toHaveLength(32);
    expect(data.teams[0]).toMatchObject({
      rank: 1, previousRank: 1, team: { id: 328, code: 'GR', name: 'Grand Rapids Griffins' },
      componentRanks: { pts_pct: 1, l10_pts_pct: 1, gd_pg: 2, special_teams: 2 },
    });
    expect(data.teams.map(t => t.rank)).toEqual([...data.teams.map(t => t.rank)].sort((a, b) => a - b));
    expect(data.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.generatedAt).toBe(data.runDate);
    // The league's raw standings numbers aren't repeated.
    expect(JSON.stringify(data)).not.toContain('record');
  });

  it('before the first run: empty, short cache, no second call', async () => {
    const env = makeEnv({ '/pwhl/power-rankings?limit=100': fixture('pr-pwhl-empty'), ...teamsRoutes('pwhl') });
    const { body, res } = await get('/v1/pwhl/power-rankings', env);
    expect(body.data).toEqual({ season: null, runDate: null, teams: [] });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(env.POLLER.fetch).toHaveBeenCalledTimes(2); // rankings + teams
  });

  it('NHL is not offered (MoneyPuck inputs): 400', async () => {
    expect((await get('/v1/nhl/power-rankings', makeEnv())).status).toBe(400);
  });
});

describe('GET /v1/{league}/teams/{teamId}/power-ranking', () => {
  it('English paragraph, ranking and history oldest first', async () => {
    const env = makeEnv({ '/ahl/power-rankings?teamId=328&limit=100&locale=en': fixture('pr-ahl-328'), ...teamsRoutes('ahl') });
    const { status, body } = await get('/v1/ahl/teams/328/power-ranking', env);
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, TeamPowerRanking);
    expect(data.ranking.team.code).toBe('GR');
    expect(data.narrative).toMatch(/Grand Rapids/);
    expect(data.history.length).toBeGreaterThan(1);
    expect(data.history[0].runDate < data.history.at(-1).runDate).toBe(true);
    expect(data.runDate).toBe(fixture('pr-ahl-328').narrative.run_date);
  });

  it('French with locale=fr', async () => {
    const env = makeEnv({ '/ahl/power-rankings?teamId=328&limit=100&locale=fr': fixture('pr-ahl-328-fr'), ...teamsRoutes('ahl') });
    const { data } = expectEnvelope((await get('/v1/ahl/teams/328/power-ranking?locale=fr', env)).body, TeamPowerRanking);
    expect(data.narrative).toMatch(/Ligue américaine/);
  });

  it('404 for a team that is not current; 400 for a bad locale', async () => {
    expect((await get('/v1/ahl/teams/317/power-ranking', makeEnv(teamsRoutes('ahl')))).status).toBe(404);
    expect((await get('/v1/ahl/teams/328/power-ranking?locale=de', makeEnv())).status).toBe(400);
  });
});

describe('percentiles', () => {
  it('skater: percentiles and EyeWall xG, no league counting stats', async () => {
    const env = makeEnv({ '/ahl/player/percentiles?id=10978': fixture('pct-skater'), ...teamsRoutes('ahl') });
    const { status, body } = await get('/v1/ahl/players/10978/percentiles', env);
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, SkaterPercentiles);
    expect(data).toMatchObject({
      playerId: 10978, team: { id: 415, code: 'LAV' }, season: 94, seasonType: 'regular', rateBasis: 'perGP',
      expectedGoals: 3.061, goalsAboveExpected: 1.939,
    });
    expect(data.percentiles.goals).toEqual({ percentile: 98, label: 'Goals', description: 'Percentile rank vs league, goals, per game played' });
    expect(data).not.toHaveProperty('toi_per_game');
  });

  it('goalie: GSAx, save percentages by zone, null where there is no data', async () => {
    const env = makeEnv({ '/ahl/goalie/percentiles?id=6535&season=94': fixture('pct-goalie'), ...teamsRoutes('ahl') });
    const { data } = expectEnvelope((await get('/v1/ahl/goalies/6535/percentiles?season=94', env)).body, GoaliePercentiles);
    expect(data.goalsSavedAboveExpected).toBe(-9.447);
    expect(data.savePercentage).toEqual({ evenStrength: null, highDanger: 74.3, mediumDanger: 87.5, penaltyKill: null });
    expect(data.percentiles.evSv.percentile).toBeNull();
    expect(data.percentiles.hdSv.percentile).toBe(11);
  });

  it('an unknown id (the poller\'s all-null row) is a 404', async () => {
    const empty = { player_id: 999, team_id: null, season_id: null, season_type: 'regular', percentiles: { goals: { pct: null, label: 'Goals', note: '' } } };
    const env = makeEnv({ '/echl/player/percentiles?id=999': empty, ...teamsRoutes('echl') });
    expect((await get('/v1/echl/players/999/percentiles', env)).status).toBe(404);
  });
});

describe('GET /v1/nhl/teams/{team}/projected-lines', () => {
  it('forward lines and pairs with filled-in flags', async () => {
    const env = makeEnv({ '/projected-lines?team=CAR': fixture('projected-lines-car'), ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/teams/car/projected-lines', env);
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, ProjectedLines);
    expect(data.team.code).toBe('CAR');
    expect(data.basis).toBe('last_game');
    expect(data.forwardLines).toHaveLength(4);
    expect(data.defensePairs).toHaveLength(3);
    expect(data.forwardLines[0].players[0]).toEqual({ id: 8477940, name: 'Nikolaj Ehlers', position: 'L', filledIn: false });
    expect(meta.generatedAt).toBe(data.generatedAt);
  });

  it('404 for a code that is not a current team', async () => {
    expect((await get('/v1/nhl/teams/ARI/projected-lines', makeEnv(teamsRoutes('nhl')))).status).toBe(404);
  });
});

describe('GET /v1/nhl/games/{gameId}/goalie-starts', () => {
  it('both teams, most likely starter first, no injury status', async () => {
    const env = makeEnv({ '/probable-starters?game=2026020333': fixture('goalie-starts'), ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/games/2026020333/goalie-starts', env);
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, GoalieStarts);
    expect(data.teams.map(t => t.team.code).sort()).toEqual(['BOS', 'LAK']);
    const lak = data.teams.find(t => t.team.code === 'LAK');
    expect(lak.goalies[0]).toEqual({
      goalie: { id: 8475311, name: 'Darcy Kuemper' }, startProbability: 0.6333,
      factors: { daysRest: 5, backToBack: false, startedLastGame: false, shareOfLast10Starts: 0.5, noRecentStarts: false },
    });
    expect(lak.goalies[0].startProbability).toBeGreaterThanOrEqual(lak.goalies[1].startProbability);
    expect(JSON.stringify(data)).not.toContain('injury');
  });

  it('404 when nothing is logged', async () => {
    const env = makeEnv({ '/probable-starters?game=2026020001': { gameId: 2026020001, gameDate: null, runDate: null, teams: {} }, ...teamsRoutes('nhl') });
    expect((await get('/v1/nhl/games/2026020001/goalie-starts', env)).status).toBe(404);
  });
});
