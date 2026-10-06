// OBULU live prediction model — pure functions for in-play probability
// updates. No IO, no provider knowledge.
//
// Takes a pre-match Poisson baseline (expected goals + 1X2) and the live
// state, then re-convolves the REMAINING expected goals — shrunk by elapsed
// time, adjusted for red cards, optionally nudged by shot momentum — onto
// the current score.
//
// Informational only. Outputs are statistical estimates, never guarantees.

const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
const poissonPmf = (k, lambda) =>
  (Math.exp(-lambda) * Math.pow(lambda, k)) / FACT[k];

const RED_CARD_PENALTY = 0.78; // per net red card against a team
const MAX_GOALS = 10;
const SOT_PER_GOAL = 3.2; // expected shots-on-target per expected goal

// Largest-remainder rounding so percentages sum to exactly 100.0 (1dp).
export function normalizeProbs(pHome, pDraw, pAway) {
  const vals = [pHome, pDraw, pAway].map(Number);
  const total = vals[0] + vals[1] + vals[2];
  const q =
    total > 0 && vals.every(Number.isFinite)
      ? vals.map((x) => x / total)
      : [1 / 3, 1 / 3, 1 / 3];
  const tenths = q.map((p) => Math.round(p * 1000));
  const diff = 1000 - (tenths[0] + tenths[1] + tenths[2]);
  tenths[tenths.indexOf(Math.max(...tenths))] += diff;
  return tenths.map((t) => t / 10);
}

export function clampMinute(minute) {
  const m = Number(minute);
  if (!Number.isFinite(m)) return 0;
  return Math.min(130, Math.max(0, m));
}

// Derive the current match minute from kickoff elapsed. Returns null when
// the kickoff is missing, invalid, or in the future.
export function estimateMinute(kickoffISO, now = new Date()) {
  const t = Date.parse(kickoffISO);
  const n = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  const mins = Math.floor((n - t) / 60000);
  if (mins < 0) return null;
  return Math.min(mins, 130);
}

// Red-card adjustment: each net red card against a team multiplies that
// team's remaining xG by 0.78. Symmetric — a team whose opponent went down
// to ten benefits (0.78^-1 ≈ 1.28).
export function applyRedCards(xgHome, xgAway, redHome = 0, redAway = 0) {
  const rh = Number(redHome) || 0;
  const ra = Number(redAway) || 0;
  return {
    home: xgHome * Math.pow(RED_CARD_PENALTY, rh - ra),
    away: xgAway * Math.pow(RED_CARD_PENALTY, ra - rh),
  };
}

// Shot-momentum factor for one team. ONLY used when actual shots on target
// are reported by the provider (both sides), so the factor is computed from
// real data, never assumed.
function momentumFactor(actualSoT, lambda, minute) {
  const expectedSoT = lambda * SOT_PER_GOAL * (minute / 90);
  const f =
    1 + (0.15 * (actualSoT - expectedSoT)) / Math.max(expectedSoT, 1);
  return Math.min(1.3, Math.max(0.7, f));
}

// Plain-language live factors, built ONLY from actual data.
// live must carry homeName/awayName (from the fixture) for team names.
export function explainLive(preMatch, live, probs) {
  const f = [];
  const hn = (live && live.homeName) || "The home side";
  const an = (live && live.awayName) || "The away side";
  const sh = Number(live && live.scoreHome) || 0;
  const sa = Number(live && live.scoreAway) || 0;

  if (sh > sa) f.push(`${hn} currently leading ${sh}-${sa}`);
  else if (sa > sh) f.push(`${an} currently leading ${sa}-${sh}`);
  else f.push(`The match is currently level at ${sh}-${sa}`);

  const rh = Number(live && live.redCardsHome) || 0;
  const ra = Number(live && live.redCardsAway) || 0;
  if (rh > 0) f.push(`${hn} down to ${Math.max(1, 11 - rh)} men`);
  if (ra > 0) f.push(`${an} down to ${Math.max(1, 11 - ra)} men`);

  const sot = live && live.stats && live.stats.shotsOnTarget;
  if (sot && Number.isFinite(sot.home) && Number.isFinite(sot.away)) {
    f.push(`More shots on target (${sot.home} vs ${sot.away})`);
  }

  const fav =
    (preMatch && preMatch.predictedOutcome) || favouriteOf(preMatch);
  if (fav === "HOME") f.push(`${hn} carried the stronger pre-match rating`);
  else if (fav === "AWAY") f.push(`${an} carried the stronger pre-match rating`);
  else f.push("The pre-match rating saw this as an open contest");

  return f;
}

function favouriteOf(preMatch) {
  if (!preMatch) return null;
  const order = [
    ["HOME", preMatch.homeWin],
    ["DRAW", preMatch.draw],
    ["AWAY", preMatch.awayWin],
  ].sort((a, b) => b[1] - a[1]);
  return order[0][0];
}

// Main entry point.
//
// preMatch: { homeWin, draw, awayWin (0-100), expectedGoals: { home, away },
//             predictedOutcome (optional), confidence }
// live:     { scoreHome, scoreAway, minute, redCardsHome, redCardsAway,
//             stats (optional), homeName, awayName }
export function computeLivePrediction({ preMatch, live }) {
  if (!preMatch || !preMatch.expectedGoals) {
    throw new Error("computeLivePrediction: preMatch.expectedGoals is required");
  }
  const xgH = Number(preMatch.expectedGoals.home) || 0;
  const xgA = Number(preMatch.expectedGoals.away) || 0;
  const lv = live || {};
  const sh = Number(lv.scoreHome) || 0;
  const sa = Number(lv.scoreAway) || 0;

  const m = clampMinute(lv.minute);
  const t = Math.min(1, Math.max(0, m / 90));

  let remH = xgH * (1 - t);
  let remA = xgA * (1 - t);

  const adjusted = applyRedCards(remH, remA, lv.redCardsHome, lv.redCardsAway);
  remH = adjusted.home;
  remA = adjusted.away;

  const sot = lv.stats && lv.stats.shotsOnTarget;
  if (sot && Number.isFinite(sot.home) && Number.isFinite(sot.away)) {
    remH *= momentumFactor(sot.home, xgH, m);
    remA *= momentumFactor(sot.away, xgA, m);
  }

  // Convolve remaining-goal Poissons onto the current score.
  let pH = 0, pD = 0, pA = 0, total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    const pi = poissonPmf(i, remH);
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = pi * poissonPmf(j, remA);
      total += p;
      const fh = sh + i;
      const fa = sa + j;
      if (fh > fa) pH += p;
      else if (fh === fa) pD += p;
      else pA += p;
    }
  }
  const [homeWin, draw, awayWin] = normalizeProbs(pH / total, pD / total, pA / total);

  const order = [
    ["HOME", homeWin],
    ["DRAW", draw],
    ["AWAY", awayWin],
  ].sort((a, b) => b[1] - a[1]);
  const predictedOutcome = order[0][0];

  // Separate live confidence: favourite-vs-second margin.
  const spread = order[0][1] - order[1][1];
  const score = Math.min(98, Math.max(5, Math.round(spread * 1.4)));
  const label =
    spread >= 40 ? "Very high"
    : spread >= 25 ? "High"
    : spread >= 12 ? "Moderate"
    : "Low";

  return {
    homeWin,
    draw,
    awayWin,
    predictedOutcome,
    confidence: { score, label },
    factors: explainLive(preMatch, lv, { homeWin, draw, awayWin, predictedOutcome }),
    expectedGoalsRemaining: {
      home: Math.round(remH * 100) / 100,
      away: Math.round(remA * 100) / 100,
    },
  };
}
