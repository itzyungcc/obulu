# OBULU — Deployment guide

Nothing here has been deployed yet. These are the exact steps to take
OBULU to production.

## 0. Prerequisites

- A server/VM or container host (any provider), or:
  - Backend: Render, Railway, Fly.io, or a VPS with Docker.
  - Frontend: Netlify, Vercel, Cloudflare Pages, or the included nginx
    Docker image.
  - Database: SQLite file is fine to start (single backend instance).
    For multi-instance or heavy traffic, migrate to managed Postgres
    (schema is standard SQL — see `server/db/schema.sql`).
- Provider API keys (see step 1).

## 1. Get API keys

1. **API-Football (primary):** sign up at https://www.api-sports.io
   (free tier available) → dashboard → copy the API key →
   set `API_FOOTBALL_KEY`.
2. **football-data.org (fallback, optional):** https://www.football-data.org
   → register → copy token → set `FOOTBALL_DATA_ORG_KEY`.
3. **The Odds API (optional):** https://the-odds-api.com → copy key →
   set `ODDS_API_KEY`. Used only as a statistical input to the model
   (blended, default 25%); never shown as betting content.

Keys go **only** in the backend environment (`server/.env`, Docker
secrets, or your host's secret manager). Never in `web/` code.

## 2. Deploy the backend

### Option A — Docker Compose (recommended for VPS)

```bash
cd obulu
cp server/.env.example server/.env   # then edit: add keys, keep SAMPLE_DATA=false
docker compose up -d --build
# API on http://<host>:3001 ; data persisted in the obulu-data volume
```

### Option B — Dockerfile directly

```bash
cd obulu/server
docker build -t obulu-api .
docker run -d --name obulu-api -p 3001:3001 \
  -e API_FOOTBALL_KEY=... -e FOOTBALL_DATA_ORG_KEY=... \
  -v obulu-data:/data obulu-api
```

### Option C — Render/Railway/Fly.io

- Create a new **Web Service** from `obulu/server` (Dockerfile detected
  automatically).
- Set environment variables: `API_FOOTBALL_KEY`,
  `FOOTBALL_DATA_ORG_KEY` (optional), `ODDS_API_KEY` (optional),
  `DB_PATH=/data/obulu.db`, `SAMPLE_DATA=false`.
- Attach a persistent disk mounted at `/data` (SQLite file must survive
  restarts).

Health check: `GET https://<api-host>/api/health` → expect
`{ ok: true, dataMode: "live", ... }`.

## 3. Deploy the web app

The frontend is a static build (`web/dist`).

### Option A — nginx Docker (pairs with compose)

The compose file builds `web/Dockerfile` (node build → nginx serve).
Set the API URL at build time:

```bash
cd obulu
docker compose build --build-arg VITE_API_URL=https://<api-host> web
docker compose up -d
```

### Option B — Netlify / Vercel / Cloudflare Pages

- Build command: `npm run build` (working dir `web/`)
- Publish directory: `web/dist`
- Environment variable: `VITE_API_URL=https://<api-host>` (or leave empty
  if served same-origin behind a reverse proxy that routes `/api/*` to
  the backend).

### Same-origin reverse proxy (optional, avoids CORS setup)

If web and API share a domain, proxy `/api/*` to the backend (nginx
example):

```nginx
location /api/ { proxy_pass http://localhost:3001; }
```

The backend enables CORS by default; lock `CORS_ORIGIN` to your web
origin in production if you serve them on different domains.

## 4. Environment variables (backend, production)

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | default 3001 |
| `API_FOOTBALL_KEY` | one of the two | primary provider |
| `FOOTBALL_DATA_ORG_KEY` | one of the two | fallback provider |
| `ODDS_API_KEY` | no | optional model input |
| `SAMPLE_DATA` | — | **must be `false`/unset in production** |
| `DB_PATH` | no | default `./data/obulu.db`; use `/data/obulu.db` with a volume |
| `MODEL_ODDS_WEIGHT` | no | default `0.75` (model vs odds blend) |
| `CORS_ORIGIN` | recommended | your web origin, e.g. `https://obulu.example.com` |

## 5. Post-deploy checks

1. `GET /api/health` → `dataMode: "live"`.
2. Open the web app → Home shows real upcoming fixtures (no SAMPLE badge).
3. Open a match → prediction card shows HOME/DRAW/AWAY summing to 100%,
   confidence, factors, and the disclaimer.
4. Check backend logs for provider rate-limit warnings; adjust TTLs in
   `server/src/cache.js` if needed.

## 6. Ongoing

- Back up the SQLite file (`/data/obulu.db`) regularly.
- The `predictions` table logs every prediction — use it to evaluate and
  retrain the model (see `server/src/model/MODEL.md`).
- Rotate API keys in your secret manager; no code changes needed.
