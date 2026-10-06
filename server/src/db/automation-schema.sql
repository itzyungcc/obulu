-- OBULU Automation Agent schema.
-- Extends the existing OBULU database; does not touch existing tables.
-- Timestamps are UTC ISO-8601 strings. Display timezone conversion happens
-- only in notifications/UI (see automationConfig.js).
-- Postgres path: INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED ALWAYS
-- AS IDENTITY; TEXT stays TEXT; no SQLite-specific functions used.

CREATE TABLE IF NOT EXISTS automation_runs (
  id               TEXT PRIMARY KEY,
  started_at       TEXT NOT NULL,
  completed_at     TEXT,
  status           TEXT NOT NULL DEFAULT 'running',
  discovered_count INTEGER NOT NULL DEFAULT 0,
  matched_count    INTEGER NOT NULL DEFAULT 0,
  analyzed_count   INTEGER NOT NULL DEFAULT 0,
  qualified_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count   INTEGER NOT NULL DEFAULT 0,
  alerted_count    INTEGER NOT NULL DEFAULT 0,
  error_count      INTEGER NOT NULL DEFAULT 0,
  dry_run          INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_auto_runs_started ON automation_runs (started_at);

CREATE TABLE IF NOT EXISTS automation_matches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL REFERENCES automation_runs (id),
  source             TEXT NOT NULL DEFAULT 'football-data.org',
  source_match_id    TEXT NOT NULL,
  fixture_id         TEXT,
  home_team          TEXT NOT NULL,
  away_team          TEXT NOT NULL,
  league             TEXT,
  league_id          TEXT,
  kickoff            TEXT NOT NULL,
  match_status       TEXT,
  matching_confidence REAL NOT NULL DEFAULT 1.0,
  match_outcome      TEXT NOT NULL DEFAULT 'pending',
  match_reason       TEXT,
  UNIQUE (run_id, source, source_match_id)
);
CREATE INDEX IF NOT EXISTS idx_auto_matches_fixture ON automation_matches (fixture_id);

CREATE TABLE IF NOT EXISTS automation_predictions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_match_id INTEGER NOT NULL REFERENCES automation_matches (id),
  model_version       TEXT NOT NULL,
  home_probability    REAL NOT NULL,
  draw_probability    REAL NOT NULL,
  away_probability    REAL NOT NULL,
  predicted_outcome   TEXT NOT NULL,
  confidence          REAL NOT NULL,
  data_completeness   REAL NOT NULL,
  expected_home_goals REAL,
  expected_away_goals REAL,
  factors             TEXT,
  blended_with_odds   INTEGER NOT NULL DEFAULT 0,
  qualified           INTEGER NOT NULL DEFAULT 0,
  qualification_reason TEXT,
  evaluated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_pred_match ON automation_predictions (automation_match_id);
CREATE INDEX IF NOT EXISTS idx_auto_pred_qualified ON automation_predictions (qualified);

CREATE TABLE IF NOT EXISTS automation_alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id     INTEGER NOT NULL REFERENCES automation_predictions (id),
  rule_version      TEXT NOT NULL DEFAULT 'v1',
  notification_type TEXT NOT NULL,
  sent_at           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'sent',
  error             TEXT,
  read_at           TEXT,
  -- Duplicate prevention: one alert per prediction + rule version + channel.
  UNIQUE (prediction_id, rule_version, notification_type)
);
CREATE INDEX IF NOT EXISTS idx_auto_alerts_type ON automation_alerts (notification_type, sent_at);

CREATE TABLE IF NOT EXISTS automation_results (
  prediction_id     INTEGER PRIMARY KEY REFERENCES automation_predictions (id),
  home_goals        INTEGER,
  away_goals        INTEGER,
  actual_outcome    TEXT,
  prediction_correct INTEGER,
  resolved_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
