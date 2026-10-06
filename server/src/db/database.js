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

export { db };

export function closeDb() {
  db.close();
}
