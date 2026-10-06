// OBULU Automation Agent — match analyzer.
// Runs fixtures through the ONE authoritative OBULU prediction engine
// (Poisson/Dixon-Coles in model/poisson.js). The automation never duplicates
// prediction math and never modifies the model's outputs.

import { getProvider } from "../providers/index.js";
import { predictMatch, MODEL_VERSION } from "../model/poisson.js";

export async function analyzeFixture(fixture) {
  const provider = getProvider();
  if (!provider) {
    const err = new Error("PROVIDER_UNAVAILABLE");
    err.code = "PROVIDER_UNAVAILABLE";
    throw err;
  }

  const match = fixture?.id ? await provider.getMatch(fixture.id) : fixture;
  if (!match) {
    const err = new Error("PREDICTION_FAILED");
    err.code = "PREDICTION_FAILED";
    throw err;
  }

  const [homeStats, awayStats] = await Promise.all([
    provider.getTeamStats(match.home.id, match.league.id),
    provider.getTeamStats(match.away.id, match.league.id),
  ]);

  // Best-effort auxiliaries — prediction works without them.
  let leagueAvgs = null;
  try {
    leagueAvgs = await provider.getLeagueAvgs(match.league.id);
  } catch {
    /* optional */
  }

  const result = predictMatch(homeStats, awayStats, leagueAvgs, null, null, {
    oddsWeight: 0, // automation uses the pure statistical model (MODEL_ODDS_WEIGHT=1 semantics: fully model-based)
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
      dataCompleteness: result.dataCompleteness,
      expectedHomeGoals: result.expectedGoals?.home ?? null,
      expectedAwayGoals: result.expectedGoals?.away ?? null,
      factors: result.factors || [],
      blendedWithOdds: false,
    },
    modelVersion: MODEL_VERSION,
  };
}
