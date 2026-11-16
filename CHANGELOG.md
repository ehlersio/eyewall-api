# Changelog

`/v1` changes are additive only. Breaking changes go to a new version.

## 1.3.0 — 2026-11-16

Added (NHL, CC0 from the nhl-contracts dataset):

- `GET /v1/nhl/players/{playerId}/contracts`
- `GET /v1/nhl/teams/{team}/contracts`
- `GET /v1/nhl/contracts`
- `GET /v1/nhl/contracts/teams`
- Bulk files: `nhl-contracts`, `nhl-contract-team-totals` and `nhl-contract-team-totals-signing-team` (JSON + CSV, CC0)

## 1.2.1 — 2026-11-16

- `GET /llms.txt`: a plain-text route index for AI agents.
- Shorter descriptions on `getNhlTeamNeeds` and `getNhlTradeFit` (GPT Actions allow 300 characters).

## Bulk files — 2026-11-16

- Nightly JSON + CSV of every league-wide table on the `data` release, with `manifest.json` (licence per file).

## 1.2.0 — 2026-11-16

Added (NHL):

- `GET /v1/nhl/rapm` (CC BY 4.0)
- CC BY-NC 4.0, MoneyPuck inputs: `GET /v1/nhl/war`, `/v1/nhl/power-rankings`, `/v1/nhl/teams/{team}/power-ranking`, `/v1/nhl/teams/{team}/needs`, `/v1/nhl/players/{playerId}/trade-fit`, `/v1/nhl/games/{gameId}/recap`, `/v1/nhl/games/{gameId}/preview`, `/v1/nhl/players/{playerId}/scouting`

## 1.1.0 — 2026-11-16

Added (PWHL, AHL, ECHL unless noted):

- `GET /v1/{league}/power-rankings`, `/v1/{league}/teams/{teamId}/power-ranking` (with EyeWall AI's paragraph, `locale=en|fr`)
- `GET /v1/{league}/players/{playerId}/percentiles`, `/v1/{league}/goalies/{playerId}/percentiles`
- `GET /v1/nhl/teams/{team}/projected-lines`
- `GET /v1/nhl/games/{gameId}/goalie-starts`

## 1.0.0 — 2026-11-16

First release.

- `GET /v1/leagues`, `/v1/{league}/seasons`, `/v1/{league}/teams`
- `GET /v1/{league}/elo`
- `GET /v1/{league}/games`, `/v1/{league}/games/{gameId}/win-probability`
- `GET /v1/{league}/playoff-odds`
- `GET /v1/nhl/scorecard`
- `GET /openapi.json` (OpenAPI 3.1), `GET /docs`
