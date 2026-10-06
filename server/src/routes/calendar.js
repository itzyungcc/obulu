// OBULU Prediction Calendar — read API for prediction history,
// accuracy tracking, and the calendar view. All responses are JSON.
// Informational only — no betting content.
import { Router } from "express";
import { db } from "../db/database.js";
import { getProvider } from "../providers/index.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Same posture as the rest of the API: 503 when no data provider is
// configured, never fake data.
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

function badRequest(res, message) {
  return res.status(400).json({ error: "BAD_REQUEST", message });
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["PENDING", "CORRECT", "INCORRECT", "VOID"];
const OUTCOMES = ["HOME", "DRAW", "AWAY"];

function currentMonthLagos() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

// Public snapshot shape.
function mapRow(r) {
  return {
    id: r.id,
    fixtureId: r.fixture_id,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    league: r.league,
    country: r.country,
    kickoff: r.kickoff,
    kickoffDate: r.kickoff_date,
    predictedAt: r.predicted_at,
    prediction: {
      homeWin: r.home_win,
      draw: r.draw,
      awayWin: r.away_win,
      predictedOutcome: r.predicted_outcome,
      confidence: { score: r.confidence_score, label: r.confidence_label },
      dataCompleteness: r.data_completeness,
      expectedGoals: {
        home: r.expected_home_goals,
        away: r.expected_away_goals,
      },
      factors: (() => {
        try {
          return JSON.parse(r.factors || "[]");
        } catch {
          return [];
        }
      })(),
      blendedWithOdds: r.blended_with_odds === 1,
    },
    modelVersion: r.model_version,
    status: r.status,
    actual:
      r.actual_home_score != null
        ? {
            homeScore: r.actual_home_score,
            awayScore: r.actual_away_score,
            outcome: r.actual_outcome,
          }
        : null,
    resolvedAt: r.resolved_at,
    liveFinal:
      r.live_final_home != null
        ? {
            homeWin: r.live_final_home,
            draw: r.live_final_draw,
            awayWin: r.live_final_away,
            predictedOutcome: r.live_final_outcome,
            correct: r.live_correct == null ? null : r.live_correct === 1,
          }
        : null,
  };
}

// ------------------------------------------------------- month calendar ---
// GET /api/predictions/calendar?month=2026-10
router.get(
  "/predictions/calendar",
  requireProvider,
  asyncHandler(async (req, res) => {
    const month = req.query.month ? String(req.query.month) : currentMonthLagos();
    if (!MONTH_RE.test(month)) {
      return badRequest(res, 'Query parameter "month" must be YYYY-MM.');
    }
    const rows = db
      .prepare(
        `SELECT kickoff_date, status, COUNT(*) AS c
         FROM prediction_snapshots
         WHERE kickoff_date LIKE ?
         GROUP BY kickoff_date, status
         ORDER BY kickoff_date ASC`
      )
      .all(`${month}%`);
    const days = {};
    for (const r of rows) {
      const d = days[r.kickoff_date] || {
        total: 0,
        correct: 0,
        incorrect: 0,
        pending: 0,
      };
      d.total += r.c;
      if (r.status === "CORRECT") d.correct += r.c;
      else if (r.status === "INCORRECT") d.incorrect += r.c;
      else if (r.status === "PENDING") d.pending += r.c;
      days[r.kickoff_date] = d;
    }
    res.json({ month, days });
  })
);

// --------------------------------------------------------------- history ---
// GET /api/predictions/history?date=&status=&outcome=&league=&from=&to=&page=&limit=
router.get(
  "/predictions/history",
  requireProvider,
  asyncHandler(async (req, res) => {
    const filters = buildFilters(req.query, res);
    if (filters.failed) return; // buildFilters already answered 400
    const { where, params } = filters;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10) || 20));
    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const offset = (page - 1) * limit;
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS c FROM prediction_snapshots ${where}`)
      .get(...params);
    const rows = db
      .prepare(
        `SELECT * FROM prediction_snapshots ${where}
         ORDER BY kickoff DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    res.json({
      items: rows.map(mapRow),
      page,
      limit,
      total: totalRow?.c ?? 0,
    });
  })
);

// ----------------------------------------------------------------- stats ---
// GET /api/predictions/stats?from=&to=&league=&outcome=
router.get(
  "/predictions/stats",
  requireProvider,
  asyncHandler(async (req, res) => {
    const filters = buildFilters(req.query, res);
    if (filters.failed) return; // buildFilters already answered 400
    const { where, params } = filters;
    const count = (extra) => {
      const clause = where
        ? `${where}${extra ? ` AND ${extra}` : ""}`
        : extra
          ? `WHERE ${extra}`
          : "";
      return (
        db.prepare(`SELECT COUNT(*) AS c FROM prediction_snapshots ${clause}`).get(...params)
          ?.c ?? 0
      );
    };
    const total = count("");
    const correct = count("status = 'CORRECT'");
    const incorrect = count("status = 'INCORRECT'");
    const pending = count("status = 'PENDING'");
    const voided = count("status = 'VOID'");
    const resolved = correct + incorrect;

    const whereAnd = (extra) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);
    const byOutcome = {};
    for (const o of OUTCOMES) {
      const t = db
        .prepare(
          `SELECT COUNT(*) AS c FROM prediction_snapshots ${whereAnd("predicted_outcome = ?")}`
        )
        .get(...params, o)?.c ?? 0;
      const c = db
        .prepare(
          `SELECT COUNT(*) AS c FROM prediction_snapshots ${whereAnd("predicted_outcome = ? AND status = 'CORRECT'")}`
        )
        .get(...params, o)?.c ?? 0;
      byOutcome[o] = { total: t, correct: c };
    }

    res.json({
      total,
      correct,
      incorrect,
      pending,
      void: voided,
      accuracy:
        resolved >= 10 ? Math.round((correct / resolved) * 1000) / 10 : null,
      accuracyNote:
        resolved >= 10
          ? null
          : `Accuracy is shown once 10+ predictions have been resolved (currently ${resolved}).`,
      byOutcome,
    });
  })
);

// -------------------------------------------------------------- single ---
// GET /api/predictions/:id (registered AFTER the specific routes above)
router.get(
  "/predictions/:id",
  requireProvider,
  asyncHandler(async (req, res) => {
    const row = db
      .prepare("SELECT * FROM prediction_snapshots WHERE id = ? LIMIT 1")
      .get(req.params.id);
    if (!row) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: `Prediction ${req.params.id} not found.` });
    }
    res.json(mapRow(row));
  })
);

// Shared WHERE-builder for history/stats. Returns { where, params } or
// answers 400 itself and returns a falsy where.
function buildFilters(q, res) {
  const conds = [];
  const params = [];
  const fail = (msg) => {
    badRequest(res, msg);
    return { failed: true, where: "", params: [] };
  };

  if (q.date !== undefined) {
    if (!DATE_RE.test(String(q.date))) return fail('Query parameter "date" must be YYYY-MM-DD.');
    conds.push("kickoff_date = ?");
    params.push(String(q.date));
  }
  if (q.status !== undefined) {
    const s = String(q.status).toUpperCase();
    if (!STATUSES.includes(s))
      return fail(`Query parameter "status" must be one of ${STATUSES.join(", ")}.`);
    conds.push("status = ?");
    params.push(s);
  }
  if (q.outcome !== undefined) {
    const o = String(q.outcome).toUpperCase();
    if (!OUTCOMES.includes(o))
      return fail(`Query parameter "outcome" must be one of ${OUTCOMES.join(", ")}.`);
    conds.push("predicted_outcome = ?");
    params.push(o);
  }
  if (q.league !== undefined && String(q.league).trim() !== "") {
    conds.push("league LIKE ?");
    params.push(`%${String(q.league).trim()}%`);
  }
  if (q.from !== undefined) {
    if (!DATE_RE.test(String(q.from))) return fail('Query parameter "from" must be YYYY-MM-DD.');
    conds.push("kickoff_date >= ?");
    params.push(String(q.from));
  }
  if (q.to !== undefined) {
    if (!DATE_RE.test(String(q.to))) return fail('Query parameter "to" must be YYYY-MM-DD.');
    conds.push("kickoff_date <= ?");
    params.push(String(q.to));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return { failed: false, where, params };
}

export default router;
