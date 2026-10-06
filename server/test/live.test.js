// Live prediction engine tests — plain node asserts, run with `npm test`.
// Covers: minute estimation, probability normalization (sums to exactly
// 100 incl. 0-0 @ 90' and 5-0), red-card adjustments, missing stats,
// snapshot-trigger logic (goal / red-card / delta / gap / first sighting),
// API failure resilience (engine never throws, keeps last state), and the
// live-to-final transition (FINISHED + live_final_* verdicts).
// Uses a scratch DB — never the dev database.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-live-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;
process.env.SAMPLE_DATA = "true";

const {
  computeLivePrediction,
  normalizeProbs,
  clampMinute,
  applyRedCards,
  estimateMinute,
  explainLive,
} = await import("../src/model/livePredict.js");
const { db } = await import("../src/db/database.js");
const { recordPredictionSnapshot } = await import("../src/calendar/snapshots.js");
const {
  pollOnce,
  finalizeFixture,
  shouldPersistSnapshot,
  getLiveStates,
} = await import("../src/live/engine.js");
const { default: liveRouter } = await import("../src/routes/live.js");
const express = (await import("express")).default;

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

const PRE = {
  homeWin: 55,
  draw: 25,
  awayWin: 20,
  expectedGoals: { home: 1.8, away: 0.9 },
  predictedOutcome: "HOME",
};
const LIVE0 = (over = {}) => ({
  scoreHome: 0,
  scoreAway: 0,
  minute: 0,
  redCardsHome: 0,
  redCardsAway: 0,
  stats: null,
  homeName: "Arsenal",
  awayName: "Chelsea",
  ...over,
});

// ------------------------------------------------------- minute utils ---
await check("estimateMinute derives elapsed minutes, null when unknowable", () => {
  const ko = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  assert.strictEqual(estimateMinute(ko, new Date()), 45);
  assert.strictEqual(estimateMinute(new Date(Date.now() + 60000).toISOString()), null, "future kickoff");
  assert.strictEqual(estimateMinute("not-a-date"), null);
  assert.strictEqual(estimateMinute(null), null);
});

await check("clampMinute bounds 0..130", () => {
  assert.strictEqual(clampMinute(200), 130);
  assert.strictEqual(clampMinute(-5), 0);
  assert.strictEqual(clampMinute(63), 63);
  assert.strictEqual(clampMinute(null), 0);
});

// ------------------------------------------------------- normalization ---
await check("normalizeProbs sums to exactly 100.0", () => {
  for (const [a, b, c] of [[0.5, 0.3, 0.2], [0, 0, 0], [1, 0, 0], [0.333, 0.333, 0.334]]) {
    const [x, y, z] = normalizeProbs(a, b, c);
    assert.ok(Math.abs(x + y + z - 100) < 1e-9, `sum=${x + y + z}`);
    assert.ok([x, y, z].every((v) => v >= 0 && Number.isFinite(v)));
  }
});

await check("0-0 at 90' is DRAW 100 (no time left)", () => {
  const r = computeLivePrediction({ preMatch: PRE, live: LIVE0({ minute: 90 }) });
  assert.strictEqual(r.homeWin + r.draw + r.awayWin, 100);
  assert.strictEqual(r.draw, 100);
  assert.strictEqual(r.predictedOutcome, "DRAW");
});

await check("5-0 at 90' is HOME 100", () => {
  const r = computeLivePrediction({
    preMatch: PRE,
    live: LIVE0({ scoreHome: 5, scoreAway: 0, minute: 90 }),
  });
  assert.strictEqual(r.homeWin, 100);
  assert.strictEqual(r.predictedOutcome, "HOME");
});

// ------------------------------------------------------------ red cards ---
await check("red card weakens that team (0.78^net), symmetrically", () => {
  const adj = applyRedCards(1.5, 1.2, 1, 0);
  assert.ok(Math.abs(adj.home - 1.5 * 0.78) < 1e-9);
  assert.ok(Math.abs(adj.away - 1.2 / 0.78) < 1e-9, "opponent benefits");
  const even = applyRedCards(1.5, 1.2, 1, 1);
  assert.strictEqual(even.home, 1.5, "equal reds cancel out");
});

await check("red card lowers that side's live probability", () => {
  const base = computeLivePrediction({ preMatch: PRE, live: LIVE0({ minute: 30 }) });
  const red = computeLivePrediction({
    preMatch: PRE,
    live: LIVE0({ minute: 30, redCardsHome: 1 }),
  });
  assert.ok(red.homeWin < base.homeWin, `${red.homeWin} vs ${base.homeWin}`);
  assert.ok(red.factors.some((f) => f.includes("down to 10 men")), JSON.stringify(red.factors));
});

// --------------------------------------------------------- stats/missing ---
await check("missing stats never fabricate: no momentum, no crash", () => {
  const r = computeLivePrediction({ preMatch: PRE, live: LIVE0({ minute: 45 }) });
  assert.ok(Number.isFinite(r.homeWin));
  assert.ok(!r.factors.some((f) => f.includes("shots on target")));
});

await check("shots-on-target momentum applies only when reported", () => {
  const noStats = computeLivePrediction({
    preMatch: PRE,
    live: LIVE0({ minute: 45, scoreHome: 0, scoreAway: 0 }),
  });
  const withStats = computeLivePrediction({
    preMatch: PRE,
    live: LIVE0({
      minute: 45,
      scoreHome: 0,
      scoreAway: 0,
      stats: { shotsOnTarget: { home: 8, away: 1 } },
    }),
  });
  assert.ok(withStats.homeWin > noStats.homeWin, "dominant SoT should lift home");
  assert.ok(withStats.factors.some((f) => f.includes("More shots on target (8 vs 1)")));
});

await check("explainLive never invents data", () => {
  const f = explainLive(PRE, { scoreHome: 1, scoreAway: 1 }, { homeWin: 40, draw: 35, awayWin: 25 });
  assert.ok(f.some((s) => s.includes("level at 1-1")));
  assert.ok(!f.some((s) => /%/.test(s)), "no percentage claims in factors");
});

// --------------------------------------------------- persist triggers ---
await check("shouldPersistSnapshot: first sighting always persists", () => {
  assert.strictEqual(
    shouldPersistSnapshot(null, { homeWin: 50, draw: 30, awayWin: 20, scoreHome: 0, scoreAway: 0, redHome: 0, redAway: 0 }),
    true
  );
});

await check("shouldPersistSnapshot: goal and red-card changes trigger", () => {
  const prev = { homeWin: 50, draw: 30, awayWin: 20, scoreHome: 0, scoreAway: 0, redHome: 0, redAway: 0, createdAtMs: Date.now() };
  assert.strictEqual(shouldPersistSnapshot(prev, { ...prev, scoreHome: 1 }), true, "goal");
  assert.strictEqual(shouldPersistSnapshot(prev, { ...prev, redAway: 1 }), true, "red card");
});

await check("shouldPersistSnapshot: |Δp|>=3 triggers, small moves don't", () => {
  const prev = { homeWin: 50, draw: 30, awayWin: 20, scoreHome: 0, scoreAway: 0, redHome: 0, redAway: 0, createdAtMs: Date.now() };
  assert.strictEqual(shouldPersistSnapshot(prev, { ...prev, homeWin: 53.2, awayWin: 17 }), true, "delta 3.2");
  assert.strictEqual(shouldPersistSnapshot(prev, { ...prev, homeWin: 52.9, draw: 29.5 }), false, "delta < 3");
});

await check("shouldPersistSnapshot: >=10min gap triggers", () => {
  const prev = { homeWin: 50, draw: 30, awayWin: 20, scoreHome: 0, scoreAway: 0, redHome: 0, redAway: 0, createdAtMs: Date.now() - 11 * 60 * 1000 };
  assert.strictEqual(shouldPersistSnapshot(prev, { ...prev }), true, "gap");
});

// ------------------------------------------------- engine with fake provider ---
const liveFixture = {
  id: "live-1",
  league: { id: "l1", name: "Premier League", country: "England" },
  home: { id: "h1", name: "Arsenal" },
  away: { id: "a1", name: "Chelsea" },
  kickoff: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  status: "LIVE",
  score: { home: 0, away: 0 },
  minute: 30,
  minuteSource: "estimated",
};
const liveDetail = { ...liveFixture, redCards: { home: 0, away: 0 }, stats: null };

const fake = {
  liveList: [liveFixture],
  detail: liveDetail,
  final: null,
  failFixtures: false,
  async getLiveFixtures() {
    if (this.failFixtures) throw new Error("provider down");
    return this.liveList.map((f) => ({ ...f }));
  },
  async getLiveMatch(id) {
    return this.detail ? { ...this.detail } : null;
  },
  async getMatch(id) {
    return this.final;
  },
};

function seedSnapshot() {
  return recordPredictionSnapshot(
    {
      id: "live-1",
      home: { id: "h1", name: "Arsenal" },
      away: { id: "a1", name: "Chelsea" },
      league: { id: "l1", name: "Premier League", country: "England" },
      kickoff: liveFixture.kickoff,
    },
    {
      homeWin: 55,
      draw: 25,
      awayWin: 20,
      predictedOutcome: "HOME",
      confidence: { score: 42, label: "Moderate" },
      dataCompleteness: 0.8,
      expectedGoals: { home: 1.8, away: 0.9 },
      factors: ["x"],
      blendedWithOdds: false,
    }
  );
}

const liveCount = () =>
  db.prepare("SELECT COUNT(*) c FROM live_predictions WHERE fixture_id = 'live-1'").get().c;

await check("engine tracks fixture and persists first sighting", async () => {
  seedSnapshot();
  await pollOnce(fake);
  const states = getLiveStates();
  assert.strictEqual(states.length, 1);
  assert.strictEqual(states[0].fixtureId, "live-1");
  assert.strictEqual(states[0].baselineSource, "snapshot");
  assert.ok(states[0].live, "live probs missing");
  assert.strictEqual(states[0].live.homeWin + states[0].live.draw + states[0].live.awayWin, 100);
  assert.strictEqual(liveCount(), 1, "first sighting must persist");
  const track = db.prepare("SELECT status FROM live_matches WHERE fixture_id='live-1'").get();
  assert.strictEqual(track.status, "TRACKING");
});

await check("engine does not re-persist an unchanged picture", async () => {
  await pollOnce(fake);
  assert.strictEqual(liveCount(), 1, "unchanged tick must not add a row");
});

await check("engine persists on goal and red-card changes", async () => {
  fake.detail = { ...liveDetail, score: { home: 1, away: 0 } };
  await pollOnce(fake);
  assert.strictEqual(liveCount(), 2, "goal must trigger a snapshot");
  fake.detail = { ...fake.detail, redCards: { home: 0, away: 1 } };
  await pollOnce(fake);
  assert.strictEqual(liveCount(), 3, "red card must trigger a snapshot");
});

await check("engine never throws on provider failure; keeps last state", async () => {
  fake.failFixtures = true;
  await pollOnce(fake); // must not throw
  fake.failFixtures = false;
  const states = getLiveStates();
  assert.strictEqual(states.length, 1, "last known state must be kept");
  assert.strictEqual(liveCount(), 3, "no snapshot on failed poll");
});

await check("live-to-final transition: FINISHED + live verdict vs actual", async () => {
  fake.liveList = []; // fixture leaves the live list
  fake.final = { id: "live-1", status: "FT", score: { home: 2, away: 0 } };
  // Half-time grace: a couple of missed polls must NOT finalize.
  await pollOnce(fake);
  await pollOnce(fake);
  assert.strictEqual(getLiveStates().length, 1, "grace period: still tracked after 2 missed polls");
  const track1 = db.prepare("SELECT status FROM live_matches WHERE fixture_id='live-1'").get();
  assert.strictEqual(track1.status, "TRACKING");
  // After the full grace period the finished fixture is finalized.
  const need = (await import("../src/config.js")).default.liveFinalizeMissedPolls;
  for (let i = 0; i < need; i++) await pollOnce(fake);
  assert.strictEqual(getLiveStates().length, 0, "finished fixture must stop being tracked");
  const track = db.prepare("SELECT status FROM live_matches WHERE fixture_id='live-1'").get();
  assert.strictEqual(track.status, "FINISHED");
  const row = db.prepare("SELECT * FROM prediction_snapshots WHERE fixture_id='live-1'").get();
  assert.strictEqual(row.live_final_outcome, "HOME");
  assert.ok(row.live_final_home != null && row.live_final_draw != null);
  assert.strictEqual(row.live_correct, 1, "live said HOME, actual HOME");
  // Pre-match snapshot itself stays PENDING — the resolver owns that verdict.
  assert.strictEqual(row.status, "PENDING");
});

await check("finalizeFixture marks voided matches without a verdict", async () => {
  seedSnapshot2();
  const state = {
    live: { homeWin: 40, draw: 35, awayWin: 25, predictedOutcome: "DRAW" },
  };
  await finalizeFixture(
    { async getMatch() { return { id: "live-2", status: "POSTPONED", score: null }; } },
    "live-2",
    state
  );
  const row = db.prepare("SELECT * FROM prediction_snapshots WHERE fixture_id='live-2'").get();
  assert.strictEqual(row.live_final_outcome, "DRAW");
  assert.strictEqual(row.live_correct, null, "no actual result -> NULL verdict");
});

function seedSnapshot2() {
  recordPredictionSnapshot(
    {
      id: "live-2",
      home: { id: "h1", name: "Arsenal" },
      away: { id: "a1", name: "Chelsea" },
      league: { id: "l1", name: "Premier League", country: "England" },
      kickoff: new Date().toISOString(),
    },
    {
      homeWin: 40,
      draw: 35,
      awayWin: 25,
      predictedOutcome: "DRAW",
      confidence: { score: 20, label: "Low" },
      dataCompleteness: 0.7,
      expectedGoals: { home: 1.3, away: 1.1 },
      factors: ["x"],
      blendedWithOdds: false,
    }
  );
}

// --------------------------------------------------------------- routes ---
let httpServer, base;
await check("routes: /api/live, /:id, /:id/history over HTTP", async () => {
  const app = express();
  app.use("/api", liveRouter);
  httpServer = app.listen(0);
  await new Promise((r) => httpServer.on("listening", r));
  base = `http://localhost:${httpServer.address().port}/api`;

  try {
  // Nothing tracked right now (live-1 finalized, live-2 finalized).
  let res = await fetch(`${base}/live`);
  let body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(body.matches, []);

  // Re-track live-1 for route checks.
  fake.liveList = [liveFixture];
  fake.detail = { ...liveDetail, score: { home: 1, away: 0 }, redCards: { home: 0, away: 1 } };
  fake.final = null;
  await pollOnce(fake);

  res = await fetch(`${base}/live`);
  body = await res.json();
  assert.strictEqual(body.count, 1);
  const m = body.matches[0];
  assert.strictEqual(m.fixture.id, "live-1");
  assert.strictEqual(m.score.home, 1);
  assert.strictEqual(m.minuteSource, "estimated");
  assert.ok(m.live && m.preMatch, "live + baseline must be side by side");
  assert.strictEqual(m.live.homeWin + m.live.draw + m.live.awayWin, 100);

  res = await fetch(`${base}/live/live-1`);
  assert.strictEqual(res.status, 200);
  body = await res.json();
  assert.strictEqual(body.fixture.home.name, "Arsenal");
  assert.ok(body.live.factors.length > 0);

  res = await fetch(`${base}/live/live-1/history`);
  assert.strictEqual(res.status, 200);
  body = await res.json();
  assert.ok(body.snapshots.length >= 3, `expected >=3 history rows, got ${body.snapshots.length}`);
  // Chronological: newest last.
  const times = body.snapshots.map((s) => s.createdAt);
  assert.deepStrictEqual([...times].sort(), times, "history must be chronological");

  res = await fetch(`${base}/live/nope`);
  assert.strictEqual(res.status, 404);
  body = await res.json();
  assert.strictEqual(body.error, "NOT_FOUND");
  } finally {
    httpServer.close();
  }
});

console.log(`\nlive: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
