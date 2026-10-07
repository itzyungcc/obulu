// OBULU Automation Agent — central configuration.
// Every value comes from an environment variable with a spec-defined default.
// Runtime overrides can be stored in the automation_config table via the admin
// API; env vars always win over stored values (explicit beats implicit).

function bool(v, d = false) {
  if (v == null || v === "") return d;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function float(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

function list(v, d = []) {
  if (v == null || String(v).trim() === "") return d;
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const RULE_VERSION = "v1";

export function loadAutomationConfig() {
  return {
    enabled: bool(process.env.AUTOMATION_ENABLED, false),
    dryRun: bool(process.env.AUTOMATION_DRY_RUN, true),
    intervalMinutes: int(process.env.AUTOMATION_INTERVAL_MINUTES, 30),

    // Qualification thresholds (§9 of spec).
    minConfidence: float(process.env.AUTOMATION_MIN_CONFIDENCE, 75),
    minDataCompleteness: float(process.env.AUTOMATION_MIN_DATA_COMPLETENESS, 70),
    minProbability: float(process.env.AUTOMATION_MIN_PROBABILITY, 65),
    minOutcomeMargin: float(process.env.AUTOMATION_MIN_OUTCOME_MARGIN, 20),

    // Volume guards.
    maxMatchesPerRun: int(process.env.AUTOMATION_MAX_MATCHES_PER_RUN, 100),
    maxAlertsPerRun: int(process.env.AUTOMATION_MAX_ALERTS_PER_RUN, 10),
    maxAlertsPerDay: int(process.env.AUTOMATION_MAX_ALERTS_PER_DAY, 20),
    maxConcurrentAnalysis: int(process.env.AUTOMATION_MAX_CONCURRENT_ANALYSIS, 3),

    // Kickoff window (hours before kickoff).
    minHoursBeforeKickoff: float(process.env.AUTOMATION_MIN_HOURS_BEFORE_KICKOFF, 1),
    maxHoursBeforeKickoff: float(process.env.AUTOMATION_MAX_HOURS_BEFORE_KICKOFF, 72),

    // League / outcome filters (empty = allow all).
    allowedLeagues: list(process.env.AUTOMATION_ALLOWED_LEAGUES),
    blockedLeagues: list(process.env.AUTOMATION_BLOCKED_LEAGUES),
    allowedOutcomes: list(process.env.AUTOMATION_ALLOWED_OUTCOMES, ["home", "draw", "away"]),

    // Notifications.
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",

    // Display timezone for notifications/UI (storage is always UTC).
    timezone: process.env.AUTOMATION_TIMEZONE || "Africa/Lagos",

    // SportyBet share-booking creation on qualified alerts (slip reservations
    // only — no wagering). Default true per the 2026-10-07 user authorization.
    sportyBetBookingEnabled: bool(process.env.SPORTYBET_BOOKING_ENABLED, true),

    // Admin key for protected endpoints (empty = open, dev only).
    adminKey: process.env.AUTOMATION_ADMIN_KEY || "",

    ruleVersion: RULE_VERSION,
  };
}

// Keys that are safe to expose via GET /api/automation/config (no secrets).
export const PUBLIC_CONFIG_KEYS = [
  "enabled",
  "dryRun",
  "intervalMinutes",
  "minConfidence",
  "minDataCompleteness",
  "minProbability",
  "minOutcomeMargin",
  "maxMatchesPerRun",
  "maxAlertsPerRun",
  "maxAlertsPerDay",
  "minHoursBeforeKickoff",
  "maxHoursBeforeKickoff",
  "allowedLeagues",
  "blockedLeagues",
  "allowedOutcomes",
  "timezone",
  "ruleVersion",
  "sportyBetBookingEnabled",
];

// Keys allowed to be changed at runtime via PATCH /api/automation/config.
export const MUTABLE_CONFIG_KEYS = [
  "enabled",
  "dryRun",
  "intervalMinutes",
  "minConfidence",
  "minDataCompleteness",
  "minProbability",
  "minOutcomeMargin",
  "maxMatchesPerRun",
  "maxAlertsPerRun",
  "maxAlertsPerDay",
  "minHoursBeforeKickoff",
  "maxHoursBeforeKickoff",
  "allowedLeagues",
  "blockedLeagues",
  "allowedOutcomes",
  "timezone",
  "sportyBetBookingEnabled",
];

// Effective config: env vars first, then runtime overrides from the
// automation_config table (set via the admin API). Secrets always come from
// env only and are never stored in the DB.
export function loadEffectiveConfig(db) {
  const config = loadAutomationConfig();
  if (!db) return config;
  try {
    const rows = db.prepare("SELECT key, value FROM automation_config").all();
    for (const r of rows) {
      if (!MUTABLE_CONFIG_KEYS.includes(r.key)) continue;
      try {
        config[r.key] = JSON.parse(r.value);
      } catch {
        config[r.key] = r.value;
      }
    }
  } catch {
    /* table may not exist yet */
  }
  return config;
}
