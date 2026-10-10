// SQLite-backed response cache (table: cache_meta).
// TTLs are per data type, keyed by namespaced cache keys.
import { db } from "./db/database.js";

// Cache namespace version. Bump this to invalidate every cached entry at
// once (e.g. after a provider change or if stale/wrong data was ever
// cached). v2: flushed stale sample-provider entries that survived a
// Render deploy on the persistent disk.
const CACHE_VERSION = "v2:";
export { CACHE_VERSION };
const namespaced = (key) => CACHE_VERSION + key;

export const CACHE_TTLS = {
  fixtures: 15 * 60, // 15 min
  teamStats: 6 * 3600, // 6 h
  standings: 6 * 3600, // 6 h
  h2h: 24 * 3600, // 24 h
  odds: 30 * 60, // 30 min
  leagues: 24 * 3600, // 24 h
  live: 120, // 2 min — in-play data goes stale fast; key prefix "live:"
  predictions: 12 * 3600, // 12 h — model outputs; inputs change only when teams play (every few days)
  analysis: 30 * 60, // 30 min — composed match analysis payload
};

export function cacheGet(key) {
  const row = db
    .prepare("SELECT value, expires_at FROM cache_meta WHERE key = ?")
    .get(namespaced(key));
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare("DELETE FROM cache_meta WHERE key = ?").run(namespaced(key));
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
  ).run(namespaced(key), JSON.stringify(value), expiresAt);
  // Opportunistic cleanup of expired rows.
  db.prepare("DELETE FROM cache_meta WHERE expires_at < ?").run(
    new Date().toISOString()
  );
}

// Returns { value, expired, expiresAt } or null. Unlike cacheGet, expired
// rows are returned (not deleted) so callers can do stale-while-revalidate
// or degraded fallback. Callers must handle JSON parsing (value is parsed
// here; returns raw string on parse failure, matching cacheGet behavior).
export function cacheGetWithMeta(key) {
  const row = db
    .prepare("SELECT value, expires_at FROM cache_meta WHERE key = ?")
    .get(namespaced(key));
  if (!row) return null;
  let value;
  try {
    value = JSON.parse(row.value);
  } catch {
    value = row.value;
  }
  return {
    value,
    expired: Date.parse(row.expires_at) < Date.now(),
    expiresAt: row.expires_at,
  };
}

export function cacheInvalidate(prefix) {
  db.prepare("DELETE FROM cache_meta WHERE key LIKE ?").run(namespaced(prefix) + "%");
}
