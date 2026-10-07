-- SportyBet share-booking records.
-- One row per successfully created share booking (slip reservation only —
-- no money moves, nothing is staked). Extends the existing OBULU database;
-- does not touch existing tables. Timestamps are UTC ISO-8601 strings.
-- Postgres path: INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED ALWAYS
-- AS IDENTITY; TEXT stays TEXT; no SQLite-specific functions used.

CREATE TABLE IF NOT EXISTS sportybet_bookings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id           INTEGER NULL,
  fixture_id         TEXT,
  sportybet_event_id TEXT,
  home_team          TEXT,
  away_team          TEXT,
  predicted_outcome  TEXT,
  share_code         TEXT,
  share_url          TEXT,
  deadline           TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sportybet_bookings_alert ON sportybet_bookings (alert_id);
CREATE INDEX IF NOT EXISTS idx_sportybet_bookings_fixture ON sportybet_bookings (fixture_id);
