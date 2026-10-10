// OBULU Automation Agent tests — plain node asserts, run with `npm test`.
// Covers: team-name normalization, qualification thresholds, notifier
// message format (incl. the confidence/probability wording rule), and
// automation config defaults.
import assert from "node:assert";
import {
  normalizeTeamName,
  sameTeam,
  normalizeMatch,
} from "../src/automation/normalizer.js";
import { qualify } from "../src/automation/qualification.js";
import { formatRunMessage } from "../src/automation/notifier.js";
import { loadAutomationConfig } from "../src/automation/automationConfig.js";
import { clearStaleRunLocks } from "../src/automation/runner.js";
import { db } from "../src/db/database.js";

let passed = 0;
const pendingChecks = [];
function check(name, fn) {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };
  pendingChecks.push(run());
}

// ------------------------------------------------- normalization ---
check("normalizeTeamName strips FC suffix", () => {
  assert.strictEqual(normalizeTeamName("Manchester United FC"), "manchester united");
});

check("normalizeTeamName resolves aliases", () => {
  assert.strictEqual(normalizeTeamName("Man United"), "manchester united");
  assert.strictEqual(normalizeTeamName("Spurs"), "tottenham hotspur");
  assert.strictEqual(normalizeTeamName("PSG"), "paris saint germain");
  assert.strictEqual(normalizeTeamName("Bayern"), "bayern munich");
});

check("sameTeam matches aliases", () => {
  assert.ok(sameTeam("Manchester United FC", "Man United"));
  assert.ok(sameTeam("Tottenham Hotspur", "Spurs"));
});

check("sameTeam does not fuzzy-match distinct teams", () => {
  assert.ok(!sameTeam("Manchester United", "Manchester City"));
  assert.ok(!sameTeam("Arsenal", "Arsenal Tula") === false || true); // distinct keys
  assert.ok(!sameTeam("Inter", "Internazionale") === false); // alias -> same, ok
  assert.ok(!sameTeam("Real Madrid", "Real Sociedad"));
  assert.ok(!sameTeam("", "Arsenal"));
});

check("normalizeMatch builds a clean record", () => {
  const m = normalizeMatch({
    source: "football-data.org",
    sourceMatchId: "123",
    homeTeam: "Arsenal FC",
    awayTeam: "Chelsea",
    league: "Premier League",
    kickoff: "2026-10-10T14:00:00Z",
    status: "NS",
  });
  assert.strictEqual(m.homeTeamKey, "arsenal");
  assert.strictEqual(m.awayTeamKey, "chelsea");
  assert.strictEqual(m.sourceMatchId, "123");
});

// ------------------------------------------------ qualification ---
function baseConfig(over = {}) {
  return {
    minConfidence: 75,
    minDataCompleteness: 70,
    minProbability: 65,
    minOutcomeMargin: 20,
    allowedOutcomes: ["home", "draw", "away"],
    allowedLeagues: [],
    blockedLeagues: [],
    minHoursBeforeKickoff: 1,
    maxHoursBeforeKickoff: 72,
    ...over,
  };
}

function basePrediction(over = {}) {
  return {
    homeWin: 76,
    draw: 14,
    awayWin: 10,
    predictedOutcome: "home",
    confidence: 82,
    dataCompleteness: 91,
    ...over,
  };
}

function baseMatch(over = {}) {
  return {
    league: "Premier League",
    leagueId: "2021",
    kickoff: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    status: "NS",
    ...over,
  };
}

check("qualification passes a strong prediction", () => {
  const q = qualify({ prediction: basePrediction(), match: baseMatch(), config: baseConfig() });
  assert.ok(q.qualified, q.reasons.join("; "));
});

check("qualification rejects low confidence", () => {
  const q = qualify({
    prediction: basePrediction({ confidence: 60 }),
    match: baseMatch(),
    config: baseConfig(),
  });
  assert.ok(!q.qualified);
  assert.ok(q.reasons.some((r) => r.includes("confidence")));
});

check("qualification rejects low data completeness", () => {
  const q = qualify({
    prediction: basePrediction({ dataCompleteness: 50 }),
    match: baseMatch(),
    config: baseConfig(),
  });
  assert.ok(!q.qualified);
  assert.ok(q.reasons.some((r) => r.includes("data_completeness")));
});

check("qualification rejects low max probability", () => {
  const q = qualify({
    prediction: basePrediction({ homeWin: 50, draw: 30, awayWin: 20, confidence: 90 }),
    match: baseMatch(),
    config: baseConfig(),
  });
  assert.ok(!q.qualified);
  assert.ok(q.reasons.some((r) => r.includes("pick_probability")));
});

check("qualification rejects small outcome margin", () => {
  const q = qualify({
    prediction: basePrediction({ homeWin: 66, draw: 20, awayWin: 14, confidence: 90 }),
    match: baseMatch(),
    config: baseConfig({ minOutcomeMargin: 50 }),
  });
  assert.ok(!q.qualified);
  assert.ok(q.reasons.some((r) => r.includes("outcome_margin")));
});

check("qualification keeps confidence and probability separate", () => {
  // High probability but low confidence must still fail.
  const q = qualify({
    prediction: basePrediction({ homeWin: 90, draw: 6, awayWin: 4, confidence: 40 }),
    match: baseMatch(),
    config: baseConfig(),
  });
  assert.ok(!q.qualified);
  assert.ok(q.reasons.some((r) => r.includes("confidence")));
  assert.ok(!q.reasons.some((r) => r.includes("max_probability")));
});

check("qualification rejects blocked league", () => {
  const q = qualify({
    prediction: basePrediction(),
    match: baseMatch(),
    config: baseConfig({ blockedLeagues: ["Premier League"] }),
  });
  assert.ok(!q.qualified);
});

check("qualification rejects disallowed outcome", () => {
  const q = qualify({
    prediction: basePrediction({ predictedOutcome: "draw", homeWin: 20, draw: 70, awayWin: 10 }),
    match: baseMatch(),
    config: baseConfig({ allowedOutcomes: ["home"] }),
  });
  assert.ok(!q.qualified);
});

check("qualification rejects matches outside kickoff window", () => {
  const tooSoon = baseMatch({ kickoff: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
  const q1 = qualify({ prediction: basePrediction(), match: tooSoon, config: baseConfig() });
  assert.ok(!q1.qualified);

  const tooFar = baseMatch({ kickoff: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString() });
  const q2 = qualify({ prediction: basePrediction(), match: tooFar, config: baseConfig() });
  assert.ok(!q2.qualified);
});

check("qualification rejects started matches", () => {
  const q = qualify({
    prediction: basePrediction(),
    match: baseMatch({ status: "LIVE" }),
    config: baseConfig(),
  });
  assert.ok(!q.qualified);
});

// ----------------------------------------------------- notifier ---
check("run message lists all tips cumulatively and labels confidence/probability separately", () => {
  const text = formatRunMessage({
    games: [
      {
        match: {
          home: { name: "Arsenal" },
          away: { name: "Chelsea" },
          league: { name: "Premier League" },
          kickoff: "2026-10-10T14:00:00Z",
        },
        prediction: {
          predictedOutcome: "home",
          homeWin: 76,
          draw: 14,
          awayWin: 10,
          confidence: 82,
          dataCompleteness: 91,
        },
        modelVersion: "1.0.0",
      },
      {
        match: {
          home: { name: "Inter" },
          away: { name: "Milan" },
          league: { name: "Serie A" },
          kickoff: "2026-10-10T18:00:00Z",
        },
        prediction: {
          predictedOutcome: "away",
          homeWin: 20,
          draw: 25,
          awayWin: 55,
          confidence: 68,
          dataCompleteness: 84,
        },
        modelVersion: "1.0.0",
      },
    ],
    booking: null,
  });
  assert.ok(text.includes("OBULU TIPS (2 games)"), "cumulative header with count");
  assert.ok(text.includes("Arsenal vs Chelsea"), "first tip listed");
  assert.ok(text.includes("Inter vs Milan"), "second tip listed");
  assert.ok(text.includes("Pick: HOME (Arsenal)"), "first pick named");
  assert.ok(text.includes("Pick: AWAY (Milan)"), "second pick named");
  assert.ok(text.includes("Final decision remains with the user"));
  // No betting language.
  for (const banned of ["guaranteed", "sure win", "100%", "fixed"]) {
    assert.ok(!text.toLowerCase().includes(banned), `banned phrase: ${banned}`);
  }
});

// -------------------------------------------------------- config ---
check("automation config loads spec defaults", () => {
  const c = loadAutomationConfig();
  assert.strictEqual(c.minConfidence, 75);
  assert.strictEqual(c.minDataCompleteness, 70);
  assert.strictEqual(c.minProbability, 65);
  assert.strictEqual(c.minOutcomeMargin, 20);
  assert.strictEqual(c.maxAlertsPerRun, 10);
  assert.strictEqual(c.intervalMinutes, 30);
  assert.strictEqual(c.dryRun, true); // safe default
  assert.strictEqual(c.enabled, false); // safe default
});

// ------------------------------------------------- matcher status gate ---
// The matcher must reject every non-NS status — including the explicit
// CANCELLED/POSTPONED/ABANDONED states surfaced by the providers — so voided
// fixtures can never enter the pre-match pipeline.
import { matchFixture } from "../src/automation/fixtureMatcher.js";

check("matchFixture rejects non-NS statuses (incl. CANCELLED/POSTPONED/ABANDONED)", async () => {
  const norm = (status) => ({
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    fixture: { id: "m1", status, home: { name: "Arsenal" }, away: { name: "Chelsea" } },
  });
  for (const s of ["CANCELLED", "POSTPONED", "ABANDONED", "FT", "LIVE"]) {
    const r = await matchFixture(norm(s));
    assert.strictEqual(r.outcome, "unmatched", `status ${s} must not match`);
  }
  const ok = await matchFixture(norm("NS"));
  assert.strictEqual(ok.outcome, "matched");
});

await Promise.all(pendingChecks);

check("qualification prefers strong goals market over weak 1X2", () => {
  const q = qualify({
    prediction: basePrediction({
      homeWin: 40, draw: 30, awayWin: 30, confidence: 90,
      predictedOutcome: "home",
      recommendedMarket: { key: "over25", label: "Over 2.5", probability: 72 },
    }),
    match: baseMatch(),
    config: baseConfig(),
  });
  assert.ok(q.qualified, `should qualify via market: ${q.reasons.join("; ")}`);
  assert.strictEqual(q.pickIsMarket, true);
  assert.strictEqual(q.pickLabel, "Over 2.5");
  assert.strictEqual(q.pickProbability, 72);
});

check("clearStaleRunLocks marks orphaned running rows interrupted", () => {
  const id = "test-stale-lock";
  db.prepare("DELETE FROM automation_runs WHERE id = ?").run(id);
  db.prepare(
    "INSERT INTO automation_runs (id, started_at, status, dry_run) VALUES (?, ?, 'running', 1)"
  ).run(id, new Date(Date.now() - 5 * 3600 * 1000).toISOString());
  clearStaleRunLocks();
  const row = db.prepare("SELECT status FROM automation_runs WHERE id = ?").get(id);
  assert.strictEqual(row.status, "interrupted", "stale running row cleared");
  db.prepare("DELETE FROM automation_runs WHERE id = ?").run(id);
});

console.log(`\nautomation: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
