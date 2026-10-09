-- Telegram broadcast subscribers.
-- Anyone who taps Start on @obulu11bot is recorded here and receives the
-- same cumulative tips + booking-code message as the owner. /stop opts out.
-- Applied as a migration on existing databases (same pattern as the other
-- *-schema.sql files).
CREATE TABLE IF NOT EXISTS telegram_subscribers (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  subscribed_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Stores the Telegram getUpdates offset so a restart doesn't reprocess
-- old updates (and re-send welcome messages).
CREATE TABLE IF NOT EXISTS telegram_update_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_update_id INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO telegram_update_state (id, last_update_id) VALUES (1, 0);
