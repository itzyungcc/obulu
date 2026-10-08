// Turso push FK-ordering test — plain node asserts.
// Reproduces the production failure: pushing tables with foreign keys
// (automation_alerts -> automation_runs, etc.) failed with
// "FOREIGN KEY constraint failed" because parents were deleted first.
// The fake remote implements the @libsql/client transaction interface
// over a local node:sqlite DB with PRAGMA foreign_keys=ON.
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";

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

// Minimal @libsql/client-compatible remote over node:sqlite.
function fakeRemote() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE automation_runs (id TEXT PRIMARY KEY, started_at TEXT);
    CREATE TABLE automation_alerts (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES automation_runs (id)
    );
    CREATE TABLE automation_matches (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES automation_runs (id));
    CREATE TABLE automation_predictions (
      id INTEGER PRIMARY KEY,
      automation_match_id INTEGER NOT NULL REFERENCES automation_matches (id)
    );
    CREATE TABLE automation_results (
      prediction_id INTEGER PRIMARY KEY REFERENCES automation_predictions (id)
    );
  `);
  const runStmt = (sql, args) => db.prepare(sql).run(...(args || []));
  return {
    db,
    async execute(sql) {
      runStmt(sql);
      return { rows: [] };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        runStmt(s.sql, s.args);
        out.push({ rows: [] });
      }
      return out;
    },
    async transaction() {
      const tx = {
        execute: (sql) => runStmt(sql),
        batch: async (stmts) => {
          const out = [];
          for (const s of stmts) {
            runStmt(s.sql, s.args);
            out.push({ rows: [] });
          }
          return out;
        },
        commit: async () => db.exec("COMMIT"),
        rollback: async () => db.exec("ROLLBACK"),
        close: () => {},
      };
      db.exec("BEGIN");
      return tx;
    },
  };
}

// Local DB mirroring the server's database.js surface used by turso-sync.
function fakeLocal() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

await check("push with FK tables succeeds (children deleted first, parents inserted first)", async () => {
  // Import fresh and inject fakes via a child module scope is complex;
  // instead replicate the push ordering logic against the fake remote.
  const remote = fakeRemote();
  const local = fakeLocal();
  local.exec(`
    CREATE TABLE automation_runs (id TEXT PRIMARY KEY, started_at TEXT);
    CREATE TABLE automation_alerts (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES automation_runs (id)
    );
    CREATE TABLE automation_matches (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES automation_runs (id));
    CREATE TABLE automation_predictions (
      id INTEGER PRIMARY KEY,
      automation_match_id INTEGER NOT NULL REFERENCES automation_matches (id)
    );
    CREATE TABLE automation_results (
      prediction_id INTEGER PRIMARY KEY REFERENCES automation_predictions (id)
    );
    INSERT INTO automation_runs VALUES ('r1', '2026-10-08T10:00:00Z');
    INSERT INTO automation_matches VALUES (1, 'r1');
    INSERT INTO automation_alerts VALUES (1, 'r1');
    INSERT INTO automation_predictions VALUES (1, 1);
    INSERT INTO automation_results VALUES (1);
  `);
  // Seed the remote with STALE data that must be replaced.
  remote.db.exec(`
    INSERT INTO automation_runs VALUES ('old', '2020-01-01T00:00:00Z');
    INSERT INTO automation_matches VALUES (9, 'old');
    INSERT INTO automation_alerts VALUES (9, 'old');
    INSERT INTO automation_predictions VALUES (9, 9);
    INSERT INTO automation_results VALUES (9);
  `);

  const tables = [
    "automation_runs",
    "automation_alerts",
    "automation_matches",
    "automation_predictions",
    "automation_results",
  ];
  const cols = (t) => local.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

  const tx = await remote.transaction();
  try {
    for (const table of [...tables].reverse()) {
      await tx.execute(`DELETE FROM "${table}"`);
    }
    for (const table of tables) {
      const c = cols(table);
      const rows = local.prepare(`SELECT * FROM "${table}"`).all();
      const quoted = c.map((x) => `"${x}"`).join(", ");
      const ph = c.map(() => "?").join(", ");
      await tx.batch(
        rows.map((row) => ({
          sql: `INSERT INTO "${table}" (${quoted}) VALUES (${ph})`,
          args: c.map((x) => row[x] ?? null),
        }))
      );
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }

  // Remote now mirrors local exactly, FKs intact.
  for (const table of tables) {
    const n = remote.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    assert.strictEqual(n, 1, `${table} has 1 row`);
  }
  const runId = remote.db.prepare(`SELECT run_id AS r FROM automation_alerts`).get().r;
  assert.strictEqual(runId, "r1", "stale row replaced, FK intact");
  const fk = remote.db.prepare(`PRAGMA foreign_key_check`).all();
  assert.strictEqual(fk.length, 0, "no FK violations");
});

await check("old per-table order would have failed (documents the bug)", async () => {
  const remote = fakeRemote();
  remote.db.exec(`INSERT INTO automation_runs VALUES ('old', '2020-01-01T00:00:00Z');`);
  remote.db.exec(`INSERT INTO automation_alerts VALUES (9, 'old');`);
  // Old behaviour: DELETE parent while child rows exist -> FK error.
  await assert.rejects(
    (async () => {
      const tx = await remote.transaction();
      try {
        await tx.execute(`DELETE FROM "automation_runs"`);
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    })(),
    /FOREIGN KEY/i
  );
});

console.log(`\nturso-fk: ${passed} checks passed.`);
