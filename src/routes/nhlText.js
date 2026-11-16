// EyeWall AI text for the NHL, read from what the nightly pipeline already
// wrote (nothing here generates text on request):
//   /v1/nhl/games/{gameId}/recap?team=&locale=
//   /v1/nhl/games/{gameId}/preview?locale=
//   /v1/nhl/players/{playerId}/scouting?season=&locale=
// CC BY-NC: the prompts include MoneyPuck-based numbers (game xG, WAR).

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, Locale, metaNC, NC_DESCRIPTION, NumericId, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

const AI_NOTE = 'Written by EyeWall AI from EyeWall\'s data; every number in it comes from that data.';

export const Recap = z.object({
  gameId: z.number().int(),
  team: TeamRef.openapi({ description: 'The side the recap is written for.' }),
  locale: Locale,
  text: z.string(),
  cardText: z.string().nullable().openapi({ description: 'A one-line version for cards and notifications.' }),
  generatedAt: z.string().nullable(),
}).openapi('GameRecap');

export const Preview = z.object({
  gameId: z.number().int(),
  locale: Locale,
  matchup: z.string().nullable().openapi({ description: 'Line-by-line matchup analysis.' }),
  prediction: z.string().nullable().openapi({ description: 'The pregame read.' }),
  generatedAt: z.string().nullable(),
}).openapi('GamePreview');

export const Scouting = z.object({
  playerId: z.number().int(),
  season: z.number().int().nullable(),
  locale: Locale,
  text: z.string(),
  generatedAt: z.string().nullable(),
}).openapi('ScoutingReport');

const localeQuery = { locale: Locale.optional().openapi({ param: { name: 'locale', in: 'query' } }) };
const first = rows => (Array.isArray(rows) ? rows[0] : null) ?? null;

export function registerNhlText(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/games/{gameId}/recap', operationId: 'getNhlGameRecap', tags: ['EyeWall AI'],
    summary: 'Game recap for one side (NHL)',
    description: `${AI_NOTE} Written the night of the game for each team. ${NC_DESCRIPTION}`,
    request: {
      params: z.object({ gameId: NumericId('gameId', '2026020321') }),
      query: z.object({
        team: z.string().regex(/^[A-Za-z]{3}$/).openapi({ param: { name: 'team', in: 'query' }, description: 'Team code of the side to read the recap for.', example: 'CAR' }),
        ...localeQuery,
      }),
    },
    responses: { 200: { description: 'Recap', content: { 'application/json': { schema: envelope('GameRecapResponse', Recap) } } }, ...problemResponses },
  }), async c => {
    const { gameId } = c.req.valid('param');
    const { team: rawTeam, locale = 'en' } = c.req.valid('query');
    const code = rawTeam.toUpperCase();
    const index = await teamIndex(c.env, 'nhl');
    const team = index.find(code);
    if (!team) return problem(c, 404, 'Not Found', `no current NHL team ${code}`);
    const row = first(await poller(c.env, `/game-summary?gameId=${gameId}&team=${code}&locale=${locale}`));
    if (!row?.summary_text) return problem(c, 404, 'Not Found', 'no recap for this game and team (written the night of the game)');
    const data = { gameId: Number(gameId), team: teamRef(team), locale, text: row.summary_text, cardText: row.card_text ?? null, generatedAt: row.generated_at ?? null };
    return send(c, data, metaNC('nhl', 'EyeWall AI game recap', data.generatedAt), 86400);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/games/{gameId}/preview', operationId: 'getNhlGamePreview', tags: ['EyeWall AI'],
    summary: 'Game preview (NHL)',
    description: `${AI_NOTE} Written before the game. ${NC_DESCRIPTION}`,
    request: { params: z.object({ gameId: NumericId('gameId', '2026020333') }), query: z.object(localeQuery) },
    responses: { 200: { description: 'Preview', content: { 'application/json': { schema: envelope('GamePreviewResponse', Preview) } } }, ...problemResponses },
  }), async c => {
    const { gameId } = c.req.valid('param');
    const { locale = 'en' } = c.req.valid('query');
    const row = first(await poller(c.env, `/game-predictions?gameId=${gameId}&locale=${locale}`));
    if (!row || (!row.matchup_text && !row.prediction_text)) return problem(c, 404, 'Not Found', 'no preview for this game yet');
    const data = { gameId: Number(gameId), locale, matchup: row.matchup_text ?? null, prediction: row.prediction_text ?? null, generatedAt: row.generated_at ?? null };
    return send(c, data, metaNC('nhl', 'EyeWall AI game preview', data.generatedAt), 1800);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/players/{playerId}/scouting', operationId: 'getNhlScouting', tags: ['EyeWall AI'],
    summary: 'Scouting report (NHL)',
    description: `${AI_NOTE} ${NC_DESCRIPTION}`,
    request: {
      params: z.object({ playerId: NumericId('playerId', '8478427') }),
      query: z.object({
        season: z.string().regex(/^\d{8}$/).optional().openapi({ param: { name: 'season', in: 'query' }, description: 'NHL season id. Defaults to the current season.' }),
        ...localeQuery,
      }),
    },
    responses: { 200: { description: 'Scouting report', content: { 'application/json': { schema: envelope('ScoutingResponse', Scouting) } } }, ...problemResponses },
  }), async c => {
    const { playerId } = c.req.valid('param');
    const { season, locale = 'en' } = c.req.valid('query');
    const row = first(await poller(c.env, `/player-scouting?playerId=${playerId}&locale=${locale}${season ? `&season=${season}` : ''}`));
    if (!row?.scouting_text) return problem(c, 404, 'Not Found', 'no scouting report for this player and season');
    const data = { playerId: Number(playerId), season: season ? Number(season) : null, locale, text: row.scouting_text, generatedAt: row.generated_at ?? null };
    return send(c, data, metaNC('nhl', 'EyeWall AI scouting report', data.generatedAt), 3600);
  });
}
