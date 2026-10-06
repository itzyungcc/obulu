// Model unit tests — plain node asserts, run with `npm test`.
import assert from "node:assert";
import { predictMatch, DISCLAIMER, MODEL_VERSION, METHOD } from "../src/model/poisson.js";

const EXPECTED_DISCLAIMER =
  "Predictions are statistical estimates based on available data and are not guarantees of match results.";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Build a TeamStats object with a scripted recent form.
function team({ n, gfPer, gaPer, home = true, position } = {}) {
  const recentForm = [];
  for (let i = 0; i < n; i++) {
    const sf = gfPer, sa = gaPer;
    recentForm.push({
      opponent: `opp-${i}`,
      scoreH: home ? sf : sa,
      scoreA: home ? sa : sf,
      home,
      date: `2026-09-${String(28 - i).padStart(2, "0")}`,
    });
  }
  return {
    teamId: "t", played: n, wins: 0, draws: 0, losses: 0,
    goalsFor: n * gfPer, goalsAgainst: n * gaPer, cleanSheets: 0,
    homePlayed: 0, homeGF: 0, homeGA: 0, awayPlayed: 0, awayGF: 0, awayGA: 0,
    recentForm, position,
  };
}

const LEAGUE = { avgHomeGoals: 1.45, avgAwayGoals: 1.15, credible: true };

check("disclaimer string is exact", () => {
  assert.strictEqual(DISCLAIMER, EXPECTED_DISCLAIMER);
});

check("model constants sane", () => {
  assert.strictEqual(METHOD, "poisson-dixon-coles");
  assert.ok(MODEL_VERSION);
});

check("probabilities sum to exactly 100", () => {
  const r = predictMatch(team({ n: 10, gfPer: 2, gaPer: 1 }), team({ n: 10, gfPer: 1, gaPer: 2 }), LEAGUE, null, null);
  const sum = r.homeWin + r.draw + r.awayWin;
  assert.ok(Math.abs(sum - 100) <= 0.5, `sum=${sum}`);
  assert.strictEqual(Math.round(sum * 10) / 10, 100);
});

check("strong-vs-weak is sane (home favourite)", () => {
  const strong = team({ n: 10, gfPer: 3, gaPer: 0, position: 1 });
  const weak = team({ n: 10, gfPer: 0, gaPer: 3, position: 18 });
  const r = predictMatch(strong, weak, LEAGUE, { played: 4, homeWins: 3, draws: 1, awayWins: 0, lastMeetings: [] }, null);
  assert.ok(r.homeWin > r.awayWin, `homeWin=${r.homeWin} awayWin=${r.awayWin}`);
  assert.strictEqual(r.predictedOutcome, "HOME");
  assert.ok(r.homeWin > 50, `expected strong favourite, got ${r.homeWin}`);
});

check("empty history is graceful", () => {
  const r = predictMatch(null, undefined, null, null, null);
  for (const k of ["homeWin", "draw", "awayWin"]) {
    assert.ok(Number.isFinite(r[k]), `${k} not finite`);
    assert.ok(r[k] >= 0 && r[k] <= 100, `${k}=${r[k]}`);
  }
  assert.ok(["HOME", "DRAW", "AWAY"].includes(r.predictedOutcome));
  assert.ok(r.factors.length >= 3 && r.factors.length <= 4);
  assert.ok(r.dataCompleteness >= 0 && r.dataCompleteness <= 1);
});

check("draw probability strictly between 0 and 100", () => {
  const r = predictMatch(team({ n: 8, gfPer: 1, gaPer: 1 }), team({ n: 8, gfPer: 1, gaPer: 1 }), LEAGUE, null, null);
  assert.ok(r.draw > 0 && r.draw < 100, `draw=${r.draw}`);
});

check("confidence score/label valid", () => {
  const r = predictMatch(team({ n: 10, gfPer: 2, gaPer: 1 }), team({ n: 10, gfPer: 1, gaPer: 1 }), LEAGUE, null, null);
  assert.ok(r.confidence.score >= 0 && r.confidence.score <= 100);
  assert.ok(["Low", "Moderate", "High", "Very high"].includes(r.confidence.label));
});

check("odds blend shifts probabilities toward market", () => {
  const home = team({ n: 10, gfPer: 2, gaPer: 1 });
  const away = team({ n: 10, gfPer: 1, gaPer: 1 });
  const noOdds = predictMatch(home, away, LEAGUE, null, null);
  // Market says away team is a heavy favourite.
  const withOdds = predictMatch(home, away, LEAGUE, null, { home: 5.0, draw: 4.0, away: 1.6 }, { oddsWeight: 0.5 });
  assert.strictEqual(withOdds.blendedWithOdds, true);
  assert.strictEqual(noOdds.blendedWithOdds, false);
  assert.ok(withOdds.awayWin > noOdds.awayWin, `blend did not move toward market: ${withOdds.awayWin} vs ${noOdds.awayWin}`);
  const sum = withOdds.homeWin + withOdds.draw + withOdds.awayWin;
  assert.ok(Math.abs(sum - 100) <= 0.5, `sum=${sum}`);
});

check("thin history shrinks toward average (no extreme ratings)", () => {
  const oneGame = team({ n: 1, gfPer: 5, gaPer: 0 });
  const r = predictMatch(oneGame, team({ n: 10, gfPer: 1, gaPer: 1 }), LEAGUE, null, null);
  assert.ok(r.homeWin < 95, `shrinkage failed, homeWin=${r.homeWin}`);
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}.`);
