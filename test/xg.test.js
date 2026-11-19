// /v1/{league}/xg and /v1/{league}/games/{gameId}/xg against fixture
// poller rows (eyewall-poller's /game-shot-xg).

import { describe, expect, it, vi, afterEach } from 'vitest';
import { z } from '@hono/zod-openapi';
import { get, makeEnv, teamsRoutes } from './helpers.js';
import { Meta } from '../src/schemas.js';
import { GameXg, XgList, shapeGameXgs, yesterdayET } from '../src/routes/gameXg.js';
import { app } from '../src/app.js';

afterEach(() => vi.useRealTimers());

const expectEnvelope = (body, schema) => z.object({ data: schema, meta: Meta }).strict().parse(body);

const nhlRow = (team, isHome, situation, attempts, goals, xg) => ({
  game_id: 2026020345, season: 20262027, game_type: 2, game_date: '2026-11-18', team,
  opponent: isHome ? 'NJD' : 'MTL', is_home: isHome, situation, attempts, goals, xg,
  model: 'logistic-2026-11-18', updated_at: '2026-11-19T09:12:00+00:00',
});
const NHL_ROWS = [
  nhlRow('MTL', true, '5v5', 35, 2, '3.101'),
  nhlRow('MTL', true, 'all', 48, 3, '4.632'),
  nhlRow('NJD', false, '5v5', 37, 1, '2.950'),
  nhlRow('NJD', false, 'all', 48, 2, '3.888'),
];
const htRow = (teamId, isHome, goals, xg) => ({
  game_id: 1029331, season_id: 94, season_type: 'regular', game_date: '2026-11-15', team_id: teamId,
  opponent_id: isHome ? 384 : 328, is_home: isHome, attempts: 30, goals, xg,
  model: 'distance-bands-season-fit', updated_at: '2026-11-19T08:00:00+00:00',
});

describe('shapeGameXgs', () => {
  it('NHL: one game, home/away with all and 5v5', () => {
    const index = { find: code => ({ MTL: { id: 8, code: 'MTL', name: 'Montréal Canadiens' }, NJD: { id: 1, code: 'NJD', name: 'New Jersey Devils' } })[code] ?? null };
    const [g] = shapeGameXgs('nhl', NHL_ROWS, index);
    expect(g).toEqual({
      gameId: 2026020345, date: '2026-11-18', season: 20262027, gameType: 'regular', seasonType: null,
      model: 'logistic-2026-11-18',
      home: { team: { id: 8, code: 'MTL', name: 'Montréal Canadiens' }, all: { attempts: 48, goals: 3, xg: 4.632 }, fiveOnFive: { attempts: 35, goals: 2, xg: 3.101 } },
      away: { team: { id: 1, code: 'NJD', name: 'New Jersey Devils' }, all: { attempts: 48, goals: 2, xg: 3.888 }, fiveOnFive: { attempts: 37, goals: 1, xg: 2.95 } },
    });
    GameXg.parse(g);
  });

  it('a game missing a side is left out', () => {
    expect(shapeGameXgs('nhl', NHL_ROWS.filter(r => r.team === 'MTL'), { find: () => null })).toEqual([]);
  });

  it('preseason is labelled', () => {
    const [g] = shapeGameXgs('nhl', NHL_ROWS.map(r => ({ ...r, game_type: 1 })), { find: () => null });
    expect(g.gameType).toBe('preseason');
  });
});

describe('GET /v1/{league}/xg', () => {
  it('NHL by date: CC BY, never MoneyPuck', async () => {
    const env = makeEnv({ ...teamsRoutes('nhl'), '/game-shot-xg?league=nhl&date=2026-11-18': { league: 'nhl', season: 20262027, rows: NHL_ROWS } });
    const { status, body, res } = await get('/v1/nhl/xg?date=2026-11-18', env);
    expect(status).toBe(200);
    const parsed = expectEnvelope(body, XgList);
    expect(parsed.data.games).toHaveLength(1);
    expect(parsed.data.date).toBe('2026-11-18');
    expect(parsed.meta).toMatchObject({ license: 'CC-BY-4.0', attribution: 'EyeWall Analytics (eyewallanalytics.com)', generatedAt: '2026-11-19T09:12:00+00:00' });
    expect(JSON.stringify(parsed.meta)).not.toMatch(/MoneyPuck/i);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('HockeyTech by season: team ids resolved, no 5v5', async () => {
    const env = makeEnv({ ...teamsRoutes('ahl'), '/game-shot-xg?league=ahl&season=latest': { league: 'ahl', season: 94, rows: [htRow(328, true, 4, '3.912'), htRow(384, false, 2, '2.488')] } });
    const { body } = await get('/v1/ahl/xg?season=latest', env);
    const { data } = expectEnvelope(body, XgList);
    expect(data.season).toBe(94);
    expect(data.date).toBeNull();
    const [g] = data.games;
    expect(g.seasonType).toBe('regular');
    expect(g.gameType).toBeNull();
    expect(g.home.team.id).toBe(328);
    expect(g.home.fiveOnFive).toBeNull();
    expect(g.home.all).toEqual({ attempts: 30, goals: 4, xg: 3.912 });
  });

  it('defaults to yesterday (America/New_York); an empty day caches briefly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T03:00:00Z')); // 22:00 on the 18th in New York
    expect(yesterdayET()).toBe('2026-11-17');
    const env = makeEnv({ ...teamsRoutes('echl'), '/game-shot-xg?league=echl&date=2026-11-17': { league: 'echl', season: null, rows: [] } });
    const { body, res } = await get('/v1/echl/xg', env);
    expect(body.data).toEqual({ date: '2026-11-17', season: null, games: [] });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('400 for date and season together, or a bad season', async () => {
    expect((await get('/v1/nhl/xg?date=2026-11-18&season=latest', makeEnv())).status).toBe(400);
    expect((await get('/v1/nhl/xg?season=2026-27', makeEnv())).status).toBe(400);
  });
});

describe('GET /v1/{league}/games/{gameId}/xg', () => {
  it('one NHL game, cached 6 hours', async () => {
    const env = makeEnv({ ...teamsRoutes('nhl'), '/game-shot-xg?league=nhl&gameId=2026020345': { league: 'nhl', season: 20262027, rows: NHL_ROWS } });
    const { status, body, res } = await get('/v1/nhl/games/2026020345/xg', env);
    expect(status).toBe(200);
    expectEnvelope(body, GameXg);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=21600');
  });

  it('404 before the game is scored', async () => {
    const env = makeEnv({ ...teamsRoutes('pwhl'), '/game-shot-xg?league=pwhl&gameId=999': { league: 'pwhl', season: null, rows: [] } });
    const { status, body } = await get('/v1/pwhl/games/999/xg', env);
    expect(status).toBe(404);
    expect(body.detail).toMatch(/nightly/);
  });
});

describe('OpenAPI', () => {
  it('documents both routes under Games', () => {
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } });
    expect(doc.paths['/v1/{league}/xg'].get.tags).toEqual(['Games']);
    expect(doc.paths['/v1/{league}/games/{gameId}/xg'].get.operationId).toBe('getGameXg');
  });
});
