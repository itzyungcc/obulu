-- OpenFootball historical results (openfootball/football.json, public domain).
-- Synced nightly from GitHub raw URLs — no API key, no rate limits.
-- Used as the primary source for team historical stats in predictions;
-- the provider API remains the fallback (and the only source for live data).
-- Applied as a migration on existing databases.
CREATE TABLE IF NOT EXISTS openfootball_results (
  league_code TEXT NOT NULL,      -- 'en.1', 'es.1', ... (football.json file key)
  season TEXT NOT NULL,           -- '2025-26', '2026-27'
  competition_id INTEGER,         -- football-data.org competition id (2021, ...)
  match_date TEXT NOT NULL,       -- YYYY-MM-DD
  round TEXT,
  team1 TEXT NOT NULL,            -- as named by openfootball
  team2 TEXT NOT NULL,
  team1_key TEXT NOT NULL,        -- normalized via normalizeTeamName
  team2_key TEXT NOT NULL,
  ft_home INTEGER,
  ft_away INTEGER,
  ht_home INTEGER,
  ht_away INTEGER,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (league_code, season, match_date, team1_key, team2_key)
);
CREATE INDEX IF NOT EXISTS idx_ofb_team_date
  ON openfootball_results (team1_key, match_date);
CREATE INDEX IF NOT EXISTS idx_ofb_team2_date
  ON openfootball_results (team2_key, match_date);
CREATE INDEX IF NOT EXISTS idx_ofb_league
  ON openfootball_results (league_code, season);

-- Sync state: one row, tracks the last successful sync.
CREATE TABLE IF NOT EXISTS openfootball_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at TEXT,
  matches_synced INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT OR IGNORE INTO openfootball_sync_state (id) VALUES (1);
