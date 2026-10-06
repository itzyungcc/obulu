-- OBULU Prediction Calendar schema.
-- prediction_snapshots: one immutable pre-match prediction per fixture
-- (first snapshot wins — INSERT OR IGNORE on fixture_id; never overwritten).
-- Resolved later to CORRECT/INCORRECT/VOID by the result resolver.
-- live_final_* columns hold the live engine's final verdict for comparison.
-- Timestamps are UTC ISO-8601 strings; kickoff_date is the calendar day in
-- Africa/Lagos (UTC+1, no DST).
-- Postgres path: INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED
-- ALWAYS AS IDENTITY; TEXT stays TEXT; no SQLite-specific functions used.

CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id          TEXT NOT NULL UNIQUE,
  home_team           TEXT NOT NULL,
  away_team           TEXT NOT NULL,
  league              TEXT,
  country             TEXT,
  kickoff             TEXT NOT NULL,
  kickoff_date        TEXT NOT NULL,
  predicted_at        TEXT NOT NULL,
  home_win            REAL NOT NULL,
  draw                REAL NOT NULL,
  away_win            REAL NOT NULL,
  predicted_outcome   TEXT NOT NULL,
  confidence_score    REAL,
  confidence_label    TEXT,
  data_completeness   REAL,
  expected_home_goals REAL,
  expected_away_goals REAL,
  factors             TEXT,
  model_version       TEXT NOT NULL,
  blended_with_odds   INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  actual_home_score   INTEGER,
  actual_away_score   INTEGER,
  actual_outcome      TEXT,
  resolved_at         TEXT,
  live_final_home     REAL,
  live_final_draw     REAL,
  live_final_away     REAL,
  live_final_outcome  TEXT,
  live_correct        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_kickoff_date ON prediction_snapshots (kickoff_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_status ON prediction_snapshots (status);

-- live_predictions: periodic in-play probability snapshots, written only
-- when the picture materially changes (first sighting, |Δp| ≥ threshold,
-- goal/red-card change, or max gap elapsed).
CREATE TABLE IF NOT EXISTS live_predictions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id        TEXT NOT NULL,
  minute            INTEGER,
  minute_source     TEXT,
  score_home        INTEGER,
  score_away        INTEGER,
  red_home          INTEGER NOT NULL DEFAULT 0,
  red_away          INTEGER NOT NULL DEFAULT 0,
  home_win          REAL NOT NULL,
  draw              REAL NOT NULL,
  away_win          REAL NOT NULL,
  predicted_outcome TEXT NOT NULL,
  confidence_score  REAL,
  confidence_label  TEXT,
  factors           TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_predictions_fixture ON live_predictions (fixture_id, created_at);

-- live_matches: which fixtures the live engine is currently tracking.
CREATE TABLE IF NOT EXISTS live_matches (
  fixture_id  TEXT PRIMARY KEY,
  home_team   TEXT,
  away_team   TEXT,
  league      TEXT,
  kickoff     TEXT,
  status      TEXT NOT NULL DEFAULT 'TRACKING',
  last_seen   TEXT NOT NULL,
  finished_at TEXT
);
