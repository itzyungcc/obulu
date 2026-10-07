// OBULU Automation Agent — match analyzer.
// Runs fixtures through the ONE authoritative OBULU prediction engine
// (Poisson/Dixon-Coles in model/poisson.js). The automation never duplicates
// prediction math and never modifies the model's outputs.

import { getProvider } from "../providers/index.js";
import { predictMatch, MODEL_VERSION } from "../model/poisson.js";
import { cacheGet, cacheSet } from "../cache.js";
import { dedup } from "../perf.js";
import config from "../config.js";

async function cachedTeamStats(provider, teamId, leagueId) {
  const key = `teamstats:${teamId}:${leagueId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  // Dedup: concurrent analyses sharing a team trigger one fetch, not N.
  return dedup(key, async () => {
    const hit2 = cacheGet(key);
    if (hit2) return hit2;
    const stats = await provider.getTeamStats(teamId, leagueId);
    cacheSet(key, stats, "teamStats");
    return stats;
  });
}

async function cachedLeagueAvgs(provider, leagueId) {
  const key = `leagueavgs:${leagueId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return dedup(key, async () => {
    const hit2 = cacheGet(key);
    if (hit2) return hit2;
    const avgs = await provider.getLeagueAvgs(leagueId);
    if (avgs) cacheSet(key, avgs, "standings");
    return avgs;
  });
}

export async function analyzeFixture(fixture, opts = {}) {
  const provider = getProvider();
  if (!provider) {
    const err = new Error("PROVIDER_UNAVAILABLE");
    err.code = "PROVIDER_UNAVAILABLE";
    throw err;
  }

  // The fixture from the collector is already complete (id, home, away,
  // league, kickoff). Only re-fetch if we were given a bare id string.
  const match =
    typeof fixture === "string" ? await provider.getMatch(fixture) : fixture;
  if (!match || !match.home?.id || !match.away?.id) {
    const err = new Error(
      `PREDICTION_FAILED: incomplete fixture data for ${typeof fixture === "string" ? fixture : fixture?.id}`
    );
    err.code = "PREDICTION_FAILED";
    throw err;
  }

  let homeStats, awayStats;
  try {
    [homeStats, awayStats] = await Promise.all([
      cachedTeamStats(provider, match.home.id, match.league.id),
      cachedTeamStats(provider, match.away.id, match.league.id),
    ]);
  } catch (e) {
    const err = new Error(`PREDICTION_FAILED: team stats failed: ${e.message}`);
    err.code = "PREDICTION_FAILED";
    throw err;
  }

  // Best-effort auxiliaries — prediction works without them.
  let leagueAvgs = null;
  try {
    leagueAvgs = await cachedLeagueAvgs(provider, match.league.id);
  } catch {
    /* optional */
  }

  // Optional odds input (e.g. bookmaker 1X2 odds from SportyBet): when given,
  // the prediction is blended with the odds-implied probabilities using the
  // configured model odds weight. Default (no opts.odds): pure statistical
  // model, unchanged from before.
  const withOdds = !!opts.odds;
  const result = predictMatch(homeStats, awayStats, leagueAvgs, null, withOdds ? opts.odds : null, {
    oddsWeight: withOdds ? config.modelOddsWeight : 0, // automation default: pure model (MODEL_ODDS_WEIGHT=1 semantics: fully model-based)
  });

  // Normalize model outputs to the automation's 0-100 scales:
  // - probabilities are already 0-100 from toPercentages()
  // - confidence is {score: 0-100, label} -> extract the numeric score
  // - dataCompleteness is 0-1 -> scale to 0-100
  const confidenceScore =
    typeof result.confidence === "object" && result.confidence !== null
      ? result.confidence.score
      : result.confidence;
  const completeness100 = Math.round((result.dataCompleteness || 0) * 100);

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
      predictedOutcome: String(result.predictedOutcome || "").toLowerCase(),
      confidence: confidenceScore,
      confidenceLabel: result.confidence?.label || null,
      dataCompleteness: completeness100,
      expectedHomeGoals: result.expectedGoals?.home ?? null,
      expectedAwayGoals: result.expectedGoals?.away ?? null,
      factors: result.factors || [],
      blendedWithOdds: result.blendedWithOdds === true,
    },
    modelVersion: MODEL_VERSION,
  };
}
