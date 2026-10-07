# OBULU — Architecture

## Overview

OBULU is a two-tier web application plus an optional Android shell:

```
┌─────────────┐      HTTPS/JSON       ┌──────────────────┐      HTTPS      ┌──────────────────┐
│  web/       │ ───────────────────▶ │  server/         │ ─────────────▶ │ Football data    │
│ Vite+React  │   /api/*             │  Express +       │   adapters     │ providers        │
│ (static)    │ ◀─────────────────── │  node:sqlite     │ ◀───────────── │ (keys server-side│
└─────────────┘                      └──────────────────┘                │  only)           │
       │                                        │                       └──────────────────┘
       │ Capacitor wrapper                      │ SQLite file: teams, leagues,
       ▼                                        │ fixtures, results, cache,
┌─────────────┐                                 │ predictions
│ android/    │                                 └──────────────────┘
│ (WebView)   │
└─────────────┘
```

The Android app is a Capacitor WebView shell around the same `web/dist`
build, talking to the same backend. There is no separate native codebase.

## Backend (`server/`)

- **Runtime:** Node.js 24, Express, plain JavaScript (no build step).
- **Database:** SQLite via the built-in `node:sqlite` module — zero native
  dependencies. Schema: `db/schema.sql` (leagues, teams, fixtures, results,
  team_stats_cache, predictions, cache_meta). SQL is kept standard so a
  future move to Postgres is a straightforward migration (swap the driver,
  keep the queries).
- **Providers (`src/providers/`):** adapter pattern. Every provider
  normalizes to the same internal shapes (Team / Fixture / TeamStats).
  Selection order: `SAMPLE_DATA=true` → sample provider; else
  `API_FOOTBALL_KEY` → API-Football; else `FOOTBALL_DATA_ORG_KEY` →
  football-data.org; else **unconfigured** → honest `503
  DATA_PROVIDER_NOT_CONFIGURED`, never fake data.
  - API-Football (api-sports.io) is primary: fixtures, team statistics,
    head-to-head, standings, injuries.
  - football-data.org is the fallback: matches, teams, standings
    (injuries not offered — those fields degrade gracefully to empty).
  - The Odds API is **optional and input-only**: its h2h odds are converted
    to overround-removed implied probabilities and blended into the model
    (default 75% model / 25% odds). Odds are never displayed as tips and no
    betting UI exists anywhere.
- **Cache (`src/cache.js`):** SQLite-backed, per-endpoint-type TTLs
  (fixtures 15 min, team stats 6 h, standings 6 h, head-to-head 24 h,
  odds 30 min, leagues 24 h) to respect provider rate limits. Stale cache
  is served with a warning only where explicitly designed; otherwise a
  provider failure returns `502 PROVIDER_ERROR`.
- **Model (`src/model/poisson.js`):** five separated stages —
  1. ingest (raw provider stats), 2. feature engineering (recency-weighted
  attack/defence strengths with shrinkage to league averages),
  3. prediction (independent Poisson goal distributions + Dixon–Coles
  low-score correction → P(home)/P(draw)/P(away)),
  4. calibration (optional odds blend, renormalization to 100%),
  5. user-facing output (percentages, predicted outcome, confidence from
  distribution entropy × data completeness, plain-language factors,
  mandatory disclaimer). Full maths: `server/src/model/MODEL.md`.
- **Routes (`src/routes/api.js`):** the `/api/*` endpoints documented in
  `server/API.md`. Every prediction is persisted to the `predictions`
  table for audit/retraining.
- **Prediction calendar (`src/calendar/`):** every prediction (from
  `GET /api/matches/:id/prediction` and the automation's `analyzeFixture`)
  records an immutable snapshot in `prediction_snapshots` — first snapshot
  wins, never overwritten. A 10-minute in-process resolver marks finished
  fixtures `CORRECT`/`INCORRECT` or `VOID` (cancelled/postponed/abandoned).
  Read API: `GET /api/predictions/calendar|history|:id|stats`
  (`server/API.md`).
- **Live engine (`src/live/engine.js`):** in-process poller (default 90s,
  unref'd) tracking in-play fixtures; recomputes 1X2 from the pre-match
  baseline + remaining expected goals (time-decayed, red-card adjusted,
  optional shot-momentum), persists `live_predictions` only on material
  change, and records the final live verdict (`live_correct`) on
  `prediction_snapshots` when a match finishes. Read API:
  `GET /api/live`, `/api/live/:fixtureId`, `/api/live/:fixtureId/history`.
  Providers expose `getLiveFixtures`/`getLiveMatch`; stats missing from a
  tier stay `null`, never fabricated.

## Frontend (`web/`)

- **Stack:** Vite + React + react-router-dom (HashRouter, so the same build
  works on static hosts and inside Capacitor's `file://` WebView), custom
  CSS, no UI framework.
- **API client (`src/api.js`):** base URL from `VITE_API_URL` (default
  same-origin). Typed `ApiError`s; special-cases
  `DATA_PROVIDER_NOT_CONFIGURED` with a setup hint; surfaces
  `sampleData` flags so pages render the SAMPLE DATA badge.
- **Pages:** Home (dashboard), Upcoming Matches, Search, Leagues,
  Match Analysis (`/match/:id`), About OBULU.
- **Design:** red/white/green identity, rose line-art SVG background
  overlay (decorative, `aria-hidden`, non-interactive, low opacity),
  rounded cards, mobile-first responsive, semantic HTML, focus states,
  contrast-safe text.

## Data flow (prediction request)

1. User opens `/match/:id` → frontend calls
   `GET /api/matches/:id/analysis` and `/api/matches/:id/prediction`.
2. Backend checks cache → provider (with fallback) → normalizes →
   stores raw stats.
3. Model pipeline runs (ingest → features → Poisson → calibration →
   output), result cached + persisted.
4. Frontend renders the prediction card (HOME/DRAW/AWAY %, predicted
   outcome highlighted, confidence, factors, disclaimer) and the
   comparison sections.

## Non-goals (by design)

- No user accounts, login, payments, or personal data collection.
- No automatic wagering of any kind — see the 2026-10-07 note below.
- No background scraping — all data comes from the configured providers.

### 2026-10-07: user authorized SportyBet share-booking creation

The user explicitly changed OBULU's informational-only standing rule: the
automation agent may now create SportyBet **share bookings** (booking codes)
for qualified alerts. Scope is deliberately narrow:

- A booking code is a **slip reservation only** — no money moves, no bet is
  placed, and nothing is ever staked automatically.
- The user opens the code in SportyBet and reviews/stakes manually.
- Nothing in the codebase may describe a share code as a placed bet or
  instruct the user to bet; the Telegram block presents it as a reservation.
- Controlled by `SPORTYBET_BOOKING_ENABLED` (default `true`); set it to
  `false` to restore the previous no-booking behavior.
- The unofficial booking endpoint can be rate-limited or blocked by
  SportyBet at any time — every failure is a clean error and never produces
  a fabricated code.
