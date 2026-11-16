# EyeWall API

A public, versioned API for the hockey models built by [EyeWall Analytics](https://eyewallanalytics.com): Elo ratings, pre-game win probabilities, playoff odds, power rankings, player percentiles, projected lines, starting-goalie probabilities and a scorecard of how the models have done, for the **NHL, PWHL, AHL and ECHL**.

- **Base URL:** `https://api.eyewallanalytics.com`
- **Docs:** [api.eyewallanalytics.com/docs](https://api.eyewallanalytics.com/docs)
- **OpenAPI 3.1:** [api.eyewallanalytics.com/openapi.json](https://api.eyewallanalytics.com/openapi.json) (also [`openapi.json`](openapi.json) in this repo)

No key needed. 60 requests a minute per IP.

```bash
curl https://api.eyewallanalytics.com/v1/nhl/playoff-odds
```

## Routes (v1)

| Route | What it returns |
|---|---|
| `GET /v1/leagues` | The four leagues and where their ids come from |
| `GET /v1/{league}/seasons` | Current season, the next PWHL season, and seasons with data |
| `GET /v1/{league}/teams` | Current team ids, codes and names, for joining to league feeds |
| `GET /v1/{league}/elo` | Elo ratings, home advantage and the win-probability formula |
| `GET /v1/{league}/games?date=YYYY-MM-DD` | Pre-game win probabilities for a day's games (default: today, America/New_York) |
| `GET /v1/{league}/games/{gameId}/win-probability` | One game's pre-game win probability |
| `GET /v1/{league}/playoff-odds[?season=]` | Every team's playoff and division probability and projected points, from the nightly simulation |
| `GET /v1/nhl/scorecard` | Live and backtest grades for the game-winner, starting-goalie and playoff-odds models |
| `GET /v1/{pwhl,ahl,echl}/power-rankings[?season=]` | Nightly power rankings: rank, previous rank, score and component ranks |
| `GET /v1/{pwhl,ahl,echl}/teams/{teamId}/power-ranking[?locale=en\|fr]` | One team's ranking, its recent history, and EyeWall AI's paragraph in English or French |
| `GET /v1/{pwhl,ahl,echl}/players/{playerId}/percentiles[?season=]` | Skater percentiles plus EyeWall xG and goals above expected |
| `GET /v1/{pwhl,ahl,echl}/goalies/{playerId}/percentiles[?season=]` | Goalie percentiles, goals saved above expected, save percentage by danger zone |
| `GET /v1/nhl/teams/{team}/projected-lines` | Projected forward lines and defense pairs for the team's next game |
| `GET /v1/nhl/games/{gameId}/goalie-starts` | Each goalie's probability of starting the game |
| `GET /v1/nhl/rapm[?season=]` | RAPM for every NHL skater (three-season, 5-on-5 xG impact) |
| `GET /v1/nhl/war[?season=]` ¹ | WAR for every NHL player |
| `GET /v1/nhl/power-rankings[?season=]` ¹ | NHL power rankings |
| `GET /v1/nhl/teams/{team}/power-ranking` ¹ | One team's rank, history and EyeWall AI's paragraph |
| `GET /v1/nhl/teams/{team}/needs` ¹ | The projected lineup's skater slots, rated by WAR per 82 and ranked league-wide |
| `GET /v1/nhl/players/{playerId}/trade-fit` ¹ | Every other team ranked strong / possible / long shot as a fit for the player |
| `GET /v1/nhl/games/{gameId}/recap?team=&locale=` ¹ | EyeWall AI's recap for one side |
| `GET /v1/nhl/games/{gameId}/preview[?locale=]` ¹ | EyeWall AI's game preview |
| `GET /v1/nhl/players/{playerId}/scouting[?season=&locale=]` ¹ | EyeWall AI's scouting report |

¹ Built on MoneyPuck inputs: CC BY-NC 4.0, non-commercial only (see Licence).

`{league}` is `nhl`, `pwhl`, `ahl` or `echl`. NHL ids are the NHL's; PWHL, AHL and ECHL ids are HockeyTech's.

Every success is `{ data, meta }`. `meta` carries the league, the model the data comes from, when EyeWall produced it, the licence and the credit line. Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`. Missing values are `null`, never a placeholder.

Probabilities are model estimates, not betting odds.

## What's not here

Box scores, play-by-play, shot locations, rosters, standings and schedules belong to the leagues (NHL, HockeyTech). This API serves only what EyeWall computes, plus the ids and team codes you need to join it to those feeds. NHL contracts are a separate open dataset: [ehlersio/nhl-contracts](https://github.com/ehlersio/nhl-contracts) (CC0).

## Licence

- **Data:** [CC BY 4.0](LICENSE-DATA). Credit **"EyeWall Analytics (eyewallanalytics.com)"** wherever the data appears. Each response's `meta.license` and `meta.attribution` say exactly what applies to it.
- **Code:** [MIT](LICENSE).

- **NHL models built on [MoneyPuck](https://moneypuck.com) inputs** (routes marked ¹: WAR, NHL power rankings, team needs, trade fit, EyeWall AI's NHL text): [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), non-commercial use only, crediting **"EyeWall Analytics (eyewallanalytics.com), using data from MoneyPuck.com"**. MoneyPuck's own numbers (their game xG, goals saved above expected, Game Score) are never served; goalie ratings are left out for that reason.

Injury statuses (ESPN) are never included.

## Stability

`/v1` only changes by adding things. CI runs [oasdiff](https://github.com/oasdiff/oasdiff) on every PR and fails one that would break an existing caller. A breaking change gets `/v2`, and `/v1` keeps working, with `Deprecation` and `Sunset` headers, for at least a full season. See [CHANGELOG.md](CHANGELOG.md).

## How it works

A Cloudflare Worker ([Hono](https://hono.dev) + [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)). Each route declares its parameters and response with Zod schemas, and the OpenAPI document is generated from them, so the spec can't drift from the code.

The data comes from [eyewall-poller](https://github.com/ehlersio/eyewall-poller), EyeWall's app backend, over a Cloudflare Service Binding. The poller keeps every model and table read; this Worker validates, reshapes into the `/v1` schemas, documents and caches (edge cache plus `Cache-Control`). Poller routes it uses: `/config/teams`, `/config/seasons*`, `/elo/ratings`, `/win-probs`, `/playoff-odds/league`, `/scorecard`, `/{league}/power-rankings`, `/{league}/{player,goalie}/percentiles`, `/projected-lines`, `/probable-starters`, `/player-analytics`, `/players-list`, `/nhl/power-rankings/league`, `/power-rankings`, `/team-needs`, `/trade-fit`, `/game-summary`, `/game-predictions`, `/player-scouting`.

```
src/
├── index.js          # Worker entry
├── app.js            # Middleware (CORS, rate limit, edge cache, errors), OpenAPI config, /docs
├── schemas.js        # Envelope, Meta, Problem, League, TeamRef
├── poller.js         # Service Binding client
├── teams.js          # Team lookup (NHL by code, HockeyTech by id)
├── respond.js        # { data, meta } and problem responses
└── routes/           # reference, elo, games, playoffOdds, scorecard, powerRankings, percentiles, lineups, nhlModels, nhlText
scripts/write-openapi.js  # Writes openapi.json (npm run spec)
test/                     # Route tests against fixture poller responses
```

## Development

```bash
npm ci
npm test              # route tests (Vitest, plain Node)
npm run lint
npm run spec          # regenerate openapi.json after changing a route; commit it
npm run spec:check    # CI: fails when openapi.json is out of date
npm run lint:spec     # Redocly lint
```

`npm run dev` runs the Worker locally; the `POLLER` binding then needs the poller running locally too (`wrangler dev` in eyewall-poller).

Deploys run from `.github/workflows/deploy.yml` on push to `main` (repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), or by hand with `npm run deploy`.

## Disclaimer

Not affiliated with or endorsed by the NHL, PWHL, AHL, ECHL or HockeyTech.
