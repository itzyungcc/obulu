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
| GET | `/api/matches/:id/prediction` | `prediction: { homeWin, draw, awayWin, predictedOutcome, confidence: {score,label}, factors[], disclaimer }`, `model: { method, blendedWithOdds, dataCompleteness }` — also records an immutable calendar snapshot |
| GET | `/api/predictions/calendar?month=YYYY-MM` | month view: `{ month, days: { "2026-10-06": { total, correct, incorrect, pending } } }` |
| GET | `/api/predictions/history?date=&status=&outcome=&league=&from=&to=&page=&limit=` | `{ items, page, limit, total }`, newest kickoff first; limit default 20, max 100 |
| GET | `/api/predictions/:id` | single snapshot — 404 `NOT_FOUND` |
| GET | `/api/predictions/stats?from=&to=&league=&outcome=` | `{ total, correct, incorrect, pending, void, accuracy, accuracyNote, byOutcome }`; `accuracy` is `null` until 10+ resolved |
| GET | `/api/live` | `{ matches: [...], count }` — live probabilities + pre-match baseline, side by side |
| GET | `/api/live/:fixtureId` | full live state — 404 `NOT_FOUND` when not tracked |
| GET | `/api/live/:fixtureId/history` | in-play snapshots, chronological, cap 100 |
| GET | `/api/sportybet/events?q=&tournament=&page=&limit=` | upcoming SportyBet football events, soonest first; `q` matches "home vs away" or either team (case-insensitive), `tournament` is exact; `{ events: [{eventId, homeTeam, awayTeam, kickoff, tournament, odds}], total, page, totalPages, cachedAt }` |
| GET | `/api/sportybet/tournaments` | distinct tournament names, sorted |
| POST | `/api/jackpot/analyze` | `{ eventIds: [...] }` (max 20): resolves SportyBet event ids to teams, fuzzy-matches provider fixtures, runs the OBULU model with the event's 1X2 odds (`oddsUsed: true`, `sportyBetEventId` echoed per result; unknown ids return `matched: false`). The `{ games: [{home, away}] }` pasted-fixtures variant still works. |

Behaviour without provider keys (and `SAMPLE_DATA` not `true`): every
data endpoint returns **503** `{ error: "DATA_PROVIDER_NOT_CONFIGURED",
message }`. The frontend turns this into a setup hint, never fake data.

With `SAMPLE_DATA=true`, responses carry `sampleData: true` and the UI
badges them **SAMPLE DATA**. Keep this off in production.

## SportyBet integration (unofficial endpoint)

The `/api/sportybet/*` routes and the `eventIds` variant of
`POST /api/jackpot/analyze` read from an **UNOFFICIAL SportyBet endpoint**
(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents`) — no API
key. SportyBet may change, rate-limit, or block it at any time; when it
fails the API returns a clean error (`502 SPORTYBET_UNAVAILABLE`, or `503
SPORTYBET_DISABLED` when `SPORTYBET_ENABLED=false`) and never fabricates
events. Responses are served from a 15-minute server-side cache.

The data is used for **informational fixture listing and odds-aware model
calibration** — 1X2 odds extracted from the event's markets feed the
Poisson/Dixon-Coles model's odds blend (`oddsUsed: true` in the jackpot
result). Share-booking code creation was added 2026-10-07 under explicit
user authorization: booking codes are slip reservations only (no wagering).
The reference repo's bet-slip and selection-engine features were deliberately
**not** ported.
