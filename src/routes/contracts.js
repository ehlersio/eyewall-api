// NHL contracts, from EyeWall's open nhl-contracts dataset (CC0,
// github.com/ehlersio/nhl-contracts) as the poller's /contracts* routes
// serve it (eyewall-pipeline mirrors the dataset into Supabase nightly):
//   /v1/nhl/players/{playerId}/contracts   one player's contract history
//   /v1/nhl/teams/{team}/contracts         a team's contracts for a season
//   /v1/nhl/contracts                      every rostered player's contract
//   /v1/nhl/contracts/teams                per-team totals
//
// The merged contract rows only: the per-source claims behind each number
// (and the evidence sentences) are in the dataset's release files, which
// every response links. Provenance stays on every contract: the best
// source tier (A-E), how many sources, and the fields they disagree on.

import { createRoute, z } from '@hono/zod-openapi';
import { DOCS_URL, envelope, NhlTeamParam, NumericId, problemResponses, TeamRef } from '../schemas.js';
import { poller } from '../poller.js';
import { problem, send } from '../respond.js';
import { teamIndex, teamRef } from '../teams.js';

export const LICENSE_CC0 = 'CC0-1.0';
export const DATASET_URL = 'https://github.com/ehlersio/nhl-contracts';
export const ATTRIBUTION_CONTRACTS = 'nhl-contracts by EyeWall Analytics (github.com/ehlersio/nhl-contracts); CC0, credit appreciated, not required';
const SOURCE = 'nhl-contracts dataset (github.com/ehlersio/nhl-contracts)';

export const CONTRACTS_TAG_DESCRIPTION = `NHL contracts from EyeWall's open [nhl-contracts](${DATASET_URL}) dataset: **CC0**, no credit required. Every number is tied to the public document it came from; \`tier\` says what kind of document (A club release on NHL.com, B NHL.com staff story, C ESPN's transaction wire, D PuckPedia's public posts or insiders quoted on r/hockey, E CapFriendly as archived by the Internet Archive). Where sources disagree the field is null and named in \`conflicts\`, never resolved. The per-source claims, with the sentence each number came from, are in the dataset's release files. Refreshed nightly.`;
// Operation descriptions stay under 300 characters (ChatGPT GPT Actions).
const CC0_NOTE = 'CC0, from the nhl-contracts dataset; tiers and conflicts as in the Contracts tag.';

function contractsMeta(asOf) {
  return {
    league: 'nhl',
    source: SOURCE,
    license: LICENSE_CC0,
    attribution: ATTRIBUTION_CONTRACTS,
    generatedAt: asOf ?? null,
    docs: DOCS_URL,
  };
}

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const int = v => (num(v) == null ? null : Math.round(Number(v)));
const list = v => (Array.isArray(v) ? v : v ? String(v).split(';').filter(Boolean) : []);

// '2026-27' <-> 20262027
export function seasonId(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label ?? ''));
  return m ? Number(`${m[1]}${Number(m[1]) + 1}`) : null;
}
export function seasonLabel(id) {
  const s = String(id);
  return `${s.slice(0, 4)}-${s.slice(6, 8)}`;
}

const SeasonIdField = z.number().int().openapi({ description: 'NHL season id.', example: 20262027 });

export const contractsSeasonQuery = z.object({
  season: z.string().regex(/^\d{4}(\d{4})$/).refine(s => Number(s.slice(4)) === Number(s.slice(0, 4)) + 1, 'season must be two consecutive years, e.g. 20262027')
    .optional()
    .openapi({ param: { name: 'season', in: 'query' }, description: 'NHL season id. Defaults to the current season.', example: '20262027' }),
});

const seasonParam = q => (q.season ? `season=${seasonLabel(q.season)}` : '');
const withQuery = (path, ...parts) => {
  const qs = parts.filter(Boolean).join('&');
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
};

// ── Schemas ──────────────────────────────────────────────────────────

const Tier = z.enum(['A', 'B', 'C', 'D', 'E']).openapi('ContractSourceTier', {
  description: 'A club release on NHL.com, B NHL.com staff story, C ESPN transaction wire, D PuckPedia\'s public posts or insiders quoted on r/hockey, E archived CapFriendly page.',
});

const ContractPlayer = z.object({
  id: z.number().int().nullable().openapi({ description: 'NHL player id; null when no source gave or matched one.', example: 8478427 }),
  name: z.string().nullable().openapi({ example: 'Sebastian Aho' }),
}).openapi('ContractPlayer');

const ClauseStatus = z.object({
  status: z.enum(['clause', 'none', 'none_likely', 'unknown']).openapi({ description: '"clause": a no-move or no-trade clause applies; "none": a source says there is none; "none_likely": none reported where one would be; "unknown".' }),
  basis: z.string().nullable().openapi({ description: 'What the status rests on: "source", "stated", "capfriendly_2024", "ineligible" or "breakdown_without_clause".' }),
}).openapi('ClauseStatus');

const Clause = z.object({
  kind: z.string().openapi({ description: '"NMC" (no-move), "NTC" (no-trade) or "M-NTC" (modified no-trade).', example: 'NMC' }),
  fromSeason: SeasonIdField.nullable(),
  toSeason: SeasonIdField.nullable(),
  listSize: z.number().int().nullable().openapi({ description: 'For a modified clause: the number of teams on the list, when stated.' }),
  listType: z.string().nullable().openapi({ description: '"no-trade" (teams he cannot be traded to) or "approved", when stated.' }),
  tier: Tier.nullable(),
}).openapi('ContractClause');

export const Contract = z.object({
  key: z.string().nullable().openapi({ description: 'The dataset\'s contract_key: NHL player id (or normalized name) | signing team | signing month. Null on /v1/nhl/contracts for a roster player the dataset has no contract for.', example: '8478427|CAR|2023-07' }),
  player: ContractPlayer,
  signingTeam: z.string().nullable().openapi({ description: 'Code of the team that signed the contract, as it was then (ARI for the Coyotes). A player traded since keeps it.', example: 'CAR' }),
  signedAt: z.string().nullable().openapi({ description: 'Signing date when a source states it, else the date the deal was first published.', example: '2023-07-26' }),
  contractType: z.string().nullable().openapi({ description: '"ELC", "standard", "extension" or "PTO".' }),
  termYears: z.number().int().nullable(),
  startSeason: SeasonIdField.nullable(),
  endSeason: SeasonIdField.nullable().openapi({ description: 'Last season of the contract (for a bought-out deal, the last season before the buyout).' }),
  yearsLeft: z.number().int().nullable().openapi({ description: 'Seasons left after the requested one (history: after the current season).' }),
  capHit: z.number().int().nullable().openapi({ description: 'Cap hit in USD for the requested season (history: the contract\'s stated cap hit or AAV). Null when no source states one.' }),
  capHitBasis: z.enum(['season', 'contract', 'aav']).nullable().openapi({ description: 'Where capHit comes from: the season breakdown, the contract\'s stated cap hit, or its AAV.' }),
  capHitTier: Tier.nullable(),
  aav: z.number().int().nullable().openapi({ description: 'Stated average annual value, USD.' }),
  totalValue: z.number().int().nullable().openapi({ description: 'Stated total value, USD.' }),
  oneWay: z.boolean().nullable().openapi({ description: 'True one-way, false two-way, null not stated.' }),
  expiryType: z.string().nullable().openapi({ description: '"UFA" or "RFA" at expiry.' }),
  expiryTypeDerived: z.boolean().openapi({ description: 'True when expiryType was worked out from age and service rules rather than stated by a source.' }),
  current: z.boolean().openapi({ description: 'The dataset marks the contract as running now.' }),
  boughtOut: z.boolean(),
  endSeasonSigned: SeasonIdField.nullable().openapi({ description: 'For a bought-out contract: the season it was signed to run through.' }),
  tier: Tier.nullable().openapi({ description: 'Best source tier behind the contract.' }),
  official: z.boolean().openapi({ description: 'True when the best source is tier A-C (club, NHL.com or ESPN).' }),
  sources: z.number().int().nullable().openapi({ description: 'Number of source documents.' }),
  conflicts: z.array(z.string()).openapi({ description: 'Fields the sources disagree on (left null rather than picked), e.g. ["aav_usd"].' }),
  clauses: z.array(Clause),
}).openapi('Contract');

const ContractSeason = z.object({
  season: SeasonIdField,
  capHit: z.number().int().nullable(),
  aav: z.number().int().nullable(),
  baseSalary: z.number().int().nullable(),
  signingBonus: z.number().int().nullable(),
  performanceBonus: z.number().int().nullable(),
  totalSalary: z.number().int().nullable(),
  minorsSalary: z.number().int().nullable().openapi({ description: 'AHL salary of a two-way season.' }),
  oneWay: z.boolean().nullable(),
  clause: z.string().nullable().openapi({ description: 'Clause label for the season as the source writes it.' }),
  clauseStatus: ClauseStatus.nullable(),
  tier: Tier.nullable(),
}).openapi('ContractSeason');

export const PlayerContracts = z.object({
  player: ContractPlayer,
  season: SeasonIdField,
  current: Contract.extend({ clauseStatus: ClauseStatus.nullable() }).nullable().openapi({ description: 'The contract covering `season`, or null.' }),
  history: z.array(Contract.extend({ seasons: z.array(ContractSeason) })).openapi({ description: 'Every contract the dataset has for the player, newest first.' }),
}).openapi('PlayerContracts');

const CapLimits = z.object({
  ceiling: z.number().int().nullable(),
  floor: z.number().int().nullable(),
  minSalary: z.number().int().nullable(),
}).openapi('CapLimits', { description: 'The NHL\'s announced cap ceiling, floor and minimum salary for the season; null when not announced.' });

const Expiring = z.object({ ufa: z.number().int(), rfa: z.number().int(), unknown: z.number().int() })
  .openapi('ExpiringCounts', { description: 'Contracts ending after the season, by status at expiry.' });

const LtirPlayer = z.object({
  player: ContractPlayer,
  capHit: z.number().int().nullable(),
  since: z.string().nullable().openapi({ description: 'Placement date when a source states it.' }),
  firstSeen: z.string().nullable().openapi({ description: 'First day the dataset saw him on long-term IR.' }),
  onRoster: z.boolean().nullable(),
  statedRelief: z.number().int().nullable().openapi({ description: 'LTIR relief as PuckPedia stated it, when it did.' }),
  statedAt: z.string().nullable(),
  conflicts: z.array(z.string()).openapi({ description: 'Where sources disagree, e.g. "team:BUF|EDM".' }),
}).openapi('LtirPlayer');

const Ltir = z.object({
  players: z.array(LtirPlayer),
  capHitTotal: z.number().int().nullable().openapi({ description: 'Sum of their cap hits: an upper bound on relief, not the relief.' }),
  statedRelief: z.number().int().nullable(),
  statedAt: z.string().nullable(),
  offRosterCapHit: z.number().int().nullable().openapi({ description: 'Cap hits of LTIR players missing from the NHL\'s roster list, which the estimate still counts.' }),
}).openapi('LtirSummary', { description: 'Active long-term injured reserve. Null when the LTIR table could not be read.' });

const ESTIMATE_DESCRIPTION = 'Ceiling minus the roster cap hit, dead cap and LTIR players missing from the roster list. An estimate, not cap space: `estimateNotes` says what it leaves out (no_ltir, no_bonus_overages, no_recapture, partial_coverage).';

const TeamContract = Contract.extend({
  position: z.string().nullable(),
  onRoster: z.boolean().openapi({ description: 'On the team\'s current NHL roster. False: a deal the team signed whose player is elsewhere now.' }),
  alternates: z.number().int().openapi({ description: 'Other rows the dataset holds for the same deal (an id-keyed and an archived name-keyed row, say); this one was chosen by tier and source count.' }),
});

const DeadCap = z.object({
  kind: z.enum(['buyout', 'retained']),
  player: ContractPlayer,
  counterparty: z.string().nullable().openapi({ description: 'For retained salary: the team the player was traded to, when stated.' }),
  capHit: z.number().int().nullable(),
  pct: z.number().nullable().openapi({ description: 'Share of salary retained, when stated.' }),
  eventDate: z.string().nullable(),
  contractKey: z.string().nullable(),
  tier: Tier.nullable(),
}).openapi('DeadCapCharge');

export const TeamContracts = z.object({
  team: TeamRef,
  season: SeasonIdField,
  rosterKnown: z.boolean().openapi({ description: 'False when the NHL roster could not be read: then only deals the team signed are listed.' }),
  contracts: z.array(TeamContract).openapi({ description: 'One contract per player: everyone on the current roster, then deals the team signed whose player is elsewhere (`onRoster` false). Cap hit descending.' }),
  missing: z.array(z.object({
    player: ContractPlayer,
    position: z.string().nullable(),
    gap: z.string().openapi({ description: '"no_contract", "no_money" or "no_structure".' }),
    status: z.string().nullable().openapi({ description: 'Why: older rows only, mentioned but not parsed, or absent from every source.' }),
  })).openapi({ description: 'Roster players the dataset has no contract figure for.' }),
  deadCap: z.array(DeadCap).nullable().openapi({ description: 'Buyout charges and retained salary the team carries this season; null when unreadable.' }),
  summary: z.object({
    capLimits: CapLimits.nullable(),
    rosterCapHit: z.number().int().nullable(),
    rosterCount: z.number().int().nullable(),
    rosterWithFigure: z.number().int().nullable(),
    offRosterCount: z.number().int().nullable(),
    expiring: Expiring.nullable(),
    deadCapTotal: z.number().int().nullable(),
    capSpaceEstimate: z.number().int().nullable().openapi({ description: ESTIMATE_DESCRIPTION }),
    estimateNotes: z.array(z.string()),
    ltir: Ltir.nullable(),
  }).nullable(),
}).openapi('TeamContracts');

export const LeagueContracts = z.object({
  season: SeasonIdField,
  teamsKnown: z.number().int().openapi({ description: 'Teams whose roster was read (32 when complete).' }),
  capLimits: CapLimits.nullable(),
  players: z.array(Contract.omit({ clauses: true }).extend({
    currentTeam: z.string().nullable().openapi({ description: 'Code of the roster the player is on now (signingTeam may differ).' }),
    position: z.string().nullable(),
    onRoster: z.boolean(),
  })).openapi({ description: 'Every player on an NHL roster today or with a contract covering the season, cap hit descending, figures first. No clauses (see the player route).' }),
}).openapi('LeagueContracts');

export const TeamCapSummaries = z.object({
  season: SeasonIdField,
  basis: z.enum(['roster', 'signing_team']),
  capLimits: CapLimits.nullable(),
  teamsKnown: z.number().int().nullable().openapi({ description: 'basis=roster: teams whose roster was read.' }),
  teams: z.array(z.object({
    team: z.string().openapi({ description: 'Team code.', example: 'CAR' }),
    contracts: z.number().int().nullable().openapi({ description: 'basis=signing_team: contracts the team signed that cover the season.' }),
    withFigure: z.number().int().nullable(),
    capHitTotal: z.number().int().nullable().openapi({ description: 'basis=signing_team: cap hits of those contracts.' }),
    rosterCount: z.number().int().nullable(),
    rosterWithFigure: z.number().int().nullable(),
    rosterCapHit: z.number().int().nullable(),
    offRosterCount: z.number().int().nullable(),
    expiring: Expiring.nullable(),
    deadCapTotal: z.number().int().nullable(),
    capSpaceEstimate: z.number().int().nullable().openapi({ description: `basis=roster. ${ESTIMATE_DESCRIPTION}` }),
    ltir: Ltir.nullable(),
  })),
  estimateNotes: z.array(z.string()),
}).openapi('TeamCapSummaries');

// ── Shaping ──────────────────────────────────────────────────────────

const tier = v => (['A', 'B', 'C', 'D', 'E'].includes(v) ? v : null);
const player = (id, name) => ({ id: int(id), name: name ?? null });
const capHitBasis = v => (['season', 'contract', 'aav'].includes(v) ? v : null);

function shapeClause(c) {
  return {
    kind: c.kind,
    fromSeason: seasonId(c.from),
    toSeason: seasonId(c.to),
    listSize: int(c.listSize),
    listType: c.listType ?? null,
    tier: tier(c.tier),
  };
}

function shapeClauseStatus(s) {
  return s && ['clause', 'none', 'none_likely', 'unknown'].includes(s.status) ? { status: s.status, basis: s.basis ?? null } : null;
}

export function shapeContract(c) {
  return {
    key: c.contractKey,
    player: player(c.playerId, c.name),
    signingTeam: c.team ?? null,
    signedAt: c.signedAt ?? null,
    contractType: c.contractType ?? null,
    termYears: int(c.termYears),
    startSeason: seasonId(c.startSeason),
    endSeason: seasonId(c.expiresAfter),
    yearsLeft: int(c.yearsLeft),
    capHit: int(c.capHit),
    capHitBasis: capHitBasis(c.capHitSource),
    capHitTier: tier(c.capHitTier),
    aav: int(c.aav),
    totalValue: int(c.totalValue),
    oneWay: typeof c.oneWay === 'boolean' ? c.oneWay : null,
    expiryType: c.expiryType ?? null,
    expiryTypeDerived: Boolean(c.expiryTypeDerived),
    current: Boolean(c.isCurrent),
    boughtOut: Boolean(c.boughtOut),
    endSeasonSigned: seasonId(c.endSeasonSigned),
    tier: tier(c.tier),
    official: Boolean(c.official),
    sources: int(c.sources),
    conflicts: list(c.conflicts),
    clauses: (c.clauses ?? []).map(shapeClause),
  };
}

function shapeSeason(s) {
  return {
    season: seasonId(s.season),
    capHit: int(s.capHit),
    aav: int(s.aav),
    baseSalary: int(s.baseSalary),
    signingBonus: int(s.signingBonus),
    performanceBonus: int(s.performanceBonus),
    totalSalary: int(s.totalSalary),
    minorsSalary: int(s.minorsSalary),
    oneWay: typeof s.oneWay === 'boolean' ? s.oneWay : null,
    clause: s.clause ?? null,
    clauseStatus: shapeClauseStatus(s.clauseStatus),
    tier: tier(s.tier),
  };
}

export function shapePlayerContracts(raw) {
  const history = (raw?.history ?? []).map(c => ({ ...shapeContract(c), seasons: (c.seasons ?? []).map(shapeSeason).filter(s => s.season != null) }));
  const current = raw?.current ? { ...shapeContract(raw.current), clauseStatus: shapeClauseStatus(raw.current.clauseStatus) } : null;
  const named = raw?.current ?? raw?.history?.[0];
  return {
    player: player(raw?.playerId, named?.name),
    season: seasonId(raw?.season),
    current,
    history,
  };
}

const shapeCapLimits = l => (l ? { ceiling: int(l.ceiling), floor: int(l.floor), minSalary: int(l.minSalary) } : null);
const shapeExpiring = e => (e ? { ufa: int(e.ufa) ?? 0, rfa: int(e.rfa) ?? 0, unknown: int(e.unknown) ?? 0 } : null);

function shapeLtir(l) {
  if (!l) return null;
  return {
    players: (l.players ?? []).map(p => ({
      player: player(p.playerId, p.name),
      capHit: int(p.capHit),
      since: p.since ?? null,
      firstSeen: p.firstSeen ?? null,
      onRoster: typeof p.onRoster === 'boolean' ? p.onRoster : null,
      statedRelief: int(p.statedRelief),
      statedAt: p.statedAt ?? null,
      conflicts: list(p.conflicts),
    })),
    capHitTotal: int(l.capHitTotal),
    statedRelief: int(l.statedRelief),
    statedAt: l.statedAt ?? null,
    offRosterCapHit: int(l.offRosterCapHit),
  };
}

const deadCapTotal = d => (d == null ? null : typeof d === 'object' ? int(d.total) : int(d));

export function shapeTeamContracts(raw, team) {
  const s = raw?.summary;
  return {
    team: teamRef(team),
    season: seasonId(raw?.season),
    rosterKnown: Boolean(raw?.rosterKnown),
    contracts: (raw?.rows ?? []).map(r => ({
      ...shapeContract(r),
      position: r.position ?? null,
      onRoster: Boolean(r.onRoster),
      alternates: int(r.alternates) ?? 0,
    })),
    missing: (raw?.missing ?? []).map(m => ({ player: player(m.playerId, m.name), position: m.position ?? null, gap: m.gap ?? 'no_contract', status: m.status ?? null })),
    deadCap: raw?.deadCapKnown === false ? null : (raw?.deadCap ?? []).filter(d => d.kind === 'buyout' || d.kind === 'retained').map(d => ({
      kind: d.kind,
      player: player(d.playerId, d.playerName),
      counterparty: d.counterparty ?? null,
      capHit: int(d.capHit),
      pct: num(d.pct),
      eventDate: d.eventDate ?? null,
      contractKey: d.contractKey ?? null,
      tier: tier(d.tier),
    })),
    summary: s ? {
      capLimits: shapeCapLimits(s.capLimits),
      rosterCapHit: int(s.rosterCapHit),
      rosterCount: int(s.rosterCount),
      rosterWithFigure: int(s.rosterWithFigure),
      offRosterCount: int(s.offRosterCount),
      expiring: shapeExpiring(s.expiring),
      deadCapTotal: deadCapTotal(s.deadCap),
      capSpaceEstimate: int(s.capSpaceEstimate),
      estimateNotes: list(s.estimateNotes),
      ltir: shapeLtir(s.ltir),
    } : null,
  };
}

export function shapeLeagueContracts(raw) {
  return {
    season: seasonId(raw?.season),
    teamsKnown: int(raw?.teamsKnown) ?? 0,
    capLimits: shapeCapLimits(raw?.capLimits),
    players: (raw?.players ?? []).map(p => {
      const c = shapeContract(p);
      delete c.clauses;
      return { ...c, currentTeam: p.currentTeam ?? null, position: p.position ?? null, onRoster: Boolean(p.onRoster) };
    }),
  };
}

export function shapeTeamCapSummaries(raw, basis) {
  return {
    season: seasonId(raw?.season),
    basis,
    capLimits: shapeCapLimits(raw?.capLimits),
    teamsKnown: int(raw?.teamsKnown),
    teams: (raw?.teams ?? []).map(t => ({
      team: t.team,
      contracts: int(t.contracts),
      withFigure: int(t.withFigure),
      capHitTotal: int(t.capHitTotal),
      rosterCount: int(t.rosterCount),
      rosterWithFigure: int(t.rosterWithFigure),
      rosterCapHit: int(t.rosterCapHit),
      offRosterCount: int(t.offRosterCount),
      expiring: shapeExpiring(t.expiring),
      deadCapTotal: deadCapTotal(t.deadCap),
      capSpaceEstimate: int(t.capSpaceEstimate),
      ltir: shapeLtir(t.ltir),
    })),
    estimateNotes: list(raw?.estimateNotes),
  };
}

// ── Registration ─────────────────────────────────────────────────────

const json = (name, schema, description) => ({ 200: { description, content: { 'application/json': { schema: envelope(name, schema) } } }, ...problemResponses });

export function registerContracts(app) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/players/{playerId}/contracts', operationId: 'getNhlPlayerContracts', tags: ['Contracts'],
    summary: 'A player\'s contracts',
    description: `Every contract the dataset has for the player, newest first, with season-by-season salary and clauses; \`current\` is the one covering \`season\`. ${CC0_NOTE}`,
    request: { params: z.object({ playerId: NumericId('playerId', '8478427') }), query: contractsSeasonQuery },
    responses: json('PlayerContractsResponse', PlayerContracts, 'Player contracts'),
  }), async c => {
    const { playerId } = c.req.valid('param');
    const raw = await poller(c.env, withQuery(`/contracts/player/${playerId}`, seasonParam(c.req.valid('query'))), { allowUnavailable: true });
    if (raw?.unavailable && !(raw.history ?? []).length) return problem(c, 404, 'Not Found', 'no contracts in the dataset for this player');
    const data = shapePlayerContracts(raw);
    return send(c, data, contractsMeta(raw?.asOf), 3600);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/teams/{team}/contracts', operationId: 'getNhlTeamContracts', tags: ['Contracts'],
    summary: 'A team\'s contracts for a season',
    description: `One contract per roster player plus the team's deals for players now elsewhere, roster players with no public figure, dead cap, LTIR, and a cap-space estimate. ${CC0_NOTE}`,
    request: { params: NhlTeamParam, query: contractsSeasonQuery },
    responses: json('TeamContractsResponse', TeamContracts, 'Team contracts'),
  }), async c => {
    const code = c.req.valid('param').team.toUpperCase();
    const index = await teamIndex(c.env, 'nhl');
    const team = index.find(code);
    if (!team) return problem(c, 404, 'Not Found', `no current NHL team ${code} (see /v1/nhl/teams)`);
    const raw = await poller(c.env, withQuery(`/contracts?team=${code}`, seasonParam(c.req.valid('query'))));
    const data = shapeTeamContracts(raw, team);
    return send(c, data, contractsMeta(raw?.asOf), data.rosterKnown ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/contracts', operationId: 'getNhlContracts', tags: ['Contracts'],
    summary: 'Every NHL player\'s contract for a season',
    description: `One row per player on a roster today or under contract for the season: cap hit, term, expiry, source tier; cap hit descending. No clauses (see the player route). ${CC0_NOTE}`,
    request: { query: contractsSeasonQuery },
    responses: json('LeagueContractsResponse', LeagueContracts, 'League contracts'),
  }), async c => {
    const raw = await poller(c.env, withQuery('/contracts/players', seasonParam(c.req.valid('query'))));
    const data = shapeLeagueContracts(raw);
    return send(c, data, contractsMeta(raw?.asOf), data.teamsKnown >= 32 ? 3600 : 300);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/nhl/contracts/teams', operationId: 'getNhlTeamCapSummaries', tags: ['Contracts'],
    summary: 'Every team\'s cap totals for a season',
    description: `\`basis=roster\` (default): each roster's cap hit, dead cap, LTIR and a cap-space estimate. \`basis=signing_team\`: the contracts each team signed that cover the season. ${CC0_NOTE}`,
    request: {
      query: contractsSeasonQuery.extend({
        basis: z.enum(['roster', 'signing_team']).optional().openapi({ param: { name: 'basis', in: 'query' }, description: 'Defaults to roster.', example: 'roster' }),
      }),
    },
    responses: json('TeamCapSummariesResponse', TeamCapSummaries, 'Team cap totals'),
  }), async c => {
    const q = c.req.valid('query');
    const basis = q.basis ?? 'roster';
    const raw = await poller(c.env, withQuery('/contracts/summary', seasonParam(q), basis === 'roster' ? 'basis=roster' : ''));
    const data = shapeTeamCapSummaries(raw, basis);
    const complete = basis === 'signing_team' || (data.teamsKnown ?? 0) >= 32;
    return send(c, data, contractsMeta(raw?.asOf), complete ? 3600 : 300);
  });
}
