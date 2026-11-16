# Changelog

`/v1` changes are additive only. Breaking changes go to a new version.

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
