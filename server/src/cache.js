// SQLite-backed response cache (table: cache_meta).
// TTLs are per data type, keyed by namespaced cache keys.
import { db } from "./db/database.js";

export const CACHE_TTLS = {
  fixtures: 15 * 60, // 15 min
  teamStats: 6 * 3600, // 6 h
  standings: 6 * 3600, // 6 h
  h2h: 24 * 3600, // 24 h
  odds: 30 * 60, // 30 min
  leagues: 24 * 3600, // 24 h
  live: 120, // 2 min — in-play data goes stale fast; key prefix "live:"
};

export function cacheGet(key) {
  const row = db
    .prepare("SELECT value, expires_at FROM cache_meta WHERE key = ?")
    .get(key);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare("DELETE FROM cache_meta WHERE key = ?").run(key);
    return null;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function cacheSet(key, value, ttlName) {
  const ttl = CACHE_TTLS[ttlName] ?? 900;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  db.prepare(
    `INSERT INTO cache_meta (key, value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
  ).run(key, JSON.stringify(value), expiresAt);
  // Opportunistic cleanup of expired rows.
  db.prepare("DELETE FROM cache_meta WHERE expires_at < ?").run(
    new Date().toISOString()
  );
}

export function cacheInvalidate(prefix) {
  db.prepare("DELETE FROM cache_meta WHERE key LIKE ?").run(prefix + "%");
}
