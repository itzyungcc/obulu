// Turso cloud sync — keeps durable tables backed up to a free Turso
// (cloud SQLite) database so Render's ephemeral disk wipes on redeploy
// don't lose prediction history, calendar snapshots, or booking records.
//
// Design notes:
// - Local node:sqlite stays the live database: zero changes to the 50+
//   existing sync query call sites, zero per-request network latency.
// - Only DURABLE_TABLES are synced. High-churn rebuildable tables
//   (cache_meta, team_stats_cache, live_matches) stay local-only.
// - Pull runs once at boot (fresh Render disks restore from Turso).
// - Push is debounced after writes, plus every 15 min, plus on shutdown.
// - Single-writer assumption: one Render instance. Last push wins.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tables whose rows must survive a redeploy. Everything else (HTTP cache,
// team-stats cache, live-engine scratch state) rebuilds itself.
const DURABLE_TABLES = [
  "prediction_snapshots",
  "predictions",
  "automation_runs",
  "automation_alerts",
  "automation_matches",
  "automation_predictions",
  "automation_results",
  "automation_config",
  "sportybet_bookings",
  "fixtures",
  "leagues",
  "teams",
  "results",
];

const SCHEMA_FILES = [
  "schema.sql",
  "automation-schema.sql",
  "calendar-schema.sql",
  "sportybet-schema.sql",
];

const PUSH_DEBOUNCE_MS = 30_000;
const PUSH_INTERVAL_MS = 15 * 60_000;
const BATCH_CHUNK = 400;

let turso = null; // @libsql/client instance (remote only)
let pushTimer = null;
let intervalTimer = null;
let pushing = false;
let pushQueued = false;
let pulledOk = false; // true once a boot pull has completed without error
let lastPullAt = null;
let lastPullRows = 0;
let lastPullError = null;
let lastPushAt = null;
let lastPushError = null;

// Observable sync state (safe for /api/health: no credentials).
export function syncStatus() {
  return {
    enabled: isEnabled(),
    pulledOk,
    lastPullAt,
    lastPullRows,
    lastPullError,
    lastPushAt,
    lastPushError,
  };
}

export function tursoUrl() {
  return (process.env.TURSO_DATABASE_URL || "").trim();
}

export function tursoToken() {
  return (process.env.TURSO_AUTH_TOKEN || "").trim();
}

export function isEnabled() {
  return Boolean(tursoUrl() && tursoToken());
}

async function getClient() {
  if (turso) return turso;
  const { createClient } = await import("@libsql/client");
  turso = createClient({
    url: tursoUrl(),
    authToken: tursoToken(),
  });
  return turso;
}

function localTables(db) {
  try {
    return new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
    );
  } catch {
    return new Set();
  }
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => c.name);
}

async function remoteTables(client) {
  const rs = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table'"
  );
  return new Set(rs.rows.map((r) => r.name));
}

// Strip -- line comments (respecting quoted strings), then split into
// individual statements. The schema files are simple DDL.
function splitStatements(sql) {
  const noComments = sql
    .split("\n")
    .map((line) => {
      let out = "";
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'") inStr = !inStr;
        if (!inStr && ch === "-" && line[i + 1] === "-") break;
        out += ch;
      }
      return out;
    })
    .join("\n");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
async function ensureRemoteSchema() {
  const client = await getClient();
  const existing = await remoteTables(client);
  const missing = DURABLE_TABLES.filter((t) => !existing.has(t));
  if (missing.length === 0) return;
  const statements = [];
  for (const file of SCHEMA_FILES) {
    const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const stmt of splitStatements(sql)) {
      statements.push({ sql: stmt });
    }
  }
  if (statements.length) {
    await client.batch(statements);
    console.log(`[turso] created remote schema (${missing.length} tables)`);
  }
}

// Pull every durable table from Turso into the local DB. Runs once at boot.
// Retries a few times: container boot is the likeliest moment for a
// transient network/DNS blip, and a failed pull must not silently persist.
export async function pullOnBoot(db, maxAttempts = 3) {
  if (!isEnabled()) return;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pullOnce(db);
      return;
    } catch (e) {
      lastPullAt = new Date().toISOString();
      lastPullError = e.message;
      console.error(
        `[turso] boot pull attempt ${attempt}/${maxAttempts} failed:`,
        e.message
      );
      if (attempt < maxAttempts) await sleep(5000 * attempt);
    }
  }
  console.error("[turso] boot pull failed (continuing with local DB)");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pullOnce(db) {
  await ensureRemoteSchema();
    const client = await getClient();
    const have = localTables(db);
    let total = 0;
    for (const table of DURABLE_TABLES) {
      if (!have.has(table)) continue; // local schema should already exist
      const rs = await client.execute(`SELECT * FROM "${table}"`);
      const rows = rs.rows;
      if (rows.length === 0) continue;
      const cols = tableColumns(db, table).filter((c) =>
        Object.prototype.hasOwnProperty.call(rows[0], c)
      );
      if (cols.length === 0) continue;
      const placeholders = cols.map(() => "?").join(", ");
      const quoted = cols.map((c) => `"${c}"`).join(", ");
      const insert = db.prepare(
        `INSERT OR REPLACE INTO "${table}" (${quoted}) VALUES (${placeholders})`
      );
      const del = db.prepare(`DELETE FROM "${table}"`);
      db.exec("BEGIN");
      try {
        del.run();
        for (const row of rows) insert.run(...cols.map((c) => row[c] ?? null));
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
      total += rows.length;
    }
    console.log(`[turso] boot pull complete: ${total} rows restored`);
    pulledOk = true;
    lastPullAt = new Date().toISOString();
    lastPullRows = total;
    lastPullError = null;
}

// Push durable tables to Turso. Tables omitted from `only` are skipped.
// Safety: never push before a successful pull — a failed pull followed by a
// push would overwrite the good cloud copy with stale/empty local data.
export async function pushToTurso(db, only = null) {
  if (!isEnabled()) return;
  if (!pulledOk) {
    console.log("[turso] pull not yet confirmed; re-attempting pull before push");
    await pullOnBoot(db);
    if (!pulledOk) {
      console.error("[turso] push skipped: cloud state not yet confirmed");
      return;
    }
  }
  if (pushing) {
    pushQueued = true;
    return;
  }
  pushing = true;
  try {
    await ensureRemoteSchema();
    const client = await getClient();
    const have = localTables(db);
    const tables = DURABLE_TABLES.filter(
      (t) => have.has(t) && (!only || only.includes(t))
    );
    // Whole push runs in one remote transaction: either the cloud mirror is
    // fully replaced or untouched — no half-empty state if we crash midway.
    // Phase 1: deletes, children before parents (reversed table order).
    // Phase 2: inserts, parents before children (DURABLE_TABLES order).
    // Both orderings keep the automation_* foreign keys satisfied.
    const tx = await client.transaction("write");
    try {
      for (const table of [...tables].reverse()) {
        await tx.execute(`DELETE FROM "${table}"`);
      }
      for (const table of tables) {
        const cols = tableColumns(db, table);
        if (cols.length === 0) continue;
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        if (rows.length === 0) continue;
        const quoted = cols.map((c) => `"${c}"`).join(", ");
        const placeholders = cols.map(() => "?").join(", ");
        const statements = [];
        for (const row of rows) {
          statements.push({
            sql: `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`,
            args: cols.map((c) => row[c] ?? null),
          });
        }
        for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
          await tx.batch(statements.slice(i, i + BATCH_CHUNK));
        }
      }
      await tx.commit();
    } catch (e) {
      try {
        await tx.rollback();
      } catch { /* ignore */ }
      throw e;
    } finally {
      try {
        tx.close();
      } catch { /* ignore */ }
    }
    console.log("[turso] push complete");
    lastPushAt = new Date().toISOString();
    lastPushError = null;
  } catch (e) {
    lastPushAt = new Date().toISOString();
    lastPushError = e.message;
    console.error("[turso] push failed (will retry on next trigger):", e.message);
  } finally {
    pushing = false;
    if (pushQueued) {
      pushQueued = false;
      schedulePush(db, 5_000);
    }
  }
}

// Mark data dirty: a push goes out after a short debounce (coalesces bursts).
export function schedulePush(db, delayMs = PUSH_DEBOUNCE_MS) {
  if (!isEnabled()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushToTurso(db).catch(() => {});
  }, delayMs);
  if (pushTimer.unref) pushTimer.unref();
}

// Start the periodic background push. Call once after boot pull.
export function startPeriodicPush(db) {
  if (!isEnabled() || intervalTimer) return;
  intervalTimer = setInterval(() => {
    pushToTurso(db).catch(() => {});
  }, PUSH_INTERVAL_MS);
  if (intervalTimer.unref) intervalTimer.unref();
}

export function stopPeriodicPush() {
  if (pushTimer) clearTimeout(pushTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  pushTimer = intervalTimer = null;
}
