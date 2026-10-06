// OBULU API routes. All responses are JSON. Informational only — no betting,
// staking, or gambling content anywhere.
import { Router } from "express";
import config from "../config.js";
import { db } from "../db/database.js";
import { getProvider, providerKind, oddsEnabled } from "../providers/index.js";
import * as oddsApi from "../providers/oddsApi.js";
import { cacheGet, cacheSet } from "../cache.js";
import { predictMatch, DISCLAIMER, MODEL_VERSION, METHOD } from "../model/poisson.js";

const router = Router();

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
router.get(
  "/health",
  asyncHandler(async (req, res) => {
    const kind = providerKind();
    res.json({
      ok: true,
      version: "1.0.0",
      dataMode: dataMode(),
      providers: {
        primary: kind === "api-football" ? "api-football" : kind === "football-data.org" ? "football-data.org" : kind === "sample" ? "sample" : "none",
        odds: oddsEnabled(),
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// --------------------------------------------------------------- leagues ---
router.get(
  "/leagues",
  requireProvider,
  asyncHandler(async (req, res) => {
    const key = "leagues:all";
    let leagues = cacheGet(key);
    if (!leagues) {
      leagues = await req.provider.getLeagues();
      cacheSet(key, leagues, "leagues");
    }
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
    let fixtures = cacheGet(key);
    if (!fixtures) {
      fixtures = await req.provider.getUpcomingFixtures({
        league: league || undefined,
        date: date || undefined,
        team: team || undefined,
      });
      cacheSet(key, fixtures, "fixtures");
    }
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
    let match = cacheGet(key);
    if (!match) {
      match = await req.provider.getMatch(req.params.id);
      if (match) cacheSet(key, match, "fixtures");
    }
    if (!match) return notFound(res, `Match ${req.params.id} not found.`);
    res.json({ match, sampleData: isSample() });
  })
);

// ------------------------------------------------------- matches analysis ---
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

router.get(
  "/matches/:id/analysis",
  requireProvider,
  asyncHandler(async (req, res) => {
    const provider = req.provider;
    const match = await provider.getMatch(req.params.id);
    if (!match) return notFound(res, `Match ${req.params.id} not found.`);

    const settled = await Promise.allSettled([
      provider.getTeamStats(match.home.id, match.league.id),
      provider.getTeamStats(match.away.id, match.league.id),
      provider.getHeadToHead(match.home.id, match.away.id),
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

    res.json({
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
      sampleData: isSample(),
    });
  })
);

// ------------------------------------------------------ matches prediction ---
router.get(
  "/matches/:id/prediction",
  requireProvider,
  asyncHandler(async (req, res) => {
    const provider = req.provider;
    const match = await provider.getMatch(req.params.id);
    if (!match) return notFound(res, `Match ${req.params.id} not found.`);

    const [homeStats, awayStats] = await Promise.all([
      provider.getTeamStats(match.home.id, match.league.id),
      provider.getTeamStats(match.away.id, match.league.id),
    ]);

    // Best-effort auxiliaries: prediction must still work without them.
    let h2h = null, leagueAvgs = null, odds = null;
    try { h2h = await provider.getHeadToHead(match.home.id, match.away.id); } catch { /* optional */ }
    try { leagueAvgs = await provider.getLeagueAvgs(match.league.id); } catch { /* optional */ }
    try {
      if (typeof provider.getOdds === "function") odds = await provider.getOdds(match.id);
      if (!odds) odds = await oddsApi.getOdds(match);
    } catch { /* optional */ }

    const result = predictMatch(homeStats, awayStats, leagueAvgs, h2h, odds, {
      oddsWeight: config.modelOddsWeight,
    });

    // Persist the prediction for audit / future calibration work.
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
      isSample() ? 1 : 0,
      new Date().toISOString()
    );

    res.json({
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
      },
      model: {
        method: METHOD,
        blendedWithOdds: result.blendedWithOdds,
        dataCompleteness: result.dataCompleteness,
      },
      sampleData: isSample(),
    });
  })
);

export default router;
