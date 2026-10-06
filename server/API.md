# OBULU API Reference — v1.0.0

Base URL: `http://localhost:3001` (default `PORT`). All endpoints are
`GET` and return JSON. **Informational only — no betting, staking, or
gambling content is served or accepted.**

## Data modes

`GET /api/health` reports `dataMode`:

- `sample` — `SAMPLE_DATA=true`; all payloads are clearly-marked dev data and
  responses include `sampleData: true`.
- `live` — a real provider key is configured.
- `unconfigured` — no provider and not sample mode; data endpoints return
  `503 DATA_PROVIDER_NOT_CONFIGURED`. Fake data is never returned with 200.

## Endpoints

### GET /api/health
Service status and provider configuration.
```json
{
  "ok": true,
  "version": "1.0.0",
  "dataMode": "live",
  "providers": { "primary": "api-football", "odds": false },
  "timestamp": "2026-10-01T07:00:00.000Z"
}
```
`providers.primary` is one of `api-football | football-data.org | sample | none`.
`providers.odds` indicates whether `ODDS_API_KEY` is set (blend input only).

### GET /api/leagues
```json
{ "leagues": [{ "id": "string", "name": "string", "country": "string", "logo": "string?", "season": "string" }], "sampleData": false }
```
Cached 24h.

### GET /api/fixtures/upcoming
Query params (all optional): `league` (league id), `date` (`YYYY-MM-DD`),
`team` (team id). Without `date`, returns the next ~14 days.
```json
{ "fixtures": [ { "id": "string",
    "league": { "id": "string", "name": "string", "country": "string?" },
    "home": { "id": "string", "name": "string", "country": "string?", "logo": "string?" },
    "away": { "id": "string", "name": "string", "country": "string?", "logo": "string?" },
    "kickoff": "2026-10-02T17:30:00.000Z",
    "status": "NS",
    "venue": "string?" } ],
  "sampleData": false }
```
`status` is one of `NS | LIVE | FT`. Cached 15min.
400 `BAD_REQUEST` if `date` is malformed.

### GET /api/teams/search?q=...
`q` is required (400 `BAD_REQUEST` if missing).
```json
{ "teams": [{ "id": "string", "name": "string", "country": "string?", "logo": "string?" }] }
```

### GET /api/matches/:id
```json
{ "match": { "id": "...", "league": {...}, "home": {...}, "away": {...},
    "kickoff": "2026-10-02T17:30:00.000Z", "status": "NS",
    "venue": "string?", "referee": "string?" },
  "sampleData": false }
```
404 `{ "error": "NOT_FOUND", "message": "..." }` when unknown.

### GET /api/matches/:id/analysis
Form, head-to-head, standings context, and injuries for a fixture.
```json
{
  "match": { "...fixture..." },
  "recentForm": {
    "home": { "results": ["W","D","L","W","W"], "played": 5, "goalsFor": 9,
              "goalsAgainst": 4, "cleanSheets": 2, "avgFor": 1.8, "avgAgainst": 0.8 },
    "away": { "..." }
  },
  "homeAway": {
    "home": { "played": 5, "wins": 4, "draws": 1, "losses": 0, "goalsFor": 12, "goalsAgainst": 3 },
    "away": { "..." }
  },
  "headToHead": {
    "played": 5, "homeWins": 2, "draws": 2, "awayWins": 1,
    "lastMeetings": [{ "date": "2026-09-28", "home": "Arsenal", "away": "Chelsea", "scoreH": 2, "scoreA": 0 }]
  },
  "standings": {
    "home": { "position": 1, "played": 12, "points": 27 },
    "away": { "position": 4, "played": 12, "points": 21 }
  },
  "injuries": { "home": [{ "player": "string", "reason": "string" }], "away": [] },
  "sampleData": false
}
```
`results` covers the last 5 (most recent first). `injuries` arrays are empty
when the provider has no injury data. Standings fields are `null` when unknown.

### GET /api/matches/:id/prediction
Statistical match prediction. Percentages always sum to exactly 100.0.
```json
{
  "match": { "id": "...", "home": { "id": "...", "name": "..." },
             "away": { "id": "...", "name": "..." },
             "league": { "id": "...", "name": "..." }, "kickoff": "..." },
  "prediction": {
    "homeWin": 52.4, "draw": 26.1, "awayWin": 21.5,
    "predictedOutcome": "HOME",
    "confidence": { "score": 48, "label": "Moderate" },
    "factors": ["The home side scores well above the league average in home matches (attack rating 1.62).", "..."],
    "disclaimer": "Predictions are statistical estimates based on available data and are not guarantees of match results."
  },
  "model": { "method": "poisson-dixon-coles", "blendedWithOdds": false, "dataCompleteness": 0.85 },
  "sampleData": false
}
```
`confidence.label` is one of `Low | Moderate | High | Very high`.
`predictedOutcome` is one of `HOME | DRAW | AWAY`. Each prediction is persisted
to the `predictions` table for audit and future calibration.

## Error codes

| Status | `error` | Meaning |
| ------ | ------- | ------- |
| 400 | `BAD_REQUEST` | Invalid/missing query parameter |
| 404 | `NOT_FOUND` | Unknown match id or API endpoint |
| 502 | `PROVIDER_ERROR` | Upstream data provider request failed |
| 503 | `DATA_PROVIDER_NOT_CONFIGURED` | No provider key and `SAMPLE_DATA` is not `true` |

Error body shape: `{ "error": "CODE", "message": "human-readable detail" }`.
The 503 message is:
"No football data provider API key is configured. Set API_FOOTBALL_KEY or
FOOTBALL_DATA_ORG_KEY (see .env.example), or enable SAMPLE_DATA=true for UI
development."

## Caching

SQLite-backed (`cache_meta` table). TTLs: fixtures 15min, team stats 6h,
standings 6h, head-to-head 24h, odds 30min, leagues 24h.

## Sample mode

Set `SAMPLE_DATA=true`. Leagues are prefixed `SAMPLE:`, countries read
`Sampleland`, and every response includes `sampleData: true`.
