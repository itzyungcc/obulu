-- OBULU schema.
-- Written for node:sqlite (SQLite). Postgres path: these tables map 1:1 to
-- Postgres; replace `TEXT PRIMARY KEY` with TEXT PRIMARY KEY (same),
-- `INTEGER PRIMARY KEY AUTOINCREMENT` with BIGINT GENERATED ALWAYS AS IDENTITY,
-- and JSON columns can move from TEXT to JSONB. No SQLite-specific functions
-- are used in the schema itself.

CREATE TABLE IF NOT EXISTS leagues (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  country    TEXT,
  logo       TEXT,
  season     TEXT,
  sample     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  league_id  TEXT,
  name       TEXT NOT NULL,
  country    TEXT,
  logo       TEXT,
  sample     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fixtures (
  id         TEXT PRIMARY KEY,
  league_id  TEXT,
  home_id    TEXT,
  away_id    TEXT,
  kickoff    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'NS',
  venue      TEXT,
  referee    TEXT,
  sample     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff ON fixtures (kickoff);
CREATE INDEX IF NOT EXISTS idx_fixtures_league  ON fixtures (league_id);

CREATE TABLE IF NOT EXISTS results (
  fixture_id TEXT PRIMARY KEY,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_stats_cache (
  team_id     TEXT PRIMARY KEY,
  stats_json  TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id          TEXT NOT NULL,
  home_win          REAL NOT NULL,
  draw              REAL NOT NULL,
  away_win          REAL NOT NULL,
  outcome           TEXT NOT NULL,
  model_version     TEXT NOT NULL,
  blended_with_odds INTEGER NOT NULL DEFAULT 0,
  data_completeness REAL NOT NULL DEFAULT 0,
  sample            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions (match_id);

CREATE TABLE IF NOT EXISTS cache_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
