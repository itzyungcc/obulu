// OBULU Automation Agent — admin/monitoring API.
// All responses are JSON. Informational only — no betting content.
// Read endpoints are open (same posture as the rest of the OBULU API).
// Mutating endpoints (manual run, config changes) require the admin key when
// AUTOMATION_ADMIN_KEY is set; otherwise they log a warning (dev mode).

import { Router } from "express";
import { db } from "../db/database.js";
import {
  loadAutomationConfig,
  PUBLIC_CONFIG_KEYS,
  MUTABLE_CONFIG_KEYS,
} from "../automation/automationConfig.js";
import { runAutomation } from "../automation/runner.js";
import { schedulerStatus } from "../automation/scheduler.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function requireAdmin(req, res, next) {
  const config = loadAutomationConfig();
  if (!config.adminKey) {
    console.warn("[Automation] admin endpoint used without AUTOMATION_ADMIN_KEY set");
    return next();
  }
  const provided = req.headers["x-admin-key"] || req.query.admin_key;
  if (provided !== config.adminKey) {
    return res.status(403).json({ error: "FORBIDDEN", message: "Valid X-Admin-Key required." });
  }
  next();
}

function publicConfig() {
  const config = loadAutomationConfig();
  const out = {};
  for (const k of PUBLIC_CONFIG_KEYS) out[k] = config[k];

  // Overlay runtime overrides stored in automation_config.
  try {
    const rows = db.prepare("SELECT key, value FROM automation_config").all();
    for (const r of rows) {
      if (!PUBLIC_CONFIG_KEYS.includes(r.key)) continue;
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
  } catch {
    /* table may not exist yet on very old DBs */
  }

  // Telegram configured? (boolean only — never the secret)
  out.telegramConfigured = Boolean(config.telegramBotToken && config.telegramChatId);
  return out;
}

// ------------------------------------------------------------ status ---
router.get(
  "/automation/status",
  asyncHandler(async (_req, res) => {
    const config = loadAutomationConfig();
    const lastRun = db
      .prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 1")
      .get() || null;
    const unread = db
      .prepare(
        `SELECT COUNT(*) AS c FROM automation_alerts
         WHERE notification_type = 'in_app' AND read_at IS NULL`
      )
      .get();
    res.json({
      enabled: config.enabled,
      dryRun: config.dryRun,
      scheduler: schedulerStatus(),
      intervalMinutes: config.intervalMinutes,
      lastRun,
      unreadNotifications: unread?.c ?? 0,
    });
  })
);

// --------------------------------------------------------------- run ---
router.post(
  "/automation/run",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const result = await runAutomation({ manual: true });
    res.json(result);
  })
);

// -------------------------------------------------------------- runs ---
router.get(
  "/automation/runs",
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const runs = db
      .prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit);
    res.json({ runs });
  })
);

router.get(
  "/automation/runs/:id",
  asyncHandler(async (req, res) => {
    const run = db
      .prepare("SELECT * FROM automation_runs WHERE id = ?")
      .get(req.params.id);
    if (!run) return res.status(404).json({ error: "NOT_FOUND" });
    const matches = db
      .prepare(
        `SELECT m.*, p.home_probability, p.draw_probability, p.away_probability,
                p.predicted_outcome, p.confidence, p.data_completeness,
                p.qualified, p.qualification_reason
         FROM automation_matches m
         LEFT JOIN automation_predictions p ON p.automation_match_id = m.id
         WHERE m.run_id = ?
         ORDER BY m.kickoff ASC`
      )
      .all(req.params.id);
    res.json({ run, matches });
  })
);

// --------------------------------------------------------- qualified ---
router.get(
  "/automation/qualified",
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const rows = db
      .prepare(
        `SELECT p.id AS prediction_id, p.*, m.home_team, m.away_team, m.league,
                m.kickoff, m.fixture_id, m.run_id,
                (SELECT COUNT(*) FROM automation_alerts a
                  WHERE a.prediction_id = p.id AND a.status = 'sent') AS alerts_sent
         FROM automation_predictions p
         JOIN automation_matches m ON m.id = p.automation_match_id
         WHERE p.qualified = 1
         ORDER BY p.evaluated_at DESC
         LIMIT ?`
      )
      .all(limit);
    res.json({ qualified: rows });
  })
);

// ----------------------------------------------------- notifications ---
router.get(
  "/automation/notifications",
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const rows = db
      .prepare(
        `SELECT a.id, a.notification_type, a.sent_at, a.status, a.read_at,
                p.predicted_outcome, p.home_probability, p.draw_probability,
                p.away_probability, p.confidence, p.data_completeness,
                p.expected_home_goals, p.expected_away_goals, p.model_version,
                m.home_team, m.away_team, m.league, m.kickoff, m.fixture_id
         FROM automation_alerts a
         JOIN automation_predictions p ON p.id = a.prediction_id
         JOIN automation_matches m ON m.id = p.automation_match_id
         WHERE a.notification_type = 'in_app'
         ORDER BY a.sent_at DESC
         LIMIT ?`
      )
      .all(limit);
    res.json({ notifications: rows });
  })
);

router.post(
  "/automation/notifications/:id/read",
  asyncHandler(async (req, res) => {
    db.prepare(
      "UPDATE automation_alerts SET read_at = ? WHERE id = ? AND notification_type = 'in_app'"
    ).run(new Date().toISOString(), req.params.id);
    res.json({ ok: true });
  })
);

router.post(
  "/automation/notifications/read-all",
  asyncHandler(async (_req, res) => {
    db.prepare(
      "UPDATE automation_alerts SET read_at = ? WHERE notification_type = 'in_app' AND read_at IS NULL"
    ).run(new Date().toISOString());
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------ history ---
router.get(
  "/automation/history",
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const rows = db
      .prepare(
        `SELECT p.id AS prediction_id, p.predicted_outcome, p.home_probability,
                p.draw_probability, p.away_probability, p.confidence,
                p.data_completeness, p.qualified, p.evaluated_at, p.model_version,
                m.home_team, m.away_team, m.league, m.kickoff,
                r.home_goals, r.away_goals, r.actual_outcome, r.prediction_correct
         FROM automation_predictions p
         JOIN automation_matches m ON m.id = p.automation_match_id
         LEFT JOIN automation_results r ON r.prediction_id = p.id
         ORDER BY p.evaluated_at DESC
         LIMIT ?`
      )
      .all(limit);
    res.json({ history: rows });
  })
);

// ------------------------------------------------------------- config ---
router.get(
  "/automation/config",
  asyncHandler(async (_req, res) => {
    res.json({ config: publicConfig() });
  })
);

router.patch(
  "/automation/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const updated = [];
    const now = new Date().toISOString();
    for (const key of MUTABLE_CONFIG_KEYS) {
      if (!(key in body)) continue;
      db.prepare(
        `INSERT INTO automation_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, JSON.stringify(body[key]), now);
      updated.push(key);
    }
    res.json({ ok: true, updated, config: publicConfig() });
  })
);

export default router;
