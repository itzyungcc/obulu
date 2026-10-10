// OBULU Admin Control Center — settings and operational controls.
// Every route requires a valid admin session. All changes are validated
// server-side and written to the audit log.

import { Router } from "express";
import { db } from "../db/database.js";
import {
  requireAdminSession,
  auditLog,
  clientIp,
} from "../admin/middleware.js";
import { loadEffectiveConfig, MUTABLE_CONFIG_KEYS } from "../automation/automationConfig.js";
import { startScheduler, stopScheduler, schedulerStatus } from "../automation/scheduler.js";
import { startResolver, stopResolver } from "../calendar/resolver.js";
import { startLiveEngine, stopLiveEngine, getEngineStatus } from "../live/engine.js";
import { startSubscriberPoller, stopSubscriberPoller } from "../telegram/subscribers.js";
import { startOpenFootballSync, stopOpenFootballSync, syncStatus } from "../openfootball/sync.js";

const router = Router();
router.use(requireAdminSession);

// ---------------------------------------------------------------------------
// Admin-managed settings keys (beyond automation's MUTABLE_CONFIG_KEYS).
// Stored in automation_config; validated below.
// ---------------------------------------------------------------------------
const ADMIN_SETTINGS_SCHEMA = {
  // Prediction
  minConfidence: { type: "number", min: 0, max: 100 },
  minProbability: { type: "number", min: 0, max: 100 },
  minDataCompleteness: { type: "number", min: 0, max: 100 },
  minOutcomeMargin: { type: "number", min: 0, max: 100 },
  marketThresholds: { type: "json" }, // { over25: 60, bttsYes: 55, ... }
  enabledMarkets: { type: "json" }, // ["over25","bttsYes",...] or null = all
  predictionGenerationEnabled: { type: "boolean" },
  predictionPublishEnabled: { type: "boolean" },
  // Automation
  automationEnabled: { type: "boolean" },
  automationIntervalMinutes: { type: "number", min: 5, max: 1440 },
  // Assistant
  assistantEnabled: { type: "boolean" },
  assistantMaintenanceMessage: { type: "string", max: 500 },
  assistantFallbackMessage: { type: "string", max: 500 },
  assistantTimeoutMs: { type: "number", min: 5000, max: 120000 },
  assistantMaxLength: { type: "number", min: 100, max: 8000 },
  // Ops
  maintenanceMode: { type: "boolean" },
  maintenanceMessage: { type: "string", max: 500 },
  // Feature flags (module on/off)
  featureLive: { type: "boolean" },
  featureCalendar: { type: "boolean" },
  featureJackpot: { type: "boolean" },
  featureAssistant: { type: "boolean" },
  featureAutomation: { type: "boolean" },
};

const DEFAULTS = {
  minConfidence: 30,
  minProbability: 20,
  minDataCompleteness: 20,
  minOutcomeMargin: 20,
  marketThresholds: {},
  enabledMarkets: null,
  predictionGenerationEnabled: true,
  predictionPublishEnabled: true,
  automationEnabled: true,
  automationIntervalMinutes: 60,
  assistantEnabled: true,
  assistantMaintenanceMessage: "The assistant is under maintenance. Please try again shortly.",
  assistantFallbackMessage: "Sorry, I couldn't get an answer just now. Please try again in a moment.",
  assistantTimeoutMs: 40000,
  assistantMaxLength: 2000,
  maintenanceMode: false,
  maintenanceMessage: "OBULU is under maintenance. We'll be back shortly.",
  featureLive: true,
  featureCalendar: true,
  featureJackpot: true,
  featureAssistant: true,
  featureAutomation: true,
};

function validateSetting(key, value) {
  const schema = ADMIN_SETTINGS_SCHEMA[key];
  if (!schema) return { ok: false, error: `Unknown setting: ${key}` };
  if (schema.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
    if (schema.min !== undefined && n < schema.min) return { ok: false, error: `${key} must be >= ${schema.min}` };
    if (schema.max !== undefined && n > schema.max) return { ok: false, error: `${key} must be <= ${schema.max}` };
    return { ok: true, value: n };
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, error: `${key} must be true/false` };
    return { ok: true, value };
  }
  if (schema.type === "string") {
    const s = String(value || "");
    if (schema.max && s.length > schema.max) return { ok: false, error: `${key} too long (max ${schema.max})` };
    return { ok: true, value: s };
  }
  if (schema.type === "json") {
    if (value !== null && typeof value !== "object") return { ok: false, error: `${key} must be an object or null` };
    return { ok: true, value };
  }
  return { ok: false, error: `Bad schema for ${key}` };
}

export function getAdminSetting(key) {
  const def = DEFAULTS[key];
  try {
    const row = db.prepare("SELECT value FROM automation_config WHERE key = ?").get(`admin:${key}`);
    if (!row) return def;
    const parsed = JSON.parse(row.value);
    const v = validateSetting(key, parsed);
    return v.ok ? v.value : def;
  } catch {
    return def;
  }
}

export function getAllAdminSettings() {
  const out = {};
  for (const key of Object.keys(ADMIN_SETTINGS_SCHEMA)) {
    out[key] = getAdminSetting(key);
  }
  return out;
}

function setAdminSetting(key, value) {
  const v = validateSetting(key, value);
  if (!v.ok) throw new Error(v.error);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO automation_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(`admin:${key}`, JSON.stringify(v.value), now);
  return v.value;
}

// ---------------------------------------------------------------------------
// GET /api/admin/settings — all settings + live job states
// ---------------------------------------------------------------------------
router.get("/settings", (req, res) => {
  const settings = getAllAdminSettings();
  // Also surface the effective automation config for transparency.
  const auto = loadEffectiveConfig(db);
  res.json({
    settings,
    automation: {
      enabled: auto.enabled,
      intervalMinutes: auto.intervalMinutes,
      schedulerRunning: schedulerStatus().running,
    },
    jobs: getJobStates(),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/settings — Body: { key: value, ... }
// ---------------------------------------------------------------------------
router.patch("/settings", (req, res) => {
  const ip = clientIp(req);
  const body = req.body || {};
  const updated = [];
  const errors = [];

  for (const [key, value] of Object.entries(body)) {
    if (!(key in ADMIN_SETTINGS_SCHEMA)) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    try {
      const oldVal = getAdminSetting(key);
      const newVal = setAdminSetting(key, value);
      updated.push(key);
      auditLog({
        userId: req.admin.userId,
        username: req.admin.username,
        action: "admin.settings.update",
        target: key,
        detail: `from ${JSON.stringify(oldVal)} to ${JSON.stringify(newVal)}`,
        outcome: "success",
        ip,
      });
      applySettingSideEffect(key, newVal);
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
      auditLog({
        userId: req.admin.userId,
        username: req.admin.username,
        action: "admin.settings.update",
        target: key,
        outcome: `failed: ${e.message}`,
        ip,
      });
    }
  }

  res.json({ ok: errors.length === 0, updated, errors, settings: getAllAdminSettings() });
});

// Apply immediate side effects for settings that control running jobs.
function applySettingSideEffect(key, value) {
  try {
    if (key === "automationEnabled") {
      if (value) startScheduler();
      else stopScheduler();
    }
    if (key === "featureLive") {
      if (value) startLiveEngine();
      else stopLiveEngine();
    }
  } catch (e) {
    console.error(`[admin] side effect failed for ${key}:`, e.message);
  }
}

function getJobStates() {
  const states = {};
  try { states.scheduler = schedulerStatus().running; } catch { states.scheduler = null; }
  try { states.liveEngine = getEngineStatus()?.running ?? null; } catch { states.liveEngine = null; }
  try { states.openfootball = syncStatus()?.running ?? syncStatus(); } catch { states.openfootball = null; }
  return states;
}

// ---------------------------------------------------------------------------
// GET /api/admin/jobs — live state of all background jobs
// ---------------------------------------------------------------------------
router.get("/jobs", (req, res) => {
  res.json({ jobs: getJobStates(), at: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /api/admin/jobs/:name/:action — start|stop a job
// ---------------------------------------------------------------------------
const JOB_CONTROLS = {
  scheduler: { start: startScheduler, stop: stopScheduler },
  resolver: { start: startResolver, stop: stopResolver },
  live: { start: startLiveEngine, stop: stopLiveEngine },
  subscriberPoller: { start: startSubscriberPoller, stop: stopSubscriberPoller },
  openfootball: { start: startOpenFootballSync, stop: stopOpenFootballSync },
};

router.post("/jobs/:name/:action", (req, res) => {
  const ip = clientIp(req);
  const { name, action } = req.params;
  const ctrl = JOB_CONTROLS[name];
  if (!ctrl || (action !== "start" && action !== "stop")) {
    return res.status(400).json({ error: "BAD_REQUEST", message: "Unknown job or action." });
  }
  try {
    const result = action === "start" ? ctrl.start() : ctrl.stop();
    auditLog({
      userId: req.admin.userId,
      username: req.admin.username,
      action: `admin.jobs.${action}`,
      target: name,
      outcome: "success",
      ip,
    });
    res.json({ ok: true, job: name, action, result: !!result, jobs: getJobStates() });
  } catch (e) {
    auditLog({
      userId: req.admin.userId,
      username: req.admin.username,
      action: `admin.jobs.${action}`,
      target: name,
      outcome: `failed: ${e.message}`,
      ip,
    });
    res.status(500).json({ error: "JOB_FAILED", message: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/predictions/refresh — clear prediction/analysis cache
// ---------------------------------------------------------------------------
router.post("/predictions/refresh", (req, res) => {
  const ip = clientIp(req);
  try {
    const result = db.prepare(
      `DELETE FROM cache_meta WHERE key LIKE 'v2:%predictions%' OR key LIKE 'v2:%analysis%' OR key LIKE '%predictions%' OR key LIKE '%analysis%'`
    ).run();
    auditLog({
      userId: req.admin.userId,
      username: req.admin.username,
      action: "admin.predictions.refresh",
      outcome: `success: cleared ${result.changes} cache entries`,
      ip,
    });
    res.json({ ok: true, cleared: result.changes });
  } catch (e) {
    auditLog({
      userId: req.admin.userId,
      username: req.admin.username,
      action: "admin.predictions.refresh",
      outcome: `failed: ${e.message}`,
      ip,
    });
    res.status(500).json({ error: "REFRESH_FAILED", message: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/emergency-pause — stop ALL background jobs at once
// POST /api/admin/emergency-resume — restart them
// ---------------------------------------------------------------------------
router.post("/emergency-pause", (req, res) => {
  const ip = clientIp(req);
  const stopped = [];
  for (const [name, ctrl] of Object.entries(JOB_CONTROLS)) {
    try { ctrl.stop(); stopped.push(name); } catch (e) { /* continue */ }
  }
  auditLog({
    userId: req.admin.userId,
    username: req.admin.username,
    action: "admin.emergency.pause",
    outcome: `success: stopped ${stopped.join(", ")}`,
    ip,
  });
  res.json({ ok: true, stopped, jobs: getJobStates() });
});

router.post("/emergency-resume", (req, res) => {
  const ip = clientIp(req);
  const started = [];
  // Respect the persisted desired state: only restart jobs whose
  // feature/automation flags are on.
  const s = getAllAdminSettings();
  const want = {
    scheduler: s.automationEnabled,
    resolver: true,
    live: s.featureLive,
    subscriberPoller: true,
    openfootball: true,
  };
  for (const [name, ctrl] of Object.entries(JOB_CONTROLS)) {
    if (!want[name]) continue;
    try { ctrl.start(); started.push(name); } catch (e) { /* continue */ }
  }
  auditLog({
    userId: req.admin.userId,
    username: req.admin.username,
    action: "admin.emergency.resume",
    outcome: `success: started ${started.join(", ")}`,
    ip,
  });
  res.json({ ok: true, started, jobs: getJobStates() });
});

// ---------------------------------------------------------------------------
// GET /api/admin/audit — recent audit log entries
// ---------------------------------------------------------------------------
router.get("/audit", (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = db.prepare(
    `SELECT id, username, action, target, detail, outcome, ip, created_at
     FROM admin_audit_log ORDER BY id DESC LIMIT ?`
  ).all(limit);
  res.json({ entries: rows });
});

// ---------------------------------------------------------------------------
// GET /api/admin/system — system status overview
// ---------------------------------------------------------------------------
router.get("/system", (req, res) => {
  const settings = getAllAdminSettings();
  let dbOk = true;
  try { db.prepare("SELECT 1").get(); } catch { dbOk = false; }

  // Recent automation runs.
  let recentRuns = [];
  try {
    recentRuns = db.prepare(
      `SELECT id, started_at, completed_at, status, qualified_count, alerted_count, error_count
       FROM automation_runs ORDER BY started_at DESC LIMIT 5`
    ).all();
  } catch { /* ignore */ }

  // Assistant health is exposed via the existing public
  // /api/assistant/diagnostics endpoint; the dashboard calls it directly.

  res.json({
    at: new Date().toISOString(),
    database: dbOk ? "ok" : "error",
    maintenanceMode: settings.maintenanceMode,
    jobs: getJobStates(),
    recentRuns,
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
  });
});

export default router;
