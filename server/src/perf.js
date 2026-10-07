// OBULU performance core: request deduplication, fetch with timeout+retry,
// stale-while-revalidate caching, and lightweight internal metrics.
//
// All free-tier compatible: in-memory + the existing SQLite cache, no Redis,
// no paid services. Never fabricates data — on total failure callers get
// null/stale and decide how to degrade.

import { cacheGet, cacheSet, cacheGetWithMeta, CACHE_TTLS } from "./cache.js";

// ---------------------------------------------------------------- metrics ---
const metrics = {
  startedAt: new Date().toISOString(),
  apiCalls: 0, // outbound football API calls
  apiErrors: 0,
  apiTotalMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheStaleServed: 0, // SWR: served stale while revalidating
  dedupHits: 0, // requests that joined an in-flight identical request
  predictionsComputed: 0,
  predictionsServedCached: 0,
};

export function recordApiCall(ms, ok) {
  metrics.apiCalls++;
  metrics.apiTotalMs += ms;
  if (!ok) metrics.apiErrors++;
}

export function recordCacheHit() {
  metrics.cacheHits++;
}
export function recordCacheMiss() {
  metrics.cacheMisses++;
}
export function recordStaleServed() {
  metrics.cacheStaleServed++;
}
export function recordDedupHit() {
  metrics.dedupHits++;
}
export function recordPrediction(computed) {
  if (computed) metrics.predictionsComputed++;
  else metrics.predictionsServedCached++;
}

export function getMetrics() {
  const totalCache = metrics.cacheHits + metrics.cacheMisses;
  return {
    ...metrics,
    cacheHitRate:
      totalCache > 0 ? Math.round((metrics.cacheHits / totalCache) * 1000) / 10 : null,
    avgApiMs:
      metrics.apiCalls > 0
        ? Math.round((metrics.apiTotalMs / metrics.apiCalls) * 10) / 10
        : null,
    uptimeSec: Math.round((Date.now() - Date.parse(metrics.startedAt)) / 1000),
  };
}

// ------------------------------------------------------- in-flight dedup ---
// If 10 callers ask for the same key simultaneously, only one executes fn;
// the other 9 share its promise. Entries are removed when settled.
const inflight = new Map();

export function dedup(key, fn) {
  const existing = inflight.get(key);
  if (existing) {
    recordDedupHit();
    return existing;
  }
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ------------------------------------------------- fetch timeout + retry ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeout(
  url,
  options = {},
  { timeoutMs = 20000, retries = 1, retryDelayMs = 1000 } = {}
) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      return { res, ms: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? new Error(`Request timed out after ${timeoutMs}ms`) : e;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// ------------------------------------------------- stale-while-revalidate ---
// getCached(key, ttlName, fetcher, { staleTtlSec }):
//  - fresh cache  -> return immediately (hit)
//  - stale-but-present cache -> return immediately, refresh in background (SWR)
//  - no cache -> await fetcher() (deduped), cache it, return it
//  - fetcher throws + stale exists -> return stale (degraded, never fake)
//  - fetcher throws + nothing -> throw
export async function getCached(key, ttlName, fetcher, { staleTtlSec = 3600 } = {}) {
  const meta = cacheGetWithMeta(key);
  if (meta && !meta.expired) {
    recordCacheHit();
    return { value: meta.value, stale: false };
  }
  if (meta && meta.expired) {
    // Serve stale now; refresh in the background (deduped so only one
    // refresh happens no matter how many callers arrive).
    recordStaleServed();
    dedup(`swr:${key}`, async () => {
      try {
        const fresh = await fetcher();
        cacheSet(key, fresh, ttlName);
      } catch {
        // Background refresh failed: keep serving stale until staleTtl.
      }
    }).catch(() => {});
    // Only serve the stale copy if it is within the stale tolerance.
    // cachedAt is derived: expiresAt - ttl (no cached_at column in schema).
    const ttlSec = CACHE_TTLS[ttlName] ?? 900;
    const cachedAtMs = Date.parse(meta.expiresAt) - ttlSec * 1000;
    const ageSec = (Date.now() - cachedAtMs) / 1000;
    if (ageSec <= ttlSec + staleTtlSec) return { value: meta.value, stale: true };
    // Too old: fall through to a blocking fetch.
  }
  recordCacheMiss();
  const value = await dedup(`fetch:${key}`, fetcher);
  cacheSet(key, value, ttlName);
  return { value, stale: false };
}
