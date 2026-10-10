// OBULU API routes. All responses are JSON. Informational only — no betting,
// staking, or gambling content anywhere.
import { Router } from "express";
import config from "../config.js";
import { db } from "../db/database.js";
import { getProvider, providerKind, oddsEnabled } from "../providers/index.js";
import * as oddsApi from "../providers/oddsApi.js";
import { cacheGet, cacheSet } from "../cache.js";
import { getCached, recordPrediction, getMetrics, dedup } from "../perf.js";
import { predictMatch, DISCLAIMER, MODEL_VERSION, METHOD } from "../model/poisson.js";
import { recordPredictionSnapshot } from "../calendar/snapshots.js";
import * as tursoSync from "../db/turso-sync.js";

const router = Router();

// Admin visibility: compare prediction confidence against the admin-
// configured threshold. Returns { visible, suppressedReason } — the
// prediction data is never deleted, only flagged.
function adminVisibility(result) {
  let threshold = 0;
  let publishEnabled = true;
  try {
    const tRow = db.prepare("SELECT value FROM automation_config WHERE key = ?").get("admin:minConfidence");
    if (tRow) threshold = Number(JSON.parse(tRow.value)) || 0;
    const pRow = db.prepare("SELECT value FROM automation_config WHERE key = ?").get("admin:predictionPublishEnabled");
    if (pRow) publishEnabled = JSON.parse(pRow.value) !== false;
  } catch { /* defaults */ }
  const score = Number(result?.confidence?.score) || 0;
  if (!publishEnabled) {
    return { visible: false, suppressedReason: "Publishing is disabled by the administrator." };
  }
  if (threshold > 0 && score < threshold) {
    return {
      visible: false,
      suppressedReason: `Confidence ${Math.round(score)}% is below the ${Math.round(threshold)}% threshold.`,
    };
  }
  return { visible: true, suppressedReason: null };
}

// Admin market filter: remove markets the admin has disabled. Returns the
// filtered markets object (null if the input is null).
function filterMarkets(markets) {
  if (!markets || typeof markets !== "object") return markets;
  let enabled = null;
  try {
    const row = db.prepare("SELECT value FROM automation_config WHERE key = ?").get("admin:enabledMarkets");
    if (row) enabled = JSON.parse(row.value);
  } catch { /* all enabled */ }
  if (!Array.isArray(enabled)) return markets; // null/undefined = all enabled
  const out = {};
  for (const [k, v] of Object.entries(markets)) {
    if (enabled.includes(k)) out[k] = v;
  }
  return out;
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Reject with 503 when no data provider is configured (and not sample mode).
// We never return fake data with 200.
function requireProvider(req, res, next) {
  const provider = getProvider();
  if (!provider) {
    return res.status(503).json({
      error: "DATA_PROVIDER_NOT_CONFIGURED",
      message:
        "No football data provider API key is configured. Set API_FOOTBALL_KEY or FOOTBALL_DATA_ORG_KEY (see .env.example), or enable SAMPLE_DATA=true for UI development.",
    });
  }
  req.provider = provider;
  next();
}

const isSample = () => providerKind() === "sample";

function dataMode() {
  const kind = providerKind();
  if (kind === "sample") return "sample";
  if (kind === "none") return "unconfigured";
  return "live";
}

function badRequest(res, message) {
  return res.status(400).json({ error: "BAD_REQUEST", message });
}

function notFound(res, message) {
  return res.status(404).json({ error: "NOT_FOUND", message });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- health ---
// Render sets RENDER_GIT_COMMIT automatically on every deploy, so the running
// commit is observable from /api/health without exposing anything sensitive.
const DEPLOY_COMMIT =
  (process.env.RENDER_GIT_COMMIT || "").slice(0, 12) || null;

router.get(
  "/health",
  asyncHandler(async (req, res) => {
    const kind = providerKind();
    res.json({
      ok: true,
      version: "1.0.0",
      commit: DEPLOY_COMMIT,
      dataMode: dataMode(),
      providers: {
        primary: kind === "api-football" ? "api-football" : kind === "football-data.org" ? "football-data.org" : kind === "sample" ? "sample" : "none",
        odds: oddsEnabled(),
      },
      timestamp: new Date().toISOString(),
      tursoBackup: tursoSync.syncStatus(),
    });
  })
);

// --------------------------------------------------------------- leagues ---
// OpenFootball history status (observability for the nightly sync).
router.get(
  "/openfootball/status",
  asyncHandler(async (_req, res) => {
    const { syncStatus } = await import("../openfootball/sync.js");
    const { historyCoverage } = await import("../openfootball/history.js");
    res.json({ ...syncStatus(), teamsCovered: historyCoverage() });
  })
);

router.get(
  "/leagues",
  requireProvider,
  asyncHandler(async (req, res) => {
    const key = "leagues:all";
    const { value: leagues } = await getCached(
      key,
      "leagues",
      () => req.provider.getLeagues(),
      { staleTtlSec: 7 * 24 * 3600 }
    );
    res.json({ leagues, sampleData: isSample() });
  })
);

// ------------------------------------------------------ fixtures/upcoming ---
router.get(
  "/fixtures/upcoming",
  requireProvider,
  asyncHandler(async (req, res) => {
    const { league, date, team } = req.query;
    if (date !== undefined && !DATE_RE.test(String(date))) {
      return badRequest(res, 'Query parameter "date" must be YYYY-MM-DD.');
    }
    const key = `fixtures:upcoming:${league || "all"}:${date || "all"}:${team || "all"}`;
    // SWR: instant response from cache; background refresh when stale.
    const { value: fixtures, stale } = await getCached(
      key,
      "fixtures",
      () =>
        req.provider.getUpcomingFixtures({
          league: league || undefined,
          date: date || undefined,
          team: team || undefined,
        }),
      { staleTtlSec: 2 * 3600 }
    );
    if (stale) res.set("X-OBULU-Cache", "stale");
    res.json({ fixtures, sampleData: isSample() });
  })
);

// ---------------------------------------------------------- fixtures/all ---
// Unified fixture browser used by the frontend. On the live backend this
// returns upcoming fixtures (the provider has no historical archive);
// the offline snapshot build overrides this with its 2024/25 archive.
router.get(
  "/fixtures/all",
  requireProvider,
  asyncHandler(async (req, res) => {
    const { league, date, team } = req.query;
    if (date !== undefined && !DATE_RE.test(String(date))) {
      return badRequest(res, 'Query parameter "date" must be YYYY-MM-DD.');
    }
    const key = `fixtures:all:${league || "all"}:${date || "all"}:${team || "all"}`;
    const hasFilter = league || date || team;
    const { value: fixtures, stale } = await getCached(
      key,
      "fixtures",
      async () => {
        const list = await req.provider.getUpcomingFixtures({
          league: league || undefined,
          date: date || undefined,
          team: team || undefined,
        });
        return hasFilter ? list : list.slice(0, 60);
      },
      { staleTtlSec: 2 * 3600 }
    );
    if (stale) res.set("X-OBULU-Cache", "stale");
    res.json({ fixtures, sampleData: isSample() });
  })
);

// ---------------------------------------------------------- teams/search ---
router.get(
  "/teams/search",
  requireProvider,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return badRequest(res, 'Query parameter "q" is required.');
    const teams = await req.provider.searchTeams(q);
    res.json({ teams });
  })
);

// -------------------------------------------------------------- matches ---
router.get(
  "/matches/:id",
  requireProvider,
  asyncHandler(async (req, res) => {
    const key = `match:${req.params.id}`;
    const { value: match, stale } = await getCached(
      key,
      "fixtures",
      () => req.provider.getMatch(req.params.id),
      { staleTtlSec: 2 * 3600 }
    );
    if (!match) return notFound(res, `Match ${req.params.id} not found.`);
    if (stale) res.set("X-OBULU-Cache", "stale");
    res.json({ match, sampleData: isSample() });
  })
);

function summarizeRecentForm(recentForm) {
  const last = (recentForm || []).slice(0, 5);
  const results = [];
  let goalsFor = 0, goalsAgainst = 0, cleanSheets = 0;
  for (const m of last) {
    const f = m.home ? m.scoreH : m.scoreA;
    const a = m.home ? m.scoreA : m.scoreH;
    results.push(f > a ? "W" : f === a ? "D" : "L");
    goalsFor += f;
    goalsAgainst += a;
    if (a === 0) cleanSheets++;
  }
  const played = last.length;
  return {
    results,
    played,
    goalsFor,
    goalsAgainst,
    cleanSheets,
    avgFor: played ? Math.round((goalsFor / played) * 100) / 100 : 0,
    avgAgainst: played ? Math.round((goalsAgainst / played) * 100) / 100 : 0,
  };
}

function summarizeHomeAway(recentForm, venue /* true=home record, false=away record */) {
  // Venue W/D/L derived from the recent-form window (last 10, venue-filtered).
  const list = (recentForm || []).filter((m) => m.home === venue);
  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  for (const m of list) {
    const f = m.home ? m.scoreH : m.scoreA;
    const a = m.home ? m.scoreA : m.scoreH;
    if (f > a) wins++;
    else if (f === a) draws++;
    else losses++;
    goalsFor += f;
    goalsAgainst += a;
  }
  return { played: list.length, wins, draws, losses, goalsFor, goalsAgainst };
}

// ------------------------------------------------------- matches analysis ---
// Composed analysis payload, cached 30 min: the underlying team stats and
// standings change slowly, so rebuilding (6 API calls) on every view was
// pure waste. SWR serves the last analysis instantly while refreshing.
async function computeAnalysis(provider, matchId) {
  const match = await provider.getMatch(matchId);
  if (!match) return null;

  const settled = await Promise.allSettled([
      provider.getTeamStats(match.home.id, match.league.id, match.home.name),
      provider.getTeamStats(match.away.id, match.league.id, match.away.name),
      provider.getHeadToHead(match.home.id, match.away.id, match.home.name, match.away.name),
      provider.getStandings(match.league.id),
      provider.getInjuries(match.home.id, match.league.id),
      provider.getInjuries(match.away.id, match.league.id),
    ]);
    const val = (i, dflt) => (settled[i].status === "fulfilled" ? settled[i].value : dflt);
    const homeStats = val(0, null) || { recentForm: [] };
    const awayStats = val(1, null) || { recentForm: [] };
    const h2h = val(2, { played: 0, homeWins: 0, draws: 0, awayWins: 0, lastMeetings: [] });
    const standings = val(3, {});
    const injHome = val(4, []);
    const injAway = val(5, []);

    const st = (id) => {
      const row = standings[id];
      return row
        ? { position: row.position ?? null, played: row.played ?? null, points: row.points ?? null }
        : { position: null, played: null, points: null };
    };

    return {
      match,
      recentForm: {
        home: summarizeRecentForm(homeStats.recentForm),
        away: summarizeRecentForm(awayStats.recentForm),
      },
      homeAway: {
        home: summarizeHomeAway(homeStats.recentForm, true),
        away: summarizeHomeAway(awayStats.recentForm, false),
      },
      headToHead: h2h,
      standings: { home: st(match.home.id), away: st(match.away.id) },
      injuries: { home: injHome, away: injAway },
  };
}

router.get(
  "/matches/:id/analysis",
  requireProvider,
  asyncHandler(async (req, res) => {
    const key = `analysis:${req.params.id}`;
    const { value: payload, stale } = await getCached(
      key,
      "analysis",
      () => computeAnalysis(req.provider, req.params.id),
      { staleTtlSec: 6 * 3600 }
    );
    if (!payload) return notFound(res, `Match ${req.params.id} not found.`);
    res.set("X-OBULU-Cache", stale ? "stale" : "hit");
    res.json({ ...payload, sampleData: isSample() });
  })
);

// ------------------------------------------------------ matches prediction ---
// The full prediction payload is cached (12h): the model inputs (team form,
// league averages) change only when teams play, so recalculating on every
// page view was wasted work. Only a cache miss recomputes; the predictions audit row + immutable calendar snapshot are
// written on recompute only (previously every view wrote a duplicate row).
async function computePrediction(provider, matchId) {
  const provider2 = provider;
  const match = await provider2.getMatch(matchId);
  if (!match) return null;

  const [homeStats, awayStats] = await Promise.all([
    provider2.getTeamStats(match.home.id, match.league.id, match.home.name),
    provider2.getTeamStats(match.away.id, match.league.id, match.away.name),
  ]);

  // Best-effort auxiliaries: prediction must still work without them.
  // h2h/leagueAvgs are independent -> concurrent, not sequential.
  const [h2h, leagueAvgs] = await Promise.all([
    provider2.getHeadToHead(match.home.id, match.away.id, match.home.name, match.away.name).catch(() => null),
    provider2.getLeagueAvgs(match.league.id).catch(() => null),
  ]);
  let odds = null;
  try {
    if (typeof provider2.getOdds === "function") odds = await provider2.getOdds(match.id);
    if (!odds) odds = await oddsApi.getOdds(match);
  } catch { /* optional */ }

  const result = predictMatch(homeStats, awayStats, leagueAvgs, h2h, odds, {
    oddsWeight: config.modelOddsWeight,
  });
  recordPrediction(true);

  // Persist the prediction for audit / future calibration work (once per
  // computation, not once per page view).
  db.prepare(
    `INSERT INTO predictions
       (match_id, home_win, draw, away_win, outcome, model_version,
        blended_with_odds, data_completeness, sample, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    match.id,
    result.homeWin,
    result.draw,
    result.awayWin,
    result.predictedOutcome,
    MODEL_VERSION,
    result.blendedWithOdds ? 1 : 0,
    result.dataCompleteness,
    providerKind() === "sample" ? 1 : 0,
    new Date().toISOString()
  );

  // Immutable calendar snapshot (first prediction wins). Never breaks
  // the endpoint: recordPredictionSnapshot never throws, but stay safe.
  try {
    recordPredictionSnapshot(
      { id: match.id, home: match.home, away: match.away, league: match.league, kickoff: match.kickoff },
      {
        homeWin: result.homeWin,
        draw: result.draw,
        awayWin: result.awayWin,
        predictedOutcome: result.predictedOutcome,
        confidence: result.confidence,
        dataCompleteness: result.dataCompleteness,
        expectedGoals: result.expectedGoals,
        factors: result.factors,
        blendedWithOdds: result.blendedWithOdds,
      }
    );
  } catch { /* snapshot failure must never break predictions */ }

  return {
    match: {
      id: match.id,
      home: { id: match.home.id, name: match.home.name },
      away: { id: match.away.id, name: match.away.name },
      league: match.league,
      kickoff: match.kickoff,
    },
    prediction: {
      homeWin: result.homeWin,
      draw: result.draw,
      awayWin: result.awayWin,
      predictedOutcome: result.predictedOutcome,
      confidence: result.confidence,
      factors: result.factors,
      disclaimer: DISCLAIMER,
      markets: filterMarkets(result.markets),
      recommendedMarket: result.recommendedMarket,
      // Admin visibility: predictions below the configured confidence
      // threshold are flagged (not deleted) so the frontend can hide,
      // label, or show them per admin policy.
      ...adminVisibility(result),
    },
    model: {
      method: METHOD,
      blendedWithOdds: result.blendedWithOdds,
      dataCompleteness: result.dataCompleteness,
    },
  };
}

router.get(
  "/matches/:id/prediction",
  requireProvider,
  asyncHandler(async (req, res) => {
    const key = `prediction:${req.params.id}`;
    // SWR: serve the last prediction instantly; refresh in background when stale.
    const { value: payload, stale } = await getCached(
      key,
      "predictions",
      () => computePrediction(req.provider, req.params.id),
      { staleTtlSec: 24 * 3600 }
    );
    if (!payload) return notFound(res, `Match ${req.params.id} not found.`);
    res.set("X-OBULU-Cache", stale ? "stale" : "hit");
    res.json({ ...payload, sampleData: isSample() });
  })
);

// --------------------------------------------------------------- metrics ---
// Lightweight internal performance observability: API call counts/timings,
// cache hit rates, dedup savings. No sensitive data. Requires the admin key
// when AUTOMATION_ADMIN_KEY is set (same posture as automation mutating
// endpoints); open in dev when unset.
router.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    const adminKey = process.env.AUTOMATION_ADMIN_KEY;
    if (adminKey) {
      const provided = req.headers["x-admin-key"] || req.query.admin_key;
      if (provided !== adminKey) {
        return res.status(403).json({ error: "FORBIDDEN", message: "Valid X-Admin-Key required." });
      }
    }
    res.json(getMetrics());
  })
);

export default router;
