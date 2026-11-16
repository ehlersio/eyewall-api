// NHL contracts routes (CC0, from the nhl-contracts dataset). Fixtures are
// real poller responses from 2026-11-16, trimmed.

import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { fixture, get, makeEnv, teamsRoutes } from './helpers.js';
import { Meta } from '../src/schemas.js';
import { LeagueContracts, PlayerContracts, seasonId, seasonLabel, TeamCapSummaries, TeamContracts } from '../src/routes/contracts.js';

const expectEnvelope = (body, schema) => z.object({ data: schema, meta: Meta }).strict().parse(body);
const CC0 = { license: 'CC0-1.0', league: 'nhl', source: 'nhl-contracts dataset (github.com/ehlersio/nhl-contracts)' };

describe('season ids', () => {
  it('converts between the API\'s ids and the dataset\'s labels', () => {
    expect(seasonId('2026-27')).toBe(20262027);
    expect(seasonId('1999-00')).toBe(19992000);
    expect(seasonLabel('20262027')).toBe('2026-27');
    expect(seasonId(null)).toBeNull();
  });
});

describe('GET /v1/nhl/players/{playerId}/contracts', () => {
  const raw = fixture('contracts-player-crosby');

  it('history newest first, with season rows and clauses; CC0 meta with the dataset date', async () => {
    const { status, body, res } = await get('/v1/nhl/players/8471675/contracts', makeEnv({ '/contracts/player/8471675': raw }));
    expect(status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const { data, meta } = expectEnvelope(body, PlayerContracts);
    expect(meta).toMatchObject({ ...CC0, generatedAt: raw.asOf });
    expect(data.player).toEqual({ id: 8471675, name: 'Sidney Crosby' });
    expect(data.season).toBe(20262027);
    expect(data.history).toHaveLength(raw.history.length);
    expect(data.history[0].startSeason).toBe(seasonId(raw.history[0].startSeason));
    const seasons = data.history.flatMap(h => h.seasons);
    expect(seasons.length).toBeGreaterThan(0);
    expect(seasons.every(s => Number.isInteger(s.season))).toBe(true);
    expect(data.current.capHit).toBe(raw.current.capHit);
    expect(data.current.key).toBe(raw.current.contractKey);
    // provenance survives: tier, sources, conflicts as a list
    expect(data.current.tier).toBe(raw.current.tier);
    expect(Array.isArray(data.current.conflicts)).toBe(true);
  });

  it('passes the season to the poller as its label', async () => {
    const env = makeEnv({ '/contracts/player/8471675?season=2023-24': raw });
    expect((await get('/v1/nhl/players/8471675/contracts?season=20232024', env)).status).toBe(200);
  });

  it('404 for a player the dataset has no contract for', async () => {
    const { status, body } = await get('/v1/nhl/players/8480222/contracts', makeEnv({ '/contracts/player/8480222': fixture('contracts-player-empty') }));
    expect(status).toBe(404);
    expect(body.detail).toMatch(/no contracts/);
  });

  it('400 for a malformed season', async () => {
    expect((await get('/v1/nhl/players/8471675/contracts?season=2026', makeEnv())).status).toBe(400);
    expect((await get('/v1/nhl/players/8471675/contracts?season=20262028', makeEnv())).status).toBe(400);
  });
});

describe('GET /v1/nhl/teams/{team}/contracts', () => {
  it('roster and off-roster deals, missing figures, summary with estimate notes', async () => {
    const raw = fixture('contracts-team-car');
    const env = makeEnv({ '/contracts?team=CAR': raw, ...teamsRoutes('nhl') });
    const { status, body } = await get('/v1/nhl/teams/car/contracts', env);
    expect(status).toBe(200);
    const { data, meta } = expectEnvelope(body, TeamContracts);
    expect(meta.license).toBe('CC0-1.0');
    expect(data.team.code).toBe('CAR');
    expect(data.contracts).toHaveLength(raw.rows.length);
    expect(data.contracts.some(r => !r.onRoster)).toBe(true);
    expect(data.contracts.some(r => r.alternates > 0)).toBe(true);
    expect(data.summary.capSpaceEstimate).toBe(raw.summary.capSpaceEstimate);
    expect(data.summary.estimateNotes).toEqual(raw.summary.estimateNotes);
    expect(data.summary.capLimits.ceiling).toBe(raw.summary.capLimits.ceiling);
  });

  it('dead cap and LTIR players', async () => {
    const raw = fixture('contracts-team-edm');
    const { body } = await get('/v1/nhl/teams/EDM/contracts', makeEnv({ '/contracts?team=EDM': raw, ...teamsRoutes('nhl') }));
    const { data } = expectEnvelope(body, TeamContracts);
    expect(data.deadCap[0]).toMatchObject({ kind: 'buyout', player: { name: raw.deadCap[0].playerName }, capHit: raw.deadCap[0].capHit });
    expect(data.summary.ltir.players).toHaveLength(raw.summary.ltir.players.length);
    expect(data.summary.ltir.players.flatMap(p => p.conflicts)).toEqual(raw.summary.ltir.players.flatMap(p => p.conflicts));
  });

  it('shorter cache when the roster could not be read', async () => {
    const raw = { ...fixture('contracts-team-car'), rosterKnown: false };
    const { res } = await get('/v1/nhl/teams/CAR/contracts', makeEnv({ '/contracts?team=CAR': raw, ...teamsRoutes('nhl') }));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('404 for a team that is not a current NHL team; 503 when the dataset read failed', async () => {
    expect((await get('/v1/nhl/teams/ARI/contracts', makeEnv(teamsRoutes('nhl')))).status).toBe(404);
    const failed = { team: 'CAR', season: '2026-27', asOf: null, rosterKnown: true, rows: [], missing: [], summary: null, unavailable: true };
    expect((await get('/v1/nhl/teams/CAR/contracts', makeEnv({ '/contracts?team=CAR': failed, ...teamsRoutes('nhl') }))).status).toBe(503);
  });
});

describe('GET /v1/nhl/contracts', () => {
  it('every player, no clauses, current team beside the signing team', async () => {
    const raw = fixture('contracts-players');
    const { status, body } = await get('/v1/nhl/contracts', makeEnv({ '/contracts/players': raw }));
    expect(status).toBe(200);
    const { data } = expectEnvelope(body, LeagueContracts);
    expect(data.teamsKnown).toBe(32);
    expect(data.players).toHaveLength(raw.players.length);
    expect(data.players.every(p => !('clauses' in p))).toBe(true);
    expect(data.players.some(p => p.capHit == null && p.capHitBasis == null)).toBe(true);
    expect(data.players.some(p => !p.onRoster)).toBe(true);
    // a roster player the dataset has no contract for: a row with nulls, not dropped
    expect(data.players.some(p => p.key == null && p.onRoster && p.capHit == null)).toBe(true);
  });
});

describe('GET /v1/nhl/contracts/teams', () => {
  it('basis=roster by default, with estimate notes', async () => {
    const raw = fixture('contracts-summary-roster');
    const { body } = await get('/v1/nhl/contracts/teams', makeEnv({ '/contracts/summary?basis=roster': raw }));
    const { data } = expectEnvelope(body, TeamCapSummaries);
    expect(data.basis).toBe('roster');
    expect(data.teams.map(t => t.team)).toEqual(raw.teams.map(t => t.team));
    expect(data.estimateNotes).toEqual(raw.estimateNotes);
    expect(data.teams[0].ltir.players.length).toBe(raw.teams[0].ltir.players.length);
  });

  it('basis=signing_team', async () => {
    const raw = fixture('contracts-summary');
    const { body } = await get('/v1/nhl/contracts/teams?basis=signing_team&season=20262027', makeEnv({ '/contracts/summary?season=2026-27': raw }));
    const { data } = expectEnvelope(body, TeamCapSummaries);
    expect(data.basis).toBe('signing_team');
    expect(data.teams[0]).toMatchObject({ team: raw.teams[0].team, contracts: raw.teams[0].contracts, capHitTotal: raw.teams[0].capHitTotal });
  });
});
