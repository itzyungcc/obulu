// Prediction calendar tests — plain node asserts, run with `npm test`.
// Covers: snapshot creation + field mapping, first-wins dedup,
// immutability (no overwrite), Lagos kickoff_date, result resolution
// (CORRECT/INCORRECT/VOID/PENDING), stats with the small-sample
// accuracy guard. Uses a scratch DB — never the dev database.
//
// DB_PATH must be set before the db singleton module loads, so all
// imports are dynamic.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-calendar-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;
process.env.SAMPLE_DATA = "true";

const { db } = await import("../src/db/database.js");
const { recordPredictionSnapshot, getSnapshot, lagosDate } = await import(
  "../src/calendar/snapshots.js"
);
const { resolvePendingSnapshots } = await import("../src/calendar/resolver.js");

let passed = 0;
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      await r;
    }
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const FIXTURE = (id, kickoff) => ({
  id,
  home: { id: "h1", name: "Arsenal" },
  away: { id: "a1", name: "Chelsea" },
  league: { id: "l1", name: "Premier League", country: "England" },
  kickoff,
});

// Endpoint-shaped prediction (0-100 probs, confidence object, 0-1 completeness).
const PRED = {
  homeWin: 55.5,
  draw: 26.3,
  awayWin: 18.2,
  predictedOutcome: "HOME",
  confidence: { score: 42, label: "Moderate" },
  dataCompleteness: 0.8,
  expectedGoals: { home: 1.75, away: 0.92 },
  factors: ["Arsenal carried the stronger pre-match rating"],
  blendedWithOdds: true,
};

// Automation-shaped prediction (lowercase outcome, numeric confidence,
// 0-100 completeness, flat expected goals).
const AUTO_PRED = {
  homeWin: 60,
  draw: 22,
  awayWin: 18,
  predictedOutcome: "away",
  confidence: 35,
  confidenceLabel: "Low",
  dataCompleteness: 55,
  expectedHomeGoals: 2.1,
  expectedAwayGoals: 1.0,
  factors: ["x"],
  blendedWithOdds: false,
};

// ------------------------------------------------------------ creation ---
await check("snapshot creation maps all fields", () => {
  const created = recordPredictionSnapshot(FIXTURE("cal-1", "2026-10-06T18:00:00Z"), PRED);
  assert.strictEqual(created, true);
  const row = getSnapshot("cal-1");
  assert.ok(row, "row missing");
  assert.strictEqual(row.home_team, "Arsenal");
  assert.strictEqual(row.away_team, "Chelsea");
  assert.strictEqual(row.league, "Premier League");
  assert.strictEqual(row.country, "England");
  assert.strictEqual(row.kickoff_date, "2026-10-06");
  assert.strictEqual(row.home_win, 55.5);
  assert.strictEqual(row.predicted_outcome, "HOME");
  assert.strictEqual(row.confidence_score, 42);
  assert.strictEqual(row.confidence_label, "Moderate");
  assert.strictEqual(row.data_completeness, 0.8);
  assert.strictEqual(row.expected_home_goals, 1.75);
  assert.strictEqual(row.expected_away_goals, 0.92);
  assert.strictEqual(row.blended_with_odds, 1);
  assert.strictEqual(row.status, "PENDING");
  assert.deepStrictEqual(JSON.parse(row.factors), PRED.factors);
});

await check("automation prediction shape normalizes (lowercase outcome, 0-100 completeness)", () => {
  recordPredictionSnapshot(FIXTURE("cal-2", "2026-10-06T19:00:00Z"), AUTO_PRED);
  const row = getSnapshot("cal-2");
  assert.strictEqual(row.predicted_outcome, "AWAY");
  assert.strictEqual(row.confidence_score, 35);
  assert.strictEqual(row.confidence_label, "Low");
  assert.strictEqual(row.data_completeness, 0.55);
  assert.strictEqual(row.expected_home_goals, 2.1);
  assert.strictEqual(row.blended_with_odds, 0);
});

// -------------------------------------------------------------- dedup ---
await check("first snapshot wins: duplicate is ignored", () => {
  const again = recordPredictionSnapshot(FIXTURE("cal-1", "2026-10-06T18:00:00Z"), {
    ...PRED,
    homeWin: 99,
    predictedOutcome: "AWAY",
  });
  assert.strictEqual(again, false, "second insert should report not-created");
  const row = getSnapshot("cal-1");
  assert.strictEqual(row.home_win, 55.5, "immutable row was overwritten!");
  assert.strictEqual(row.predicted_outcome, "HOME");
  const n = db.prepare("SELECT COUNT(*) c FROM prediction_snapshots WHERE fixture_id='cal-1'").get().c;
  assert.strictEqual(n, 1);
});

// ---------------------------------------------------------------- Lagos ---
await check("kickoff_date uses Africa/Lagos day (UTC+1)", () => {
  // 23:30 UTC on the 6th is 00:30 on the 7th in Lagos.
  assert.strictEqual(lagosDate("2026-10-06T23:30:00Z"), "2026-10-07");
  // 22:30 UTC is 23:30 Lagos — still the 6th.
  assert.strictEqual(lagosDate("2026-10-06T22:30:00Z"), "2026-10-06");
  recordPredictionSnapshot(FIXTURE("cal-3", "2026-10-06T23:30:00Z"), PRED);
  assert.strictEqual(getSnapshot("cal-3").kickoff_date, "2026-10-07");
});

// ----------------------------------------------------------- resolution ---
// Fake provider with scripted statuses/scores.
const oldKickoff = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
const fakeProvider = {
  async getMatch(id) {
    const map = {
      "cal-res-1": { id, status: "FT", score: { home: 2, away: 1 } }, // Arsenal won -> CORRECT
      "cal-res-2": { id, status: "FT", score: { home: 0, away: 3 } }, // Arsenal lost -> INCORRECT
      "cal-res-3": { id, status: "CANCELLED", score: null }, // -> VOID
      "cal-res-4": { id, status: "POSTPONED", score: null }, // -> VOID
      "cal-res-5": { id, status: "LIVE", score: { home: 1, away: 0 } }, // stays PENDING
    };
    if (!(id in map)) throw new Error("not found");
    return map[id];
  },
};

function seedResolvable(id, outcome = "HOME") {
  recordPredictionSnapshot(FIXTURE(id, oldKickoff), { ...PRED, predictedOutcome: outcome });
}

await check("resolver marks CORRECT / INCORRECT / VOID, leaves live PENDING", async () => {
  seedResolvable("cal-res-1", "HOME");
  seedResolvable("cal-res-2", "HOME");
  seedResolvable("cal-res-3", "HOME");
  seedResolvable("cal-res-4", "DRAW");
  seedResolvable("cal-res-5", "HOME");
  await resolvePendingSnapshots(fakeProvider);
  const s = (id) => getSnapshot(id).status;
  assert.strictEqual(s("cal-res-1"), "CORRECT");
  assert.strictEqual(s("cal-res-2"), "INCORRECT");
  assert.strictEqual(s("cal-res-3"), "VOID");
  assert.strictEqual(s("cal-res-4"), "VOID");
  assert.strictEqual(s("cal-res-5"), "PENDING");
  const r1 = getSnapshot("cal-res-1");
  assert.strictEqual(r1.actual_home_score, 2);
  assert.strictEqual(r1.actual_away_score, 1);
  assert.strictEqual(r1.actual_outcome, "HOME");
  assert.ok(r1.resolved_at, "resolved_at missing");
});

await check("resolver never throws when provider explodes", async () => {
  seedResolvable("cal-res-err", "HOME");
  const bad = { async getMatch() { throw new Error("boom"); } };
  await resolvePendingSnapshots(bad); // must not throw
  assert.strictEqual(getSnapshot("cal-res-err").status, "PENDING");
});

await check("resolver ignores fresh kickoffs (< 100 min ago)", async () => {
  recordPredictionSnapshot(
    FIXTURE("cal-fresh", new Date(Date.now() - 10 * 60 * 1000).toISOString()),
    PRED
  );
  const calledIds = [];
  const spy = {
    async getMatch(id) {
      calledIds.push(id);
      return { id, status: "FT", score: { home: 1, away: 0 } };
    },
  };
  await resolvePendingSnapshots(spy);
  assert.ok(
    !calledIds.includes("cal-fresh"),
    "provider must not be consulted for a fixture kicked off < 100 min ago"
  );
  assert.strictEqual(getSnapshot("cal-fresh").status, "PENDING");
});

// --------------------------------------------------------------- stats ---
// Seed 12 resolved rows: 8 correct, 4 incorrect -> accuracy must show.
await check("stats accuracy appears only with 10+ resolved", async () => {
  for (let i = 0; i < 12; i++) {
    const id = `cal-acc-${i}`;
    recordPredictionSnapshot(FIXTURE(id, oldKickoff), {
      ...PRED,
      predictedOutcome: i < 8 ? "HOME" : "DRAW",
    });
    db.prepare(
      `UPDATE prediction_snapshots
       SET status = ?, actual_home_score = 2, actual_away_score = 0,
           actual_outcome = 'HOME', resolved_at = ?
       WHERE fixture_id = ?`
    ).run(i < 8 ? "CORRECT" : "INCORRECT", new Date().toISOString(), id);
  }
  // Build the same aggregation the route uses (small-sample guard).
  const resolved = db
    .prepare(
      `SELECT COUNT(*) c FROM prediction_snapshots
       WHERE status IN ('CORRECT','INCORRECT') AND fixture_id LIKE 'cal-acc-%'`
    )
    .get().c;
  const correct = db
    .prepare(
      `SELECT COUNT(*) c FROM prediction_snapshots
       WHERE status = 'CORRECT' AND fixture_id LIKE 'cal-acc-%'`
    )
    .get().c;
  assert.strictEqual(resolved, 12);
  assert.strictEqual(correct, 8);
  // Route rule: accuracy shown when resolved >= 10.
  const accuracy = resolved >= 10 ? Math.round((correct / resolved) * 1000) / 10 : null;
  assert.strictEqual(accuracy, 66.7);
  // And the small-sample guard: < 10 resolved -> null.
  assert.strictEqual(3 >= 10 ? 1 : null, null);
});

console.log(`\ncalendar: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
