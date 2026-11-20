// NHL player and team models:
//   /v1/nhl/rapm                          CC BY 4.0 (no MoneyPuck input)
//   /v1/nhl/war                           CC BY-NC 4.0 (MoneyPuck inputs)
//   /v1/nhl/power-rankings                CC BY-NC
//   /v1/nhl/teams/{team}/power-ranking    CC BY-NC
//   /v1/nhl/teams/{team}/needs            CC BY-NC
//   /v1/nhl/players/{playerId}/trade-fit  CC BY-NC
//
// Goalie ratings in team needs and trade fit are MoneyPuck's goals saved
// above expected per 60, which this API doesn't republish: team needs
// leaves out the goalie slots, and a goalie's own rating is null on trade fit.

import { createRoute, z } from '@hono/zod-openapi';
import { envelope, IsoDate, meta, metaNC, NC_DESCRIPTION, NhlTeamParam, NumericId, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const int = v => (num(v) == null ? null : Math.round(Number(v)));

const PlayerRef = z.object({
  id: z.number().int().openapi({ description: 'NHL player id.', example: 8478427 }),
  name: z.string().nullable(),
  position: z.string().nullable(),
}).openapi('PlayerRef');

const seasonQuery = z.object({
  season: z.string().regex(/^\d{8}$/).optional().openapi({ param: { name: 'season', in: 'query' }, description: 'NHL season id. Defaults to the current season.', example: '20262027' }),
});

async function currentSeason(env) {
  const cfg = await poller(env, '/config/seasons');
  return String(cfg?.nhl?.seasonId ?? '');
}

async function playerNames(env) {
  const list = await poller(env, '/players-list');
  return new Map((Array.isArray(list) ? list : []).map(p => [Number(p.id), { name: p.name ?? null, position: p.position ?? null }]));
}

const playerRef = (names, id) => ({ id: Number(id), name: names.get(Number(id))?.name ?? null, position: names.get(Number(id))?.position ?? null });

// ── RAPM / WAR ───────────────────────────────────────────────────────

export const RapmTable = z.object({
  season: z.number().int(),
  players: z.array(z.object({
    player: PlayerRef,
    team: TeamRef.nullable(),
    rapm: z.number().openapi({ description: 'Net: expected-goal differential per 60 minutes at 5-on-5 above an average player (offence minus defence).' }),
    offence: z.number().nullable().openapi({ description: 'xG per 60 the player adds for his team at 5-on-5. Null until computed with the stint design.' }),
    defence: z.number().nullable().openapi({ description: 'xG per 60 he allows at 5-on-5, relative to average; lower is better. Null until computed with the stint design.' }),
    minutes: z.number().nullable().openapi({ description: '5-on-5 minutes in the three-season sample.' }),
  })).openapi({ description: 'Highest first. Players under 150 minutes in the sample are left out.' }),
}).openapi('RapmTable');

export const WarTable = z.object({
  season: z.number().int(),
  players: z.array(z.object({
    player: PlayerRef,
    team: TeamRef.nullable(),
    gamesPlayed: z.number().int().nullable(),
    war: z.number().openapi({ description: 'Wins above replacement this season.' }),
  })).openapi({ description: 'Highest first.' }),
}).openapi('WarTable');

export function shapeRapm(raw, names, index, season) {
  const players = (raw?.rows ?? [])
    .filter(r => num(r.rapm) != null)
    .map(r => ({ player: playerRef(names, r.player_id), team: index.find(r.team) ? teamRef(index.find(r.team)) : null, rapm: num(r.rapm), offence: num(r.rapm_off), defence: num(r.rapm_def), minutes: num(r.rapm_toi_min) }))
    .sort((a, b) => b.rapm - a.rapm);
  return { season: Number(season), players };
}

export function shapeWar(raw, names, index, season) {
  const players = (raw?.rows ?? [])
    .filter(r => num(r.war) != null)
    .map(r => ({ player: playerRef(names, r.player_id), team: index.find(r.team) ? teamRef(index.find(r.team)) : null, gamesPlayed: int(r.games_played), war: num(r.war) }))
    .sort((a, b) => b.war - a.war);
  return { season: Number(season), players };
}

// ── Power rankings ───────────────────────────────────────────────────

export const NhlPowerRankings = z.object({
  season: z.number().int().nullable(),
  runDate: IsoDate.nullable(),
  teams: z.array(z.object({
    rank: z.number().int(),
    previousRank: z.number().int().nullable(),
    team: TeamRef,
  })).openapi({ description: 'Best first.' }),
}).openapi('NhlPowerRankings');

export const NhlTeamPowerRanking = z.object({
  team: TeamRef,
  rank: z.number().int().nullable(),
  previousRank: z.number().int().nullable(),
  runDate: IsoDate.nullable(),
  narrative: z.string().nullable().openapi({ description: 'EyeWall AI\'s paragraph on the ranking (English).' }),
  history: z.array(z.object({ runDate: IsoDate, rank: z.number().int() })).openapi({ description: 'Up to 28 recent runs this season, oldest first.' }),
}).openapi('NhlTeamPowerRanking');

// ── Team needs ───────────────────────────────────────────────────────

const SKATER_SLOTS = ['F_TOP6_C', 'F_TOP6_W', 'F_BOT6_C', 'F_BOT6_W', 'D_TOP4', 'D_BOT2'];

export const TeamNeeds = z.object({
  team: TeamRef,
  season: z.number().int().nullable(),
  basis: z.string().nullable().openapi({ description: 'The lineup the slots come from: "last_game" or "preseason". Null before the first projection.' }),
  generatedAt: z.string().nullable(),
  slots: z.array(z.object({
    slot: z.enum(SKATER_SLOTS).openapi({ description: 'F_TOP6_C/F_TOP6_W/F_BOT6_C/F_BOT6_W (centers/wingers), D_TOP4, D_BOT2.' }),
    players: z.array(z.object({
      player: PlayerRef,
      shoots: z.string().nullable(),
      rating: z.number().nullable().openapi({ description: 'WAR per 82 games. Null when unrated (too few games this season and last).' }),
      ratingBasis: z.string().nullable().openapi({ description: '"season" (20+ GP this season) or "last_season".' }),
      gamesPlayed: z.number().int().nullable(),
      filledIn: z.boolean(),
    })),
    strength: z.number().nullable(),
    leagueRank: z.number().int().nullable().openapi({ description: '1 = strongest slot in the league.' }),
    leagueTeams: z.number().int().nullable(),
    need: z.boolean().openapi({ description: 'True for the bottom third of the league in this slot.' }),
  })).openapi({ description: 'Skater slots only.' }),
}).openapi('TeamNeeds');

export function shapeTeamNeeds(raw, team) {
  return {
    team: teamRef(team),
    season: num(raw?.season),
    basis: raw?.basis ?? null,
    generatedAt: raw?.generatedAt ?? null,
    slots: (raw?.slots ?? []).filter(s => SKATER_SLOTS.includes(s.slot)).map(s => ({
      slot: s.slot,
      players: (s.players ?? []).map(p => ({
        player: { id: Number(p.id), name: p.name ?? null, position: p.pos ?? null },
        shoots: p.shoots ?? null,
        rating: num(p.rating),
        ratingBasis: p.ratingBasis ?? null,
        gamesPlayed: int(p.gp),
        filledIn: Boolean(p.filled),
      })),
      strength: num(s.strength),
      leagueRank: int(s.leagueRank),
      leagueTeams: int(s.leagueTeams),
      need: Boolean(s.need),
    })),
  };
}

// ── Trade fit ────────────────────────────────────────────────────────

export const TradeFit = z.object({
  player: z.object({
    player: PlayerRef,
    team: TeamRef.nullable(),
    season: z.number().int().nullable(),
    shoots: z.string().nullable(),
    rating: z.number().nullable().openapi({ description: 'WAR per 82 games for a skater. Null for a goalie (MoneyPuck\'s own goals saved above expected).' }),
    ratingBasis: z.string().nullable(),
    gamesPlayed: z.number().int().nullable(),
    capHit: z.number().nullable(),
    yearsLeft: z.number().int().nullable(),
    expiresAfter: z.string().nullable(),
    expiryType: z.string().nullable().openapi({ description: '"UFA" or "RFA" at expiry.' }),
    rental: z.boolean().nullable().openapi({ description: 'True for an expiring contract during the season.' }),
    clause: z.string().nullable().openapi({ description: '"NMC", "NTC" or similar; null for none or unknown.' }),
    phase: z.enum(['in_season', 'offseason']).nullable().openapi({ description: '"offseason" from the day after the trade deadline: the fit is then for next season.' }),
    rightsOnly: z.boolean().nullable(),
  }),
  generatedAt: z.string().nullable(),
  teams: z.array(z.object({
    team: TeamRef,
    tier: z.enum(['strong', 'possible', 'long_shot']),
    rank: z.number().int(),
    slot: z.string().nullable().openapi({ description: 'The lineup slot the player would fill.' }),
    gap: z.number().nullable().openapi({ description: 'How much the player would improve that slot, in rating units.' }),
    needMet: z.boolean().nullable(),
    windowMet: z.boolean().nullable().openapi({ description: 'For a rental: the team is a likely playoff buyer (50%+ playoff odds).' }),
    capState: z.string().nullable().openapi({ description: '"fits", "fits_retained", "fits_ltir" or "needs_salary".' }),
    reasons: z.array(z.record(z.string(), z.unknown())).openapi({ description: 'Structured reasons: each has a `code` (need_upgrade, need_depth, window_term, cap_fits, cap_fits_retained, cap_fits_ltir, cap_needs_salary, …) and the numbers behind it.' }),
  })).openapi({ description: 'Every other team, best fit first.' }),
}).openapi('TradeFit');

export function shapeTradeFit(raw, index) {
  const p = raw?.player;
  if (!p) return null;
  const goalie = p.position === 'G';
  const team = index.find(p.team);
  return {
    player: {
      player: { id: Number(p.id), name: p.name ?? null, position: p.position ?? null },
      team: team ? teamRef(team) : null,
      season: num(p.season),
      shoots: p.shoots ?? null,
      rating: goalie ? null : num(p.rating),
      ratingBasis: goalie ? null : (p.ratingBasis ?? null),
      gamesPlayed: int(p.gamesPlayed),
      capHit: num(p.capHit),
      yearsLeft: int(p.yearsLeft),
      expiresAfter: p.expiresAfter ?? null,
      expiryType: p.expiryType ?? null,
      rental: typeof p.rental === 'boolean' ? p.rental : null,
      clause: p.clause?.kind ?? null,
      phase: p.phase === 'in_season' || p.phase === 'offseason' ? p.phase : null,
      rightsOnly: typeof p.rights === 'boolean' ? p.rights : null,
    },
    generatedAt: raw.generatedAt ?? null,
    teams: (raw.teams ?? [])
      .map(t => ({ t, ref: index.find(t.team) }))
      .filter(({ ref }) => ref)
      .map(({ t, ref }) => ({
        team: teamRef(ref),
        tier: t.tier,
        rank: Number(t.rank),
        slot: t.slot ?? null,
        gap: num(t.gap),
        needMet: typeof t.needMet === 'boolean' ? t.needMet : null,
        windowMet: typeof t.windowMet === 'boolean' ? t.windowMet : null,
        capState: t.capState ?? null,
        reasons: Array.isArray(t.reasons) ? t.reasons : [],
      }))
      .sort((a, b) => a.rank - b.rank),
  };
}

// ── Registration ─────────────────────────────────────────────────────

async function nhlTeam(c) {
  const code = c.req.valid('param').team.toUpperCase();
  const index = await teamIndex(c.env, 'nhl');
  return { code, index, team: index.find(code) };
}

export function registerNhlModels(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/rapm', operationId: 'getNhlRapm', tags: ['Players'],
    summary: 'RAPM for every NHL skater',
    description: 'Regularized adjusted plus-minus: each skater\'s 5-on-5 expected-goal impact, offence and defence, with teammates, opponents, home ice and score state accounted for. Three-season rolling sample of 5-on-5 stints, recomputed nightly. Uses EyeWall\'s own xG model (no MoneyPuck input).',
    request: { query: seasonQuery },
    responses: { 200: { description: 'RAPM', content: { 'application/json': { schema: envelope('RapmResponse', RapmTable) } } }, ...problemResponses },
  }), async c => {
    const season = c.req.valid('query').season ?? await currentSeason(c.env);
    const [raw, names, index] = await Promise.all([
      poller(c.env, `/player-analytics?season=${season}`), playerNames(c.env), teamIndex(c.env, 'nhl'),
    ]);
    const data = shapeRapm(raw, names, index, season);
    return send(c, data, meta('nhl', 'EyeWall RAPM'), data.players.length ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/war', operationId: 'getNhlWar', tags: ['Players'],
    summary: 'WAR for every NHL player',
    description: `Wins above replacement: EyeWall's formula from RAPM, finishing, and penalties taken and drawn. ${NC_DESCRIPTION}`,
    request: { query: seasonQuery },
    responses: { 200: { description: 'WAR', content: { 'application/json': { schema: envelope('WarResponse', WarTable) } } }, ...problemResponses },
  }), async c => {
    const season = c.req.valid('query').season ?? await currentSeason(c.env);
    const [raw, names, index] = await Promise.all([
      poller(c.env, `/player-analytics?season=${season}`), playerNames(c.env), teamIndex(c.env, 'nhl'),
    ]);
    const data = shapeWar(raw, names, index, season);
    return send(c, data, metaNC('nhl', 'EyeWall WAR'), data.players.length ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/power-rankings', operationId: 'getNhlPowerRankings', tags: ['Rankings'],
    summary: 'NHL power rankings',
    description: `EyeWall's nightly NHL power rankings: points percentage, the last 10 games, goal difference, 5-on-5 xGF% and special teams, with roster WAR weighed in early in the season. ${NC_DESCRIPTION}`,
    request: { query: seasonQuery },
    responses: { 200: { description: 'Power rankings', content: { 'application/json': { schema: envelope('NhlPowerRankingsResponse', NhlPowerRankings) } } }, ...problemResponses },
  }), async c => {
    const { season } = c.req.valid('query');
    const [raw, index] = await Promise.all([
      poller(c.env, `/nhl/power-rankings/league${season ? `?season=${season}` : ''}`), teamIndex(c.env, 'nhl'),
    ]);
    const teams = (raw?.teams ?? [])
      .map(r => ({ r, t: index.find(r.team) })).filter(({ t }) => t)
      .map(({ r, t }) => ({ rank: Number(r.rank), previousRank: int(r.prior_rank), team: teamRef(t) }))
      .sort((a, b) => a.rank - b.rank);
    const data = { season: num(raw?.season), runDate: raw?.runDate ?? null, teams };
    return send(c, data, metaNC('nhl', 'EyeWall power rankings', data.runDate), teams.length ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/teams/{team}/power-ranking', operationId: 'getNhlTeamPowerRanking', tags: ['Rankings'],
    summary: 'One NHL team\'s power ranking, with EyeWall AI\'s paragraph',
    description: NC_DESCRIPTION,
    request: { params: NhlTeamParam, query: seasonQuery },
    responses: { 200: { description: 'Team power ranking', content: { 'application/json': { schema: envelope('NhlTeamPowerRankingResponse', NhlTeamPowerRanking) } } }, ...problemResponses },
  }), async c => {
    const { code, team } = await nhlTeam(c);
    if (!team) return problem(c, 404, 'Not Found', `no current NHL team ${code} (see /v1/nhl/teams)`);
    const { season } = c.req.valid('query');
    const rows = await poller(c.env, `/power-rankings?team=${code}&limit=28${season ? `&season=${season}` : ''}`);
    const list = Array.isArray(rows) ? rows : [];
    const latest = list[0] ?? null;
    const data = {
      team: teamRef(team),
      rank: int(latest?.rank),
      previousRank: int(latest?.prior_rank),
      runDate: latest?.generated_date ?? null,
      narrative: latest?.narrative ?? null,
      history: list.slice().reverse().filter(r => r.generated_date && r.rank != null).map(r => ({ runDate: r.generated_date, rank: Number(r.rank) })),
    };
    return send(c, data, metaNC('nhl', 'EyeWall power rankings + EyeWall AI', data.runDate), latest ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/teams/{team}/needs', operationId: 'getNhlTeamNeeds', tags: ['Lineups'],
    summary: 'A team\'s lineup slots, rated and ranked league-wide',
    description: `Skater slots of the projected lineup with each player's WAR per 82, the slot's strength and league rank; the bottom third is flagged as a need. ${NC_DESCRIPTION}`,
    request: { params: NhlTeamParam },
    responses: { 200: { description: 'Team needs', content: { 'application/json': { schema: envelope('TeamNeedsResponse', TeamNeeds) } } }, ...problemResponses },
  }), async c => {
    const { code, team } = await nhlTeam(c);
    if (!team) return problem(c, 404, 'Not Found', `no current NHL team ${code} (see /v1/nhl/teams)`);
    const data = shapeTeamNeeds(await poller(c.env, `/team-needs?team=${code}`), team);
    return send(c, data, metaNC('nhl', 'EyeWall team needs', data.generatedAt), data.slots.length ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/players/{playerId}/trade-fit', operationId: 'getNhlTradeFit', tags: ['Players'],
    summary: 'Which teams a player fits',
    description: `Every other team ranked strong / possible / long shot on need, window (a rental needs a likely playoff team) and cap space. A fit, not a trade prediction. ${NC_DESCRIPTION}`,
    request: { params: z.object({ playerId: NumericId('playerId', '8478427') }) },
    responses: { 200: { description: 'Trade fit', content: { 'application/json': { schema: envelope('TradeFitResponse', TradeFit) } } }, ...problemResponses },
  }), async c => {
    const { playerId } = c.req.valid('param');
    const [raw, index] = await Promise.all([poller(c.env, `/trade-fit?player=${playerId}`), teamIndex(c.env, 'nhl')]);
    const data = shapeTradeFit(raw, index);
    if (!data) return problem(c, 404, 'Not Found', 'player is not in the trade fit population (rated, 10+ games or 5+ for goalies, on a current non-entry-level contract)');
    return send(c, data, metaNC('nhl', 'EyeWall trade fit', data.generatedAt), 3600);
  });
}
