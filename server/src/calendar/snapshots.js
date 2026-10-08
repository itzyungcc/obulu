// OBULU Prediction Calendar — snapshot recording.
// One immutable pre-match prediction per fixture (first snapshot wins).
// Snapshots are INSERT OR IGNORE on fixture_id; they are NEVER overwritten.
// Snapshot recording must never break the caller: wrap in try/catch at the
// hook sites (a snapshot failure is logged and ignored).
import { db } from "../db/database.js";
import { MODEL_VERSION } from "../model/poisson.js";
import { schedulePush } from "../db/turso-sync.js";

const log = (...a) => console.log("[Calendar]", ...a);

// SQLite cannot bind undefined or NaN. Sanitize numerics.
function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// kickoff_date: the calendar day of the kickoff in Africa/Lagos (UTC+1,
// no DST — stable all year).
export function lagosDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Normalize the two prediction shapes this service sees:
//  - GET /api/matches/:id/prediction result: predictedOutcome "HOME"|...,
//    confidence { score, label }, dataCompleteness 0-1, expectedGoals { home, away }
//  - automation analyzeFixture: predictedOutcome "home"|..., confidence numeric
//    score + confidenceLabel, dataCompleteness 0-100, expectedHomeGoals/AwayGoals
function normalizePrediction(p) {
  const out = String(p.predictedOutcome || "").toUpperCase();
  let confScore = null;
  let confLabel = null;
  if (p.confidence && typeof p.confidence === "object") {
    confScore = num(p.confidence.score);
    confLabel = p.confidence.label || null;
  } else if (p.confidence != null) {
    confScore = num(p.confidence);
    confLabel = p.confidenceLabel || null;
  } else if (p.confidenceLabel) {
    confLabel = p.confidenceLabel;
  }
  let dc = num(p.dataCompleteness);
  if (dc != null && dc > 1) dc = dc / 100; // automation reports 0-100
  return {
    homeWin: num(p.homeWin, 0),
    draw: num(p.draw, 0),
    awayWin: num(p.awayWin, 0),
    predictedOutcome: ["HOME", "DRAW", "AWAY"].includes(out) ? out : "DRAW",
    confScore,
    confLabel,
    dataCompleteness: dc,
    xgHome: num(p.expectedGoals?.home ?? p.expectedHomeGoals),
    xgAway: num(p.expectedGoals?.away ?? p.expectedAwayGoals),
    factors: JSON.stringify(p.factors || []),
    blendedWithOdds: p.blendedWithOdds ? 1 : 0,
  };
}

// Record an immutable prediction snapshot for a fixture. Returns true when
// this call created the snapshot, false when one already existed (first
// snapshot wins). Never throws.
export function recordPredictionSnapshot(fixture, prediction) {
  try {
    if (!fixture || !fixture.id || !prediction) return false;
    const p = normalizePrediction(prediction);
    const homeTeam = fixture.home?.name || fixture.home_team || "?";
    const awayTeam = fixture.away?.name || fixture.away_team || "?";
    const league = fixture.league?.name || fixture.league || null;
    const country = fixture.league?.country || fixture.country || null;
    const kickoff = fixture.kickoff || null;
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO prediction_snapshots
           (fixture_id, home_team, away_team, league, country, kickoff,
            kickoff_date, predicted_at, home_win, draw, away_win,
            predicted_outcome, confidence_score, confidence_label,
            data_completeness, expected_home_goals, expected_away_goals,
            factors, model_version, blended_with_odds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(fixture.id),
        homeTeam,
        awayTeam,
        league,
        country,
        kickoff,
        kickoff ? lagosDate(kickoff) : null,
        new Date().toISOString(),
        p.homeWin,
        p.draw,
        p.awayWin,
        p.predictedOutcome,
        p.confScore,
        p.confLabel,
        p.dataCompleteness,
        p.xgHome,
        p.xgAway,
        p.factors,
        MODEL_VERSION,
        p.blendedWithOdds
      );
    const saved = Number(res.changes) === 1;
    if (saved) schedulePush(db); // back the new snapshot up to Turso
    return saved;
  } catch (e) {
    log("snapshot record failed (non-fatal):", e.message);
    return false;
  }
}

// Convenience read used by the live engine baseline.
export function getSnapshot(fixtureId) {
  return (
    db
      .prepare("SELECT * FROM prediction_snapshots WHERE fixture_id = ? LIMIT 1")
      .get(String(fixtureId)) || null
  );
}
