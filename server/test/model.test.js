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

check("dataCompleteness uses actual recentForm length, not played counter (§24)", () => {
  // Team claims 12 games played but only 2 recent results are on record:
  // completeness must reflect the 2 real results, not the 12.
  const thin = team({ n: 2, gfPer: 2, gaPer: 1 });
  thin.played = 12; // stale/high season counter must NOT inflate completeness
  const full = team({ n: 10, gfPer: 2, gaPer: 1 });
  const rThin = predictMatch(thin, full, LEAGUE, null, null);
  const rFull = predictMatch(full, full, LEAGUE, null, null);
  assert.ok(
    rThin.dataCompleteness < rFull.dataCompleteness,
    `thin history should score lower: ${rThin.dataCompleteness} vs ${rFull.dataCompleteness}`
  );
  // 0.35*0.2 + 0.35*1.0 + 0.15*1 (credible league avgs) + 0.15*0 (no h2h)
  assert.ok(
    Math.abs(rThin.dataCompleteness - 0.57) < 1e-9,
    `expected 0.57, got ${rThin.dataCompleteness}`
  );
});

check("predictMatch includes goals markets with sane probabilities", () => {
  const r = predictMatch(
    { goalsFor: 20, goalsAgainst: 10, played: 10, recentForm: ["W", "W", "D", "W", "L"] },
    { goalsFor: 8, goalsAgainst: 18, played: 10, recentForm: ["L", "L", "D", "L", "W"] },
    { avgHomeGoals: 1.45, avgAwayGoals: 1.15, credible: true },
    { played: 0 },
    null
  );
  assert.ok(r.markets, "markets present");
  assert.ok(r.recommendedMarket, "recommended market present");
  const m = r.markets;
  // Over/under are complementary.
  assert.ok(Math.abs(m.over25 + m.under25 - 100) < 0.1, "over25+under25=100");
  assert.ok(Math.abs(m.over15 + m.under15 - 100) < 0.1, "over15+under15=100");
  // Monotonic: over 1.5 >= over 2.5 >= over 3.5.
  assert.ok(m.over15 >= m.over25 && m.over25 >= m.over35, "totals monotonic");
  // BTTS complementary.
  assert.ok(Math.abs(m.bttsYes + m.bttsNo - 100) < 0.1, "btts sums to 100");
  // "or" combos >= their parts.
  assert.ok(m.homeOrOver25 >= m.over25 - 0.1, "homeOrOver25 >= over25");
  assert.ok(m.awayOrOver25 >= m.over25 - 0.1, "awayOrOver25 >= over25");
});

check("recommended market fits the match profile, not just max probability", () => {
  // High-scoring mismatch: should pick a sharp market (Over 2.5 or
  // Home & Over), NOT the trivial "Home or Over 2.5" even though the
  // "or" combo always has the highest raw probability.
  const high = predictMatch(
    { goalsFor: 28, goalsAgainst: 8, played: 10, recentForm: Array(10).fill("W") },
    { goalsFor: 6, goalsAgainst: 22, played: 10, recentForm: Array(10).fill("L") },
    { avgHomeGoals: 1.45, avgAwayGoals: 1.15, credible: true },
    { played: 0 },
    null
  );
  const bluntLabels = ["Home win or Over 2.5", "Away win or Over 2.5", "Draw or Over 2.5"];
  assert.ok(
    !bluntLabels.includes(high.recommendedMarket.label),
    `high-scoring game should not pick blunt combo, got: ${high.recommendedMarket.label}`
  );
  assert.ok(
    high.recommendedMarket.probability >= 55 && high.recommendedMarket.probability <= 88,
    `pick should be in sweet spot, got ${high.recommendedMarket.probability}`
  );

  // Low-scoring defensive game: should lean Under 2.5.
  const low = predictMatch(
    { goalsFor: 6, goalsAgainst: 7, played: 10, recentForm: Array(10).fill("D") },
    { goalsFor: 5, goalsAgainst: 8, played: 10, recentForm: Array(10).fill("D") },
    { avgHomeGoals: 1.45, avgAwayGoals: 1.15, credible: true },
    { played: 0 },
    null
  );
  assert.ok(
    low.markets.under25 > low.markets.over25,
    "defensive game should favour under"
  );
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}.`);
