// Phase 3 NHL routes: RAPM (CC BY), and the MoneyPuck-input models and
// EyeWall AI text (CC BY-NC with MoneyPuck credit). Fixtures are real
// poller responses from 2026-11-16, trimmed.

import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { fixture, get, makeEnv, teamsRoutes } from './helpers.js';
import { Meta } from '../src/schemas.js';
import { NhlPowerRankings, NhlTeamPowerRanking, RapmTable, TeamNeeds, TradeFit, WarTable } from '../src/routes/nhlModels.js';
import { Preview, Recap, Scouting } from '../src/routes/nhlText.js';

const expectEnvelope = (body, schema) => z.object({ data: schema, meta: Meta }).strict().parse(body);
const NC = { license: 'CC-BY-NC-4.0', attribution: 'EyeWall Analytics (eyewallanalytics.com), using data from MoneyPuck.com' };

const analyticsRoutes = {
  '/config/seasons': fixture('seasons'),
  '/player-analytics?season=20262027': fixture('player-analytics'),
  '/players-list': fixture('players-list'),
  ...teamsRoutes('nhl'),
};

describe('GET /v1/nhl/war and /v1/nhl/rapm', () => {
  it('WAR: highest first, names joined, CC BY-NC with MoneyPuck credit', async () => {
    const { status, body } = await get('/v1/nhl/war', makeEnv(analyticsRoutes));
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, WarTable);
    expect(meta).toMatchObject(NC);
    expect(data.season).toBe(20262027);
    expect(data.players[0].war).toBeGreaterThanOrEqual(data.players[1].war);
    expect(data.players.every(p => p.player.name)).toBe(true);
    // MoneyPuck's own numbers (Game Score, competition) never appear.
    expect(JSON.stringify(data)).not.toMatch(/game_?score|competition/i);
  });

  it('RAPM: CC BY (no MoneyPuck input), players without RAPM left out', async () => {
    const { body } = await get('/v1/nhl/rapm?season=20262027', makeEnv(analyticsRoutes));
    const { data, meta } = expectEnvelope(body, RapmTable);
    expect(meta.license).toBe('CC-BY-4.0');
    const rows = fixture('player-analytics').rows;
    expect(data.players).toHaveLength(rows.filter(r => r.rapm != null).length);
    expect(data.players[0].rapm).toBeGreaterThanOrEqual(data.players.at(-1).rapm);
  });

  it('400 for a malformed season', async () => {
    expect((await get('/v1/nhl/war?season=2026', makeEnv())).status).toBe(400);
  });
});

describe('NHL power rankings', () => {
  it('league table from the poller\'s league route', async () => {
    const env = makeEnv({
      '/nhl/power-rankings/league': { season: 20262027, runDate: '2026-11-16', teams: [{ team: 'COL', rank: 2, prior_rank: 3 }, { team: 'CAR', rank: 1, prior_rank: 1 }, { team: 'ARI', rank: 33, prior_rank: 33 }] },
      ...teamsRoutes('nhl'),
    });
    const { body } = await get('/v1/nhl/power-rankings', env);
    const { data, meta } = expectEnvelope(body, NhlPowerRankings);
    expect(data.teams.map(t => t.team.code)).toEqual(['CAR', 'COL']);
    expect(data.teams[1].previousRank).toBe(3);
    expect(meta).toMatchObject({ ...NC, generatedAt: '2026-11-16' });
  });

  it('one team: latest rank, English paragraph, history oldest first', async () => {
    const env = makeEnv({ '/power-rankings?team=CAR&limit=28': fixture('nhl-pr-car'), ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/teams/car/power-ranking', env);
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, NhlTeamPowerRanking);
    const latest = fixture('nhl-pr-car')[0];
    expect(data).toMatchObject({ rank: latest.rank, previousRank: latest.prior_rank, runDate: latest.generated_date, narrative: latest.narrative });
    expect(data.history.at(-1).runDate).toBe(latest.generated_date);
    expect(data.history[0].runDate < data.history.at(-1).runDate).toBe(true);
  });
});

describe('GET /v1/nhl/teams/{team}/needs', () => {
  it('skater slots only (goalie ratings are MoneyPuck GSAx)', async () => {
    const env = makeEnv({ '/team-needs?team=CAR': fixture('team-needs-car'), ...teamsRoutes('nhl') });
    const { body } = await get('/v1/nhl/teams/CAR/needs', env);
    const { data, meta } = expectEnvelope(body, TeamNeeds);
    expect(meta.license).toBe('CC-BY-NC-4.0');
    expect(data.slots.map(s => s.slot)).toEqual(['F_TOP6_C', 'F_TOP6_W', 'F_BOT6_C', 'F_BOT6_W', 'D_TOP4', 'D_BOT2']);
    expect(data.slots[0].players[0]).toMatchObject({ player: { id: 8482702, name: 'Logan Stankoven', position: 'C' }, rating: 1.23, ratingBasis: 'season', gamesPlayed: 21 });
  });

  it('404 for a code that is not a current team', async () => {
    expect((await get('/v1/nhl/teams/ARI/needs', makeEnv(teamsRoutes('nhl')))).status).toBe(404);
  });
});

describe('GET /v1/nhl/players/{playerId}/trade-fit', () => {
  it('skater: rating kept, every other team best fit first', async () => {
    const env = makeEnv({ '/trade-fit?player=8478427': fixture('trade-fit-aho'), ...teamsRoutes('nhl') });
    const { body } = await get('/v1/nhl/players/8478427/trade-fit', env);
    const { data } = expectEnvelope(body, TradeFit);
    expect(data.player).toMatchObject({ player: { id: 8478427, name: 'Sebastian Aho' }, team: { code: 'CAR' }, rating: 1.0582, clause: 'NMC', phase: 'in_season', rightsOnly: false });
    expect(data.teams.length).toBeGreaterThan(20);
    expect(data.teams[0]).toMatchObject({ team: { code: 'WPG' }, tier: 'strong', rank: 1 });
    expect(data.teams.map(t => t.rank)).toEqual([...data.teams.map(t => t.rank)].sort((a, b) => a - b));
  });

  it('goalie: own rating withheld', async () => {
    const raw = JSON.parse(JSON.stringify(fixture('trade-fit-aho')));
    raw.player = { ...raw.player, position: 'G', rating: 0.21, ratingBasis: 'season' };
    const env = makeEnv({ '/trade-fit?player=8478427': raw, ...teamsRoutes('nhl') });
    const { data } = expectEnvelope((await get('/v1/nhl/players/8478427/trade-fit', env)).body, TradeFit);
    expect(data.player.rating).toBeNull();
    expect(data.player.ratingBasis).toBeNull();
  });

  it('404 outside the population', async () => {
    const env = makeEnv({ '/trade-fit?player=1': { player: null, teams: [], generatedAt: null }, ...teamsRoutes('nhl') });
    expect((await get('/v1/nhl/players/1/trade-fit', env)).status).toBe(404);
  });
});

describe('EyeWall AI text', () => {
  it('recap for one side', async () => {
    const env = makeEnv({ '/game-summary?gameId=2026020321&team=CAR&locale=en': fixture('recap'), ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/games/2026020321/recap?team=CAR', env);
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, Recap);
    expect(data).toMatchObject({ gameId: 2026020321, team: { code: 'CAR' }, locale: 'en' });
    expect(data.text).toMatch(/Carolina/);
    expect(meta.license).toBe('CC-BY-NC-4.0');
  });

  it('recap needs a team; a missing one is a 404', async () => {
    expect((await get('/v1/nhl/games/2026020321/recap', makeEnv())).status).toBe(400);
    const env = makeEnv({ '/game-summary?gameId=2026020321&team=SEA&locale=fr': [], ...teamsRoutes('nhl') });
    expect((await get('/v1/nhl/games/2026020321/recap?team=SEA&locale=fr', env)).status).toBe(404);
  });

  it('preview', async () => {
    const env = makeEnv({ '/game-predictions?gameId=2026020331&locale=en': fixture('preview') });
    const { data } = expectEnvelope((await get('/v1/nhl/games/2026020331/preview', env)).body, Preview);
    expect(data.matchup).toMatch(/Montreal|MTL/);
  });

  it('scouting report', async () => {
    const env = makeEnv({ '/player-scouting?playerId=8478427&locale=en&season=20262027': fixture('scouting') });
    const { data } = expectEnvelope((await get('/v1/nhl/players/8478427/scouting?season=20262027', env)).body, Scouting);
    expect(data).toMatchObject({ playerId: 8478427, season: 20262027, locale: 'en' });
    expect(data.text).toMatch(/Aho/);
  });
});
