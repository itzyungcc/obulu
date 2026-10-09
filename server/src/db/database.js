// SQLite database bootstrap (node:sqlite, built into Node 24).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB_PATH is resolved relative to the process working directory.
const dbFile = path.resolve(process.cwd(), config.dbPath);
const isNew = !fs.existsSync(dbFile);

fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);

if (isNew) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
}

// Automation tables: applied as a migration on existing databases.
try {
  const hasAuto = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='automation_runs'"
    )
    .get();
  if (!hasAuto) {
    const autoSchema = fs.readFileSync(
      path.join(__dirname, "automation-schema.sql"),
      "utf8"
    );
    db.exec(autoSchema);
  }
} catch (e) {
  console.error("[db] automation schema migration failed:", e.message);
}

// Prediction calendar + live engine tables: applied as a migration on
// existing databases (same pattern as automation-schema.sql).
try {
  const hasCal = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='prediction_snapshots'"
    )
    .get();
  if (!hasCal) {
    const calSchema = fs.readFileSync(
      path.join(__dirname, "calendar-schema.sql"),
      "utf8"
    );
    db.exec(calSchema);
  }
} catch (e) {
  console.error("[db] calendar schema migration failed:", e.message);
}

// SportyBet share-booking records: applied as a migration on existing
// databases (same pattern as automation-schema.sql).
try {
  const hasSb = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sportybet_bookings'"
    )
    .get();
  if (!hasSb) {
    const sbSchema = fs.readFileSync(
      path.join(__dirname, "sportybet-schema.sql"),
      "utf8"
    );
    db.exec(sbSchema);
  }
} catch (e) {
  console.error("[db] sportybet schema migration failed:", e.message);
}

// Telegram broadcast subscribers: applied as a migration on existing
// databases (same pattern as sportybet-schema.sql).
try {
  const hasTg = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_subscribers'"
    )
    .get();
  if (!hasTg) {
    const tgSchema = fs.readFileSync(
      path.join(__dirname, "telegram-schema.sql"),
      "utf8"
    );
    db.exec(tgSchema);
  }
} catch (e) {
  console.error("[db] telegram schema migration failed:", e.message);
}

export { db };

export function closeDb() {
  db.close();
}

// Turso cloud backup (free tier): on boot, restore durable tables from the
// cloud copy (fresh Render disks start empty); then push periodically.
// Both are no-ops unless TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set,
// so local dev and the test suite are unaffected.
const { pullOnBoot, startPeriodicPush } = await import("./turso-sync.js");
await pullOnBoot(db);
startPeriodicPush(db);
