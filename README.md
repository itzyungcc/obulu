# OBULU — Football Comparison & Prediction

**Football Comparison & Prediction** — an informational football analysis platform.

**Created by Chiakwa Peter** — chiakwapeter@gmail.com

OBULU lets users compare football (soccer) teams and get data-driven
Home / Draw / Away predictions for upcoming matches. It is an
**informational tool only** — it is not a betting platform and contains
no betting, staking, gambling, bookmaker promotions, deposits, or
withdrawals.

> Predictions are statistical estimates based on available data and are
> not guarantees of match results.

## Project layout

```
obulu/
├── server/            # Node.js + Express backend (plain JS, node:sqlite)
│   ├── src/           # app entry, config, routes, providers, cache, model
│   ├── db/schema.sql  # SQLite schema (teams, leagues, fixtures, results, cache, predictions)
│   ├── test/          # model unit tests
│   ├── API.md         # internal API reference
│   ├── Dockerfile
│   └── .env.example
├── web/               # Vite + React frontend (custom CSS, mobile-first)
│   ├── src/           # pages, components, api client, styles
│   ├── dist/          # production build (generated)
│   ├── android/       # Capacitor Android shell (generated via `npx cap add android`)
│   ├── capacitor.config.ts  # Capacitor config (appId com.obulu.app)
│   ├── Dockerfile
│   └── .env.example
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── DEPLOYMENT.md
│   └── ANDROID.md
├── docker-compose.yml
└── .env.example
```

## Quickstart (development)

Prerequisites: Node.js 20+ (24 recommended), npm.

```bash
# 1. Backend
cd server
cp .env.example .env
# Edit .env — add your API keys (see "API keys" below)
npm install
npm start            # serves API on http://localhost:3001

# 2. Frontend (new terminal)
cd web
cp .env.example .env
npm install
npm run dev          # serves app on http://localhost:5173, proxies /api to :3001
```

Open http://localhost:5173. Without provider API keys the API returns
honest `503 DATA_PROVIDER_NOT_CONFIGURED` responses and the UI shows a
setup hint. For UI development without keys:

```bash
# in server/.env
SAMPLE_DATA=true
```

Sample mode serves clearly-labelled sample fixtures; every page shows an
unmissable **SAMPLE DATA** badge. Never enable it in production.

## API keys — where they go

Keys live **only** in `server/.env` (never in frontend code):

| Variable               | Purpose                                  | Required |
|------------------------|------------------------------------------|----------|
| `API_FOOTBALL_KEY`     | API-Football (api-sports.io) — primary  | one of these |
| `FOOTBALL_DATA_ORG_KEY`| football-data.org — fallback            | one of these |
| `ODDS_API_KEY`         | The Odds API — optional model input only | no       |
| `SAMPLE_DATA`          | `true` = dev sample mode (never prod)   | no       |

See `server/.env.example` for the full list including TTLs and the
`MODEL_ODDS_WEIGHT` blend setting.

## Production deploy (summary)

1. Add API keys → `server/.env` on the host (or secret manager).
2. Deploy backend → `server/Dockerfile` (or `docker-compose.yml`).
3. Deploy web → `web/Dockerfile` (nginx static) or any static host, with
   `VITE_API_URL` pointing at the backend.
4. Build/sign the Android APK → see `docs/ANDROID.md`.
5. Install the APK on a device.

Full step-by-step: `docs/DEPLOYMENT.md`.

## What is NOT done yet (honest status)

- ❌ No API keys are configured — live data is not connected.
- ❌ Nothing has been deployed to any hosting provider.
- ❌ The Android APK has **not** been built (no signing keys, no Android SDK
      in this environment). The project is structured so it *can* be built;
      see `docs/ANDROID.md` for the exact steps.
- ❌ The prediction model has not been trained on a large historical
      dataset — it computes strengths from recent form supplied by the data
      provider at request time, with shrinkage toward league averages.
      See `server/src/model/MODEL.md` for the maths and retraining notes.

## Docs

- `docs/ARCHITECTURE.md` — system design, data flow, caching, provider adapters
- `server/API.md` — internal REST API reference
- `server/src/model/MODEL.md` — prediction model maths & improvement guide
- `docs/DEPLOYMENT.md` — hosting, database, env vars, step-by-step
- `docs/ANDROID.md` — Capacitor Android build steps
