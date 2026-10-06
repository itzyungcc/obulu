// OBULU Live Prediction Engine — read API.
// Fast in-memory reads of the engine's latest live state; history comes
// from the live_predictions table. All responses are JSON.
// Informational only — no betting content.
import { Router } from "express";
import { db } from "../db/database.js";
import { getProvider } from "../providers/index.js";
import { getLiveStates } from "../live/engine.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// 503 when no data provider is configured (never fake data). Provider
// failures at poll time are 502-shaped by the global error handler.
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

function compactFixture(fx) {
  return {
    id: fx.id,
    league: fx.league,
    home: fx.home,
    away: fx.away,
    kickoff: fx.kickoff,
    status: fx.status,
  };
}

function mapState(s) {
  return {
    fixture: compactFixture(s.fixture),
    score: s.score || null,
    minute: s.minute ?? null,
    minuteSource: s.minuteSource || null,
    redCards: s.redCards || null,
    live: s.live
      ? {
          homeWin: s.live.homeWin,
          draw: s.live.draw,
          awayWin: s.live.awayWin,
          predictedOutcome: s.live.predictedOutcome,
          confidence: s.live.confidence,
          factors: s.live.factors,
          expectedGoalsRemaining: s.live.expectedGoalsRemaining,
        }
      : null,
    preMatch: s.preMatch
      ? {
          homeWin: s.preMatch.homeWin,
          draw: s.preMatch.draw,
          awayWin: s.preMatch.awayWin,
          predictedOutcome: s.preMatch.predictedOutcome,
          confidence: s.preMatch.confidence,
        }
      : null,
    baselineSource: s.baselineSource || null,
    trackedSince: s.trackedSince,
  };
}

// ------------------------------------------------------------ all live ---
// GET /api/live -> matches currently tracked by the engine (fast,
// in-memory). Empty array when nothing is live or engine disabled.
router.get(
  "/live",
  requireProvider,
  asyncHandler(async (_req, res) => {
    const states = getLiveStates().filter((s) => s.live);
    res.json({ matches: states.map(mapState), count: states.length });
  })
);

// ------------------------------------------------------- live history ---
// GET /api/live/:fixtureId/history -> live_predictions rows, chronological
// (newest last), capped at 100. Registered BEFORE /live/:fixtureId.
router.get(
  "/live/:fixtureId/history",
  requireProvider,
  asyncHandler(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM live_predictions
         WHERE fixture_id = ?
         ORDER BY created_at ASC
         LIMIT 100`
      )
      .all(String(req.params.fixtureId));
    res.json({
      fixtureId: String(req.params.fixtureId),
      snapshots: rows.map((r) => ({
        minute: r.minute,
        minuteSource: r.minute_source,
        score: { home: r.score_home, away: r.score_away },
        redCards: { home: r.red_home, away: r.red_away },
        homeWin: r.home_win,
        draw: r.draw,
        awayWin: r.away_win,
        predictedOutcome: r.predicted_outcome,
        confidence: { score: r.confidence_score, label: r.confidence_label },
        factors: (() => {
          try {
            return JSON.parse(r.factors || "[]");
          } catch {
            return [];
          }
        })(),
        createdAt: r.created_at,
      })),
    });
  })
);

// -------------------------------------------------------- single live ---
// GET /api/live/:fixtureId -> full live state + pre-match baseline.
router.get(
  "/live/:fixtureId",
  requireProvider,
  asyncHandler(async (req, res) => {
    const state = getLiveStates().find(
      (s) => String(s.fixtureId) === String(req.params.fixtureId)
    );
    if (!state || !state.live) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: `Fixture ${req.params.fixtureId} is not currently tracked as live.`,
      });
    }
    const out = mapState(state);
    out.stats = state.stats || null;
    out.lastSeen = state.lastSeen;
    res.json(out);
  })
);

export default router;
