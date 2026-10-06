# OBULU — Internal API (overview)

The full reference lives in [`server/API.md`](../server/API.md) — that file
is the source of truth. This is a summary.

Base path: `/api`. All responses are JSON. Error shape:

```json
{ "error": "DATA_PROVIDER_NOT_CONFIGURED", "message": "human-readable hint" }
```

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok, version, dataMode: "live"\|"sample"\|"unconfigured", providers, timestamp }` |
| GET | `/api/leagues` | `{ leagues: [{ id, name, country, logo?, season }], sampleData }` |
| GET | `/api/fixtures/upcoming?league=&date=YYYY-MM-DD&team=` | `{ fixtures: [...], sampleData }` |
| GET | `/api/teams/search?q=` | `{ teams: [...] }` |
| GET | `/api/matches/:id` | `{ match, sampleData }` — 404 `NOT_FOUND` |
| GET | `/api/matches/:id/analysis` | form, home/away splits, goals, clean sheets, h2h, standings, injuries |
| GET | `/api/matches/:id/prediction` | `prediction: { homeWin, draw, awayWin, predictedOutcome, confidence: {score,label}, factors[], disclaimer }`, `model: { method, blendedWithOdds, dataCompleteness }` |

Behaviour without provider keys (and `SAMPLE_DATA` not `true`): every
data endpoint returns **503** `{ error: "DATA_PROVIDER_NOT_CONFIGURED",
message }`. The frontend turns this into a setup hint, never fake data.

With `SAMPLE_DATA=true`, responses carry `sampleData: true` and the UI
badges them **SAMPLE DATA**. Keep this off in production.
