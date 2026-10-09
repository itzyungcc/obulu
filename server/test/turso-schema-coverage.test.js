// Turso schema-coverage regression test — plain node asserts.
// Reproduces the 2026-10-09 production failure: the Telegram broadcast
// commit added telegram_subscribers / telegram_update_state to DURABLE_TABLES
// but forgot telegram-schema.sql in SCHEMA_FILES, so ensureRemoteSchema()
// never created those tables on Turso. Every boot pull then failed with
// "no such table: telegram_subscribers", pulledOk stayed false, and the
// push safety gate stalled the ENTIRE cloud backup (lastPushAt: null).
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DURABLE_TABLES, SCHEMA_FILES } from "../src/db/turso-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(__dirname, "..", "src", "db");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Every durable table must have a CREATE TABLE in at least one schema file
// that ensureRemoteSchema() actually applies.
await check("all DURABLE_TABLES are covered by SCHEMA_FILES", () => {
  const covered = new Set();
  for (const file of SCHEMA_FILES) {
    const sql = fs.readFileSync(path.join(dbDir, file), "utf8");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi)) {
      covered.add(m[1]);
    }
  }
  const missing = DURABLE_TABLES.filter((t) => !covered.has(t));
  assert.deepStrictEqual(missing, [], `tables missing remote schema: ${missing.join(", ")}`);
});

// Every schema file referenced must exist on disk.
await check("all SCHEMA_FILES exist on disk", () => {
  for (const file of SCHEMA_FILES) {
    assert.ok(
      fs.existsSync(path.join(dbDir, file)),
      `schema file missing: ${file}`
    );
  }
});

console.log(`\nturso-schema-coverage: ${passed} checks passed.`);
