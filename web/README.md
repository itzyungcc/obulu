# OBULU — Football Comparison & Prediction (frontend)

Informational football comparison & statistical prediction web app.
**Not a betting platform** — no betting, staking, gambling features, or bookmaker promotions anywhere.

## Quickstart

```bash
cd web
npm install
npm run dev      # serves on :5173, proxies /api -> http://localhost:3001
```

## Env vars

| Var            | Default | Purpose                                      |
| -------------- | ------- | -------------------------------------------- |
| `VITE_API_URL` | `""`    | API base URL. Empty = same-origin `/api`.    |

Copy `.env.example` to `.env` to set values. Never put API keys in frontend code.

## Build

```bash
npm run build    # outputs dist/
npm run preview  # serves the production build locally
```

## Docker

```bash
docker build -t obulu-web .
docker run -p 8080:80 obulu-web
```

## Capacitor (native shell later)

`capacitor.config.ts` is present (`appId com.obulu.app`, `webDir dist`).
The app uses `HashRouter` so the same bundle works over `file://`.
Do **not** run `npx cap add android` here — the parent handles native setup.

## API contract

The app calls `GET /api/health`, `/api/leagues`, `/api/fixtures/upcoming`,
`/api/teams/search`, `/api/matches/:id`, `/api/matches/:id/analysis`,
`/api/matches/:id/prediction`. Any response with `sampleData: true` renders an
unmissable striped "SAMPLE DATA" banner. Error code
`DATA_PROVIDER_NOT_CONFIGURED` renders a setup hint instead of a generic error.
