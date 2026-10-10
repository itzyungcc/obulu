// OpenFootball history tests — plain node asserts, run with `npm test`.
// Uses a scratch DB; the sync's GitHub fetch is stubbed. No network.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-openfootball-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;

await import("../src/db/database.js"); // applies openfootball-schema.sql
const { db } = await import("../src/db/database.js");
const history = await import("../src/openfootball/history.js");
const sync = await import("../src/openfootball/sync.js");
const { normalizeTeamName } = await import("../src/automation/normalizer.js");

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

// Seed 8 finished Arsenal matches (mix of home/away) + 2 upcoming (no score).
function seed() {
  db.prepare("DELETE FROM openfootball_results").run();
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO openfootball_results
      (league_code, season, competition_id, match_date, round,
       team1, team2, team1_key, team2_key, ft_home, ft_away, synced_at)
    VALUES (?, '2026-27', 2021, ?, 'Matchday 1', ?, ?, ?, ?, ?, ?, ?)`);
  const games = [
    // date, team1, team2, ftH, ftA
    ["2026-08-21", "Arsenal FC", "Chelsea FC", 3, 0],       // Arsenal home win
    ["2026-08-28", "Liverpool FC", "Arsenal FC", 1, 1],     // Arsenal away draw
    ["2026-09-04", "Arsenal FC", "Tottenham Hotspur FC", 2, 2],
    ["2026-09-11", "Man City FC", "Arsenal FC", 2, 0],      // Arsenal away loss
    ["2026-09-18", "Arsenal FC", "Newcastle United FC", 1, 0],
    ["2026-09-25", "Everton FC", "Arsenal FC", 0, 2],
    ["2026-10-02", "Arsenal FC", "Aston Villa FC", 4, 1],
    ["2026-10-09", "Brighton FC", "Arsenal FC", 1, 3],
  ];
  for (const [d, t1, t2, h, a] of games) {
    ins.run("en.1", d, t1, t2, normalizeTeamName(t1), normalizeTeamName(t2), h, a, now);
  }
  db.prepare(
    "UPDATE openfootball_sync_state SET last_sync_at = ?, matches_synced = 8 WHERE id = 1"
  ).run(now);
}

// ---------------------------------------------------------------- tests ---

await check("getLocalTeamStats returns provider-shaped stats", async () => {
  seed();
  const s = history.getLocalTeamStats("Arsenal FC");
  assert.ok(s, "stats returned");
  assert.strictEqual(s.played, 8);
  assert.strictEqual(s.wins, 5, "3-0, 1-0, 0-2(a), 4-1, 1-3(a) = 5 wins");
  assert.strictEqual(s.draws, 2);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.goalsFor, 3 + 1 + 2 + 0 + 1 + 2 + 4 + 3);
  assert.strictEqual(s.goalsAgainst, 0 + 1 + 2 + 2 + 0 + 0 + 1 + 1);
  assert.strictEqual(s.homePlayed, 4);
  assert.strictEqual(s.awayPlayed, 4);
  assert.strictEqual(s.recentForm.length, 8);
  assert.strictEqual(s.recentForm[0].date, "2026-10-09", "most recent first");
  assert.strictEqual(s.source, "openfootball");
  assert.ok(s.teamId.startsWith("ofb:"));
});

await check("team name matching is normalization-based", async () => {
  seed();
  // football-data.org style short name should still match.
  const s = history.getLocalTeamStats("Arsenal");
  assert.ok(s && s.played === 8, "normalized match works");
  assert.strictEqual(history.getLocalTeamStats("Nonexistent FC"), null);
});

await check("insufficient history returns null (provider fallback)", async () => {
  seed();
  // Only 2 Chelsea matches in the seed -> below MIN_MATCHES.
  assert.strictEqual(history.getLocalTeamStats("Chelsea FC"), null);
  assert.strictEqual(history.getLocalTeamStats(""), null);
});

await check("syncOnce upserts from stubbed GitHub fetch", async () => {
  db.prepare("DELETE FROM openfootball_results").run();
  const fakeJson = {
    name: "Test League",
    matches: [
      { round: "Matchday 1", date: "2026-08-01", time: "15:00",
        team1: "Alpha FC", team2: "Beta FC", score: { ft: [2, 1], ht: [1, 0] } },
      { round: "Matchday 1", date: "2026-08-08", time: "15:00",
        team1: "Beta FC", team2: "Alpha FC", score: { ft: [0, 0] } },
      // Upcoming (no score) must be skipped.
      { round: "Matchday 2", date: "2026-12-01", time: "15:00",
        team1: "Alpha FC", team2: "Gamma FC" },
    ],
  };
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    // Only en.1 returns data; others 404 (tolerated per-file).
    if (String(url).includes("/en.1.json")) {
      return { ok: true, json: async () => fakeJson };
    }
    return { ok: false, status: 404 };
  };
  try {
    const r = await sync.syncOnce();
    assert.ok(r.matchesUpserted >= 4, `upserted ${r.matchesUpserted} (2 scored x 2 seasons)`);
    assert.ok(fetchCount >= 16, `fetched all league/season files (${fetchCount})`);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM openfootball_results").get();
    assert.strictEqual(Number(rows.c), 4, "only scored matches stored (2 per season)");
    // Idempotent: second sync upserts, doesn't duplicate.
    await sync.syncOnce();
    const rows2 = db.prepare("SELECT COUNT(*) AS c FROM openfootball_results").get();
    assert.strictEqual(Number(rows2.c), 4, "upsert is idempotent");
    const st = sync.syncStatus();
    assert.ok(st.lastSyncAt, "sync timestamp recorded");
    assert.strictEqual(st.rowsInDb, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("historyCoverage counts distinct teams", async () => {
  // Independent of test order: seed two teams directly.
  db.prepare("DELETE FROM openfootball_results").run();
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO openfootball_results
      (league_code, season, competition_id, match_date, round,
       team1, team2, team1_key, team2_key, ft_home, ft_away, synced_at)
    VALUES ('en.1', '2026-27', 2021, '2026-08-01', 'Matchday 1',
      'Alpha FC', 'Beta FC', 'alpha fc', 'beta fc', 2, 1, ?)`);
  ins.run(now);
  assert.ok(history.historyCoverage() >= 1, "teams covered");
});

console.log(`\nopenfootball: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
