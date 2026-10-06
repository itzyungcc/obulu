// OBULU Automation Agent — qualification engine.
// Decides ONLY "does this prediction meet the user's criteria?" — it never
// alters probabilities, confidence, or the predicted outcome. Confidence
// (model signal strength) and probability (outcome likelihood) are kept
// strictly separate and labelled as such in notifications.

export function qualify({ prediction, match, config }) {
  const reasons = [];
  const fail = (r) => reasons.push(r);

  const home = prediction.homeWin;
  const draw = prediction.draw;
  const away = prediction.awayWin;
  const probs = [home, draw, away];
  const maxProb = Math.max(...probs);
  const sorted = [...probs].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];

  // Confidence vs probability are different measures — check both explicitly.
  if (prediction.confidence < config.minConfidence) {
    fail(`confidence ${prediction.confidence.toFixed(1)} < ${config.minConfidence}`);
  }
  if (prediction.dataCompleteness < config.minDataCompleteness) {
    fail(`data_completeness ${prediction.dataCompleteness.toFixed(1)} < ${config.minDataCompleteness}`);
  }
  if (maxProb < config.minProbability) {
    fail(`max_probability ${maxProb.toFixed(1)} < ${config.minProbability}`);
  }
  if (margin < config.minOutcomeMargin) {
    fail(`outcome_margin ${margin.toFixed(1)} < ${config.minOutcomeMargin}`);
  }

  const outcome = String(prediction.predictedOutcome || "").toLowerCase();
  if (!config.allowedOutcomes.includes(outcome)) {
    fail(`outcome '${outcome}' not in allowed [${config.allowedOutcomes.join(", ")}]`);
  }

  const leagueName = String(match.league || "");
  const leagueId = String(match.leagueId || "");
  if (config.allowedLeagues.length > 0) {
    const ok = config.allowedLeagues.some(
      (l) =>
        leagueName.toLowerCase().includes(String(l).toLowerCase()) ||
        leagueId === String(l)
    );
    if (!ok) fail(`league '${leagueName}' not in allowed leagues`);
  }
  if (config.blockedLeagues.length > 0) {
    const blocked = config.blockedLeagues.some(
      (l) =>
        leagueName.toLowerCase().includes(String(l).toLowerCase()) ||
        leagueId === String(l)
    );
    if (blocked) fail(`league '${leagueName}' is blocked`);
  }

  // Kickoff window.
  const kickoffMs = Date.parse(match.kickoff);
  const hoursUntil = (kickoffMs - Date.now()) / 3600000;
  if (!Number.isFinite(hoursUntil) || hoursUntil < 0) {
    fail("match has already started");
  } else {
    if (hoursUntil < config.minHoursBeforeKickoff) {
      fail(`kickoff in ${hoursUntil.toFixed(1)}h < min ${config.minHoursBeforeKickoff}h`);
    }
    if (hoursUntil > config.maxHoursBeforeKickoff) {
      fail(`kickoff in ${hoursUntil.toFixed(1)}h > max ${config.maxHoursBeforeKickoff}h`);
    }
  }

  // Match must still be pre-match.
  if (match.status && match.status !== "NS") {
    fail(`match status is ${match.status}, not pre-match`);
  }

  return {
    qualified: reasons.length === 0,
    reasons,
    maxProbability: maxProb,
    outcomeMargin: margin,
    hoursUntilKickoff: hoursUntil,
  };
}
