// OBULU prediction model: Poisson goal model with Dixon–Coles correction.
//
// Five separated stages:
//   1. ingest      — normalize inputs, tolerate missing fields
//   2. features    — attack/defence strengths with recency decay + shrinkage
//   3. model       — independent Poissons (0..10) + Dixon–Coles low-score correction
//   4. calibration — optional blend with market-implied probabilities
//   5. output      — rounded percentages summing to exactly 100.0, outcome,
//                    confidence, plain-language factors
//
// Informational only. Outputs are statistical estimates, never guarantees.

export const MODEL_VERSION = "1.0.0";
export const METHOD = "poisson-dixon-coles";
export const DISCLAIMER =
  "Predictions are statistical estimates based on available data and are not guarantees of match results.";

// Tunables (see MODEL.md)
const RECENCY_DECAY = 0.9; // exponential decay per match back in time (last 10)
const SHRINKAGE_K = 4; // pseudo-matches toward league average for n < 6
const SHRINKAGE_MIN_MATCHES = 6;
const DIXON_COLES_TAU = 0.05;
const MAX_GOALS = 10;
const DEFAULT_HOME_ADV = 1.18; // home attack multiplier when league avgs missing
const DEFAULT_AWAY_ADV = 0.9; // away attack multiplier when league avgs missing
const DEFAULT_AVG_HOME_GOALS = 1.45;
const DEFAULT_AVG_AWAY_GOALS = 1.15;
const CREDIBLE_AVG_RANGE = [0.3, 3.5];

// ---------------------------------------------------------------------------
// Stage 1: ingest
// ---------------------------------------------------------------------------
function emptyStats() {
  return {
    teamId: "?",
    played: 0, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, cleanSheets: 0,
    homePlayed: 0, homeGF: 0, homeGA: 0,
    awayPlayed: 0, awayGF: 0, awayGA: 0,
    recentForm: [],
  };
}

function ingest(home, away, leagueAvgs, h2h) {
  const h = { ...emptyStats(), ...(home || {}) };
  const a = { ...emptyStats(), ...(away || {}) };
  if (!Array.isArray(h.recentForm)) h.recentForm = [];
  if (!Array.isArray(a.recentForm)) a.recentForm = [];

  let avgs = leagueAvgs || {};
  let credible = false;
  let avgH = Number(avgs.avgHomeGoals);
  let avgA = Number(avgs.avgAwayGoals);
  if (
    Number.isFinite(avgH) && Number.isFinite(avgA) &&
    avgH >= CREDIBLE_AVG_RANGE[0] && avgH <= CREDIBLE_AVG_RANGE[1] &&
    avgA >= CREDIBLE_AVG_RANGE[0] && avgA <= CREDIBLE_AVG_RANGE[1]
  ) {
    credible = true;
  } else {
    avgH = DEFAULT_AVG_HOME_GOALS;
    avgA = DEFAULT_AVG_AWAY_GOALS;
  }
  return {
    home: h,
    away: a,
    leagueAvgs: { avgHomeGoals: avgH, avgAwayGoals: avgA, credible },
    h2h: h2h && typeof h2h === "object"
      ? { played: 0, homeWins: 0, draws: 0, awayWins: 0, lastMeetings: [], ...h2h }
      : { played: 0, homeWins: 0, draws: 0, awayWins: 0, lastMeetings: [] },
  };
}

// ---------------------------------------------------------------------------
// Stage 2: features
// ---------------------------------------------------------------------------
// Aggregate recency-weighted goals for/against. Venue filter: true = home
// matches only, false = away only, null = all. Falls back to all matches when
// the venue split has fewer than 3 matches.
function venueAgg(form, venue) {
  let n = 0, w = 0, gf = 0, ga = 0;
  const list = form || [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (venue !== null && m.home !== venue) continue;
    const wt = Math.pow(RECENCY_DECAY, i);
    n += 1;
    w += wt;
    gf += wt * (m.home ? m.scoreH : m.scoreA);
    ga += wt * (m.home ? m.scoreA : m.scoreH);
  }
  return { n, w, gf, ga };
}

function bestAgg(form, venue) {
  const v = venueAgg(form, venue);
  if (venue === null || v.n >= 3) return v;
  const all = venueAgg(form, null);
  return all.n > v.n ? all : v;
}

// strength = observed rate vs league average, shrunk toward 1.0 when data is thin
function strength(goals, weight, matches, leagueAvg) {
  if (!weight || !leagueAvg) return 1.0;
  const observed = goals / weight / leagueAvg;
  if (!Number.isFinite(observed)) return 1.0;
  if (matches < SHRINKAGE_MIN_MATCHES) {
    return (matches * observed + SHRINKAGE_K * 1.0) / (matches + SHRINKAGE_K);
  }
  return observed;
}

function features(home, away, leagueAvgs) {
  const avgH = leagueAvgs.avgHomeGoals;
  const avgA = leagueAvgs.avgAwayGoals;
  const avgScored = (avgH + avgA) / 2; // league-average goals scored per team per match

  const hAgg = bestAgg(home.recentForm, true); // home side, at home
  const aAgg = bestAgg(away.recentForm, false); // away side, away

  const attackH = strength(hAgg.gf, hAgg.w, hAgg.n, avgScored);
  const defenceH = strength(hAgg.ga, hAgg.w, hAgg.n, avgScored);
  const attackA = strength(aAgg.gf, aAgg.w, aAgg.n, avgScored);
  const defenceA = strength(aAgg.ga, aAgg.w, aAgg.n, avgScored);

  // Home advantage: league averages already encode it when credible, so the
  // extra multiplier is 1.0; otherwise use the documented defaults.
  const homeAdvH = leagueAvgs.credible ? 1.0 : DEFAULT_HOME_ADV;
  const homeAdvA = leagueAvgs.credible ? 1.0 : DEFAULT_AWAY_ADV;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const xgHome = clamp(attackH * defenceA * avgH * homeAdvH, 0.05, 5);
  const xgAway = clamp(attackA * defenceH * avgA * homeAdvA, 0.05, 5);

  return { attackH, defenceH, attackA, defenceA, xgHome, xgAway, avgH, avgA, credible: leagueAvgs.credible };
}

// ---------------------------------------------------------------------------
// Stage 3: model — Poisson score matrix with Dixon–Coles correction
// ---------------------------------------------------------------------------
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
const poissonPmf = (k, lambda) => (Math.exp(-lambda) * Math.pow(lambda, k)) / FACT[k];

function scoreProbabilities(xgHome, xgAway) {
  const m = [];
  for (let i = 0; i <= MAX_GOALS; i++) {
    m[i] = [];
    for (let j = 0; j <= MAX_GOALS; j++) {
      let p = poissonPmf(i, xgHome) * poissonPmf(j, xgAway);
      // Dixon–Coles low-score correction (tau function).
      if (i === 0 && j === 0) p *= 1 - xgHome * xgAway * DIXON_COLES_TAU;
      else if (i === 0 && j === 1) p *= 1 + xgHome * DIXON_COLES_TAU;
      else if (i === 1 && j === 0) p *= 1 + xgAway * DIXON_COLES_TAU;
      else if (i === 1 && j === 1) p *= 1 - DIXON_COLES_TAU;
      m[i][j] = p;
    }
  }
  let total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) total += m[i][j];

  let pHome = 0, pDraw = 0, pAway = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const q = m[i][j] / total;
      if (i > j) pHome += q;
      else if (i === j) pDraw += q;
      else pAway += q;
    }
  }
  return { pHome, pDraw, pAway };
}

// ---------------------------------------------------------------------------
// Stage 4: calibration — blend with market-implied probabilities
// ---------------------------------------------------------------------------
function impliedFromOdds(odds) {
  if (!odds) return null;
  const h = Number(odds.home), d = Number(odds.draw), a = Number(odds.away);
  if (![h, d, a].every((x) => Number.isFinite(x) && x > 1)) return null;
  const ih = 1 / h, id = 1 / d, ia = 1 / a;
  const s = ih + id + ia;
  return { pHome: ih / s, pDraw: id / s, pAway: ia / s };
}

function calibrate(probs, odds, oddsWeight) {
  const implied = impliedFromOdds(odds);
  if (!implied) return { probs, blendedWithOdds: false };
  const w = Math.min(1, Math.max(0, oddsWeight));
  const pHome = w * probs.pHome + (1 - w) * implied.pHome;
  const pDraw = w * probs.pDraw + (1 - w) * implied.pDraw;
  const pAway = w * probs.pAway + (1 - w) * implied.pAway;
  const s = pHome + pDraw + pAway;
  return {
    probs: { pHome: pHome / s, pDraw: pDraw / s, pAway: pAway / s },
    blendedWithOdds: true,
  };
}

// ---------------------------------------------------------------------------
// Stage 5: output
// ---------------------------------------------------------------------------
// Largest-remainder rounding so percentages sum to exactly 100.0.
function toPercentages(pHome, pDraw, pAway) {
  const tenths = [pHome, pDraw, pAway].map((p) => Math.round(p * 1000));
  let diff = 1000 - (tenths[0] + tenths[1] + tenths[2]);
  // Apply the rounding remainder to the largest component.
  let idx = tenths.indexOf(Math.max(...tenths));
  tenths[idx] += diff;
  return tenths.map((t) => t / 10);
}

function dataCompleteness(home, away, leagueAvgs, h2h) {
  // §24: use the ACTUAL number of recent-form matches available, not the
  // season `played` counter (a team can have played 12 games while only 2
  // recent results are on record). Same 0-1 scaling otherwise.
  const hn = Math.min((home.recentForm || []).length, 10) / 10;
  const an = Math.min((away.recentForm || []).length, 10) / 10;
  return 0.35 * hn + 0.35 * an + 0.15 * (leagueAvgs.credible ? 1 : 0) + 0.15 * (h2h.played > 0 ? 1 : 0);
}

function confidenceScore(pHome, pDraw, pAway, completeness) {
  const ps = [pHome, pDraw, pAway];
  let entropy = 0;
  for (const p of ps) if (p > 0) entropy -= p * Math.log(p);
  const norm = 1 - entropy / Math.log(3); // 1 = certain, 0 = uniform
  const score = Math.round(100 * norm * completeness);
  const clamped = Math.min(100, Math.max(0, score));
  const label = clamped >= 75 ? "Very high" : clamped >= 55 ? "High" : clamped >= 35 ? "Moderate" : "Low";
  return { score: clamped, label };
}

function lastNPoints(form, n = 5) {
  let pts = 0;
  (form || []).slice(0, n).forEach((m) => {
    const f = m.home ? m.scoreH : m.scoreA;
    const a = m.home ? m.scoreA : m.scoreH;
    pts += f > a ? 3 : f === a ? 1 : 0;
  });
  return pts;
}

function buildFactors(home, away, feats, h2h, blended, modelFav, impliedFav) {
  const f = [];
  const push = (cond, text) => { if (cond) f.push(text); };

  push(feats.attackH > 1.15,
    `The home side scores well above the league average in home matches (attack rating ${feats.attackH.toFixed(2)}).`);
  push(feats.attackH < 0.85,
    `The home side scores below the league average in home matches (attack rating ${feats.attackH.toFixed(2)}).`);
  push(feats.defenceA > 1.15,
    `The away side concedes more than the league average on the road (defence rating ${feats.defenceA.toFixed(2)}).`);
  push(feats.defenceA < 0.85,
    `The away side has a strong defensive record away from home (defence rating ${feats.defenceA.toFixed(2)}).`);
  push(feats.defenceH < 0.85,
    `The home side is hard to score against at home (defence rating ${feats.defenceH.toFixed(2)}).`);
  push(feats.attackA > 1.15,
    `The away side carries a genuine goal threat on the road (attack rating ${feats.attackA.toFixed(2)}).`);

  const pH = lastNPoints(home.recentForm), pA = lastNPoints(away.recentForm);
  push(pH - pA >= 4, `The home side is in stronger recent form (${pH} points from the last 5 vs ${pA}).`);
  push(pA - pH >= 4, `The away side is in stronger recent form (${pA} points from the last 5 vs ${pH}).`);

  if (h2h.played >= 3) {
    if (h2h.homeWins > h2h.awayWins && h2h.homeWins > h2h.draws)
      f.push(`The home side has won ${h2h.homeWins} of the last ${h2h.played} meetings between these teams.`);
    else if (h2h.awayWins > h2h.homeWins && h2h.awayWins > h2h.draws)
      f.push(`The away side has won ${h2h.awayWins} of the last ${h2h.played} meetings between these teams.`);
    else
      f.push(`Recent meetings have been evenly contested (${h2h.homeWins} home wins, ${h2h.draws} draws, ${h2h.awayWins} away wins in the last ${h2h.played}).`);
  }

  const hp = home.position, ap = away.position;
  push(Number.isFinite(hp) && Number.isFinite(ap) && Math.abs(hp - ap) >= 5,
    `There is a clear league position gap (${hp}${ordinal(hp)} vs ${ap}${ordinal(ap)}).`);

  push(blended && modelFav === impliedFav,
    "Market-implied probabilities broadly agree with the model's assessment.");
  push(blended && modelFav !== impliedFav,
    "Market-implied probabilities differ from the model's assessment, suggesting an open contest.");

  // Guarantee 3-4 factors; pad with neutral, honest statements.
  const PAD = [
    "Both sides' recent scoring and defensive rates sit close to the league average.",
    "Neither side holds a clear statistical edge on the available data.",
    "Limited history is available for one or both sides, so this estimate carries extra uncertainty.",
  ];
  for (const p of PAD) {
    if (f.length >= 3) break;
    if (!f.includes(p)) f.push(p);
  }
  return f.slice(0, 4);
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ---------------------------------------------------------------------------
// Public pipeline
// ---------------------------------------------------------------------------
export function predictMatch(homeStats, awayStats, leagueAvgs, h2h, odds, opts = {}) {
  // 1. ingest
  const ing = ingest(homeStats, awayStats, leagueAvgs, h2h);

  // 2. features
  const feats = features(ing.home, ing.away, ing.leagueAvgs);

  // 3. model
  let probs = scoreProbabilities(feats.xgHome, feats.xgAway);

  // 4. calibration
  const oddsWeight = opts.oddsWeight !== undefined ? opts.oddsWeight : 0.75;
  const cal = calibrate(probs, odds, oddsWeight);
  probs = cal.probs;

  // 5. output
  const [homeWin, draw, awayWin] = toPercentages(probs.pHome, probs.pDraw, probs.pAway);
  const order = [
    ["HOME", probs.pHome],
    ["DRAW", probs.pDraw],
    ["AWAY", probs.pAway],
  ].sort((a, b) => b[1] - a[1]);
  const predictedOutcome = order[0][0];

  const completeness = dataCompleteness(ing.home, ing.away, ing.leagueAvgs, ing.h2h);
  const confidence = confidenceScore(probs.pHome, probs.pDraw, probs.pAway, completeness);

  const implied = impliedFromOdds(odds);
  const impliedFav = implied
    ? [["HOME", implied.pHome], ["DRAW", implied.pDraw], ["AWAY", implied.pAway]].sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const factors = buildFactors(ing.home, ing.away, feats, ing.h2h, cal.blendedWithOdds, predictedOutcome, impliedFav);

  return {
    homeWin,
    draw,
    awayWin,
    predictedOutcome,
    confidence,
    factors,
    dataCompleteness: Math.round(completeness * 100) / 100,
    blendedWithOdds: cal.blendedWithOdds,
    expectedGoals: {
      home: Math.round(feats.xgHome * 100) / 100,
      away: Math.round(feats.xgAway * 100) / 100,
    },
  };
}
