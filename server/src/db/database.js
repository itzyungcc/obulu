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

export { db };

export function closeDb() {
  db.close();
}
