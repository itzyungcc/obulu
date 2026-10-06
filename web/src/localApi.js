/**
 * OBULU offline API — used only in the offline Android build
 * (VITE_OBULU_OFFLINE=1). Implements the same endpoints and response
 * shapes as server/src/routes/api.js, but served entirely on-device:
 * the bundled REAL 2024/25 season snapshot
 * (server/src/providers/snapshotProvider.js) plus the real
 * Poisson/Dixon-Coles model (server/src/model/poisson.js, pure JS,
 * no imports).
 *
 * Every payload carries sampleData:false — this is real historical data,
 * not sample data. The snapshot covers the completed 2024/25 season
 * (free API-Football plan only unlocks seasons up to 2024).
 */
import * as provider from "../../server/src/providers/snapshotProvider.js";
import {
  predictMatch,
  MODEL_VERSION,
  METHOD,
  DISCLAIMER,
} from "../../server/src/model/poisson.js";
import { ApiError } from "./api.js";

// ---------------------------------------------------------------------------
// Helpers copied from server/src/routes/api.js (response shaping)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Endpoint implementations (mirror server/src/routes/api.js)
// ---------------------------------------------------------------------------

async function health() {
  return {
    ok: true,
    version: "1.0.0",
    dataMode: "snapshot-2024",
    providers: { primary: "snapshot", odds: false },
    timestamp: new Date().toISOString(),
  };
}

async function leagues() {
  return { leagues: await provider.getLeagues(), sampleData: false };
}

async function upcomingFixtures(params) {
  const fixtures = await provider.getUpcomingFixtures({
    league: params.league || undefined,
    date: params.date || undefined,
    team: params.team || undefined,
  });
  return { fixtures, sampleData: false };
}

async function allFixtures(params) {
  const hasFilter = params.league || params.date || params.team;
  const fixtures = await provider.getAllFixtures({
    league: params.league || undefined,
    date: params.date || undefined,
    team: params.team || undefined,
    limit: hasFilter ? undefined : 60,
  });
  return { fixtures, sampleData: false, season: "2024/25" };
}

async function searchTeams(params) {
  const q = String(params.q || "").trim();
  if (!q) throw new ApiError(400, "BAD_REQUEST", 'Query parameter "q" is required.');
  return { teams: await provider.searchTeams(q) };
}

async function getMatchOrThrow(id) {
  const match = await provider.getMatch(id);
  if (!match) throw new ApiError(404, "NOT_FOUND", `Match ${id} not found.`);
  return match;
}

async function matchDetail(id) {
  const match = await getMatchOrThrow(id);
  return { match, sampleData: false };
}

async function matchAnalysis(id) {
  const match = await getMatchOrThrow(id);
  const [homeStats, awayStats, h2h, standings, injHome, injAway] = await Promise.all([
    provider.getTeamStats(match.home.id, match.league.id),
    provider.getTeamStats(match.away.id, match.league.id),
    provider.getHeadToHead(match.home.id, match.away.id),
    provider.getStandings(match.league.id),
    provider.getInjuries(match.home.id, match.league.id),
    provider.getInjuries(match.away.id, match.league.id),
  ]);
  const hs = homeStats || { recentForm: [] };
  const as = awayStats || { recentForm: [] };
  const st = (teamId) => {
    const row = (standings || {})[teamId];
    return row
      ? { position: row.position ?? null, played: row.played ?? null, points: row.points ?? null }
      : { position: null, played: null, points: null };
  };
  return {
    match,
    recentForm: {
      home: summarizeRecentForm(hs.recentForm),
      away: summarizeRecentForm(as.recentForm),
    },
    homeAway: {
      home: summarizeHomeAway(hs.recentForm, true),
      away: summarizeHomeAway(as.recentForm, false),
    },
    headToHead: h2h || { played: 0, homeWins: 0, draws: 0, awayWins: 0, lastMeetings: [] },
    standings: { home: st(match.home.id), away: st(match.away.id) },
    injuries: { home: injHome || [], away: injAway || [] },
    sampleData: false,
  };
}

async function matchPrediction(id) {
  const match = await getMatchOrThrow(id);
  const [homeStats, awayStats] = await Promise.all([
    provider.getTeamStats(match.home.id, match.league.id),
    provider.getTeamStats(match.away.id, match.league.id),
  ]);
  let h2h = null, leagueAvgs = null;
  try { h2h = await provider.getHeadToHead(match.home.id, match.away.id); } catch { /* optional */ }
  try { leagueAvgs = await provider.getLeagueAvgs(match.league.id); } catch { /* optional */ }

  // No odds feed offline: pure model output (oddsWeight irrelevant without odds).
  const result = predictMatch(homeStats, awayStats, leagueAvgs, h2h, null, {
    oddsWeight: 0.75,
  });

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
    },
    model: {
      method: METHOD,
      blendedWithOdds: result.blendedWithOdds,
      dataCompleteness: result.dataCompleteness,
    },
    sampleData: false,
  };
}

// ---------------------------------------------------------------------------
// Prediction calendar + live tracking (online-only features).
// The offline build serves historical 2024/25 data; it has no prediction
// recording, track record, or live feed, so these endpoints return empty
// shapes or a 503-style ApiError, matching the offline "online only" UI.
// ---------------------------------------------------------------------------

async function predictionsCalendar() {
  return { days: {} };
}

async function predictionsHistory(params) {
  return {
    items: [],
    page: 1,
    limit: Number(params.limit) > 0 ? Number(params.limit) : 20,
    total: 0,
  };
}

async function predictionsStats() {
  return {
    total: 0,
    correct: 0,
    incorrect: 0,
    pending: 0,
    void: 0,
    accuracy: null,
    note: "No resolved predictions yet.",
    byOutcome: {
      HOME: { total: 0, correct: 0 },
      DRAW: { total: 0, correct: 0 },
      AWAY: { total: 0, correct: 0 },
    },
  };
}

async function liveNow() {
  return [];
}

function offlineOnly(feature) {
  return Promise.reject(
    new ApiError(
      503,
      "OFFLINE_NOT_SUPPORTED",
      `${feature} is available in the online version of OBULU only.`
    )
  );
}

// ---------------------------------------------------------------------------
// Router: same paths as web/src/api.js
// ---------------------------------------------------------------------------

export async function localApiFetch(path, params = {}) {
  const matchId = path.match(/^\/matches\/([^/]+)(\/(analysis|prediction))?$/);
  if (path === "/health") return health();
  if (path === "/leagues") return leagues();
  if (path === "/fixtures/upcoming") return upcomingFixtures(params);
  if (path === "/fixtures/all") return allFixtures(params);
  if (path === "/teams/search") return searchTeams(params);
  if (path === "/predictions/calendar") return predictionsCalendar();
  if (path === "/predictions/history") return predictionsHistory(params);
  if (path === "/predictions/stats") return predictionsStats();
  if (path === "/live") return liveNow();
  const liveHist = path.match(/^\/live\/([^/]+)\/history$/);
  if (liveHist) return offlineOnly("Live match history");
  const liveMatch = path.match(/^\/live\/([^/]+)$/);
  if (liveMatch) return offlineOnly("Live tracking");
  const predictionSnap = path.match(/^\/predictions\/([^/]+)$/);
  if (predictionSnap) return offlineOnly("Prediction details");
  if (matchId && !matchId[2]) return matchDetail(decodeURIComponent(matchId[1]));
  if (matchId && matchId[3] === "analysis")
    return matchAnalysis(decodeURIComponent(matchId[1]));
  if (matchId && matchId[3] === "prediction")
    return matchPrediction(decodeURIComponent(matchId[1]));
  throw new ApiError(404, "NOT_FOUND", `Unknown offline endpoint: ${path}`);
}
