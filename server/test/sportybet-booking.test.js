// SportyBet share-booking tests — plain node asserts, run with `npm test`.
// Covers: createBooking success (stubbed fetch), HTTP error, 200 without
// shareCode (never fabricates), non-JSON body, invalid selections input
// (no HTTP attempted), HOME/DRAW/AWAY -> outcome id 1/2/3 mapping,
// disabled config -> null with no fetch, dry-run hook placement
// (structural), matching never fetches (booking happens once per run),
// no fuzzy match -> silent skip, and the combined slip message
// (games listed with picks, code/deadline shown, slip-reservation wording).
// No live network: global fetch is stubbed and the SportyBet cache is
// seeded on a scratch DB — never the dev database.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-sportybet-booking-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;
process.env.SPORTYBET_ENABLED = "true";

const { createBooking } = await import("../src/sportybet/booking.js");
const { matchSportybetSelection, createCombinedSlip } = await import("../src/automation/runner.js");
const { formatRunMessage } = await import("../src/automation/notifier.js");
const { SPORTYBET_CACHE_KEY } = await import("../src/sportybet/client.js");
const { cacheSet } = await import("../src/cache.js");
await import("../src/db/database.js"); // ensure scratch tables exist

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

// ------------------------------------------------------- stubbed fetch ---
const realFetch = globalThis.fetch.bind(globalThis);
let fetchCalls = 0;
let lastRequest = null;
let fetchBehavior = "ok"; // "ok" | "http-error" | "throw"

globalThis.fetch = async (url, opts) => {
  fetchCalls++;
  lastRequest = { url: String(url), opts };
  if (fetchBehavior === "throw") {
    throw new Error("boom");
  }
  if (fetchBehavior === "http-error") {
    return {
      ok: false,
      status: 429,
      json: async () => ({ status: 429, message: "rate limited" }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        shareCode: "WGB4BE",
        shareURL: "https://www.sportybet.com/ng/share/WGB4BE",
        deadline: "2026-10-10T17:30:00.000Z",
      },
    }),
  };
};

// ------------------------------------------------------------ fixtures ---
const FUTURE_KICKOFF = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

function seedEvents(events) {
  cacheSet(SPORTYBET_CACHE_KEY, { events, cachedAt: "2026-10-07T00:00:00.000Z" }, "fixtures");
}

const cachedEvent = (over = {}) => ({
  eventId: "sb-ev-1",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  kickoffISO: FUTURE_KICKOFF,
  tournament: "England - Premier League",
  odds: { home: 2.1, draw: 3.4, away: 3.6 },
  ...over,
});

const analysisFor = (outcome) => ({
  analysis: {
    match: { home: { name: "Arsenal" }, away: { name: "Chelsea" }, league: { name: "Premier League" } },
  },
  prediction: { predictedOutcome: outcome },
  fixtureId: "fx-1",
});

// ------------------------------------------- createBooking unit tests ---
await check("createBooking success returns {shareCode, shareURL, deadline}", async () => {
  fetchBehavior = "ok";
  fetchCalls = 0;
  const r = await createBooking([{ eventId: "sb-ev-1", marketId: "1", outcomeId: "1" }]);
  assert.strictEqual(fetchCalls, 1, "one HTTP call");
  assert.ok(lastRequest.url.endsWith("/api/ng/orders/share"), `posts to share endpoint: ${lastRequest.url}`);
  assert.strictEqual(lastRequest.opts.method, "POST");
  const sent = JSON.parse(lastRequest.opts.body);
  assert.deepStrictEqual(sent.selections, [
    { eventId: "sb-ev-1", marketId: "1", specifier: null, outcomeId: "1" },
  ]);
  assert.deepStrictEqual(r, {
    shareCode: "WGB4BE",
    shareURL: "https://www.sportybet.com/ng/share/WGB4BE",
    deadline: "2026-10-10T17:30:00.000Z",
  });
});

await check("createBooking: HTTP error status throws a clean Error", async () => {
  fetchBehavior = "http-error";
  await assert.rejects(createBooking([{ eventId: "sb-ev-1", marketId: "1", outcomeId: "1" }]), /SportyBet booking HTTP 429/);
  fetchBehavior = "ok";
});

await check("createBooking: 200 with missing shareCode throws, never fabricates", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { shareURL: "https://x", deadline: null } }),
  });
  try {
    await assert.rejects(
      createBooking([{ eventId: "sb-ev-1", marketId: "1", outcomeId: "1" }]),
      /SportyBet did not return a booking code/
    );
  } finally {
    globalThis.fetch = orig;
  }
});

await check("createBooking: non-JSON body throws", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error("bad json"); },
  });
  try {
    await assert.rejects(
      createBooking([{ eventId: "sb-ev-1", marketId: "1", outcomeId: "1" }]),
      /SportyBet booking returned non-JSON/
    );
  } finally {
    globalThis.fetch = orig;
  }
});

await check("createBooking: invalid selections throw before any HTTP", async () => {
  fetchCalls = 0;
  await assert.rejects(createBooking([]), /selections are required/);
  await assert.rejects(createBooking(undefined), /selections are required/);
  await assert.rejects(createBooking([null]), /requires eventId, marketId and outcomeId/);
  await assert.rejects(createBooking([{ marketId: "1", outcomeId: "1" }]), /requires eventId, marketId and outcomeId/, "missing eventId");
  await assert.rejects(createBooking([{ eventId: "e", outcomeId: "1" }]), /requires eventId, marketId and outcomeId/, "missing marketId");
  await assert.rejects(createBooking([{ eventId: "e", marketId: "1" }]), /requires eventId, marketId and outcomeId/, "missing outcomeId");
  assert.strictEqual(fetchCalls, 0, "no HTTP attempted on invalid input");
});

// -------------------------------------- outcome mapping + runner hook ---
await check("matchSportybetSelection maps HOME->1, DRAW->2, AWAY->3 (no fetch yet)", async () => {
  for (const [predicted, expected] of [["HOME", "1"], ["draw", "2"], ["Away", "3"]]) {
    seedEvents([cachedEvent()]);
    fetchCalls = 0;
    const { analysis, prediction, fixtureId } = analysisFor(predicted);
    const sel = await matchSportybetSelection({
      config: { sportyBetBookingEnabled: true },
      analysis,
      prediction,
      fixtureId,
    });
    assert.ok(sel, `selection returned for ${predicted}`);
    assert.strictEqual(sel.outcomeId, expected, `${predicted} -> ${expected}`);
    assert.strictEqual(sel.marketId, "1");
    assert.strictEqual(sel.eventId, "sb-ev-1");
    assert.strictEqual(sel.predictedOutcome, predicted.toLowerCase());
    assert.strictEqual(fetchCalls, 0, "matching never hits the network — booking happens once per run");
  }
});

await check("matchSportybetSelection: disabled config returns null, no fetch", async () => {
  seedEvents([cachedEvent()]);
  fetchCalls = 0;
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await matchSportybetSelection({
    config: { sportyBetBookingEnabled: false },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0, "no fetch when booking disabled");
});

await check("runner: dry-run early-return sits before the slip-selection hook (structural)", () => {
  const src = fs.readFileSync(new URL("../src/automation/runner.js", import.meta.url), "utf8");
  const dryRunIdx = src.indexOf("if (config.dryRun)");
  const selIdx = src.indexOf("await matchSportybetSelection(");
  const slipIdx = src.indexOf("await createCombinedSlip(");
  assert.ok(dryRunIdx !== -1, "dry-run guard exists in runner.js");
  assert.ok(selIdx !== -1, "matchSportybetSelection hook exists in runner.js");
  assert.ok(slipIdx !== -1, "createCombinedSlip hook exists in runner.js");
  assert.ok(dryRunIdx < selIdx, "dry-run return precedes the selection hook — dryRun=true never reaches booking");
});

await check("matchSportybetSelection: no fuzzy match -> skipped silently", async () => {
  seedEvents([cachedEvent({ homeTeam: "Real Madrid", awayTeam: "Barcelona", tournament: "Spain - La Liga" })]);
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await matchSportybetSelection({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
});

await check("matchSportybetSelection: no 1X2 odds -> skipped", async () => {
  seedEvents([cachedEvent({ odds: null })]);
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await matchSportybetSelection({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
});

await check("matchSportybetSelection: past kickoff -> skipped", async () => {
  seedEvents([cachedEvent({ kickoffISO: new Date(Date.now() - 3600 * 1000).toISOString() })]);
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await matchSportybetSelection({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
});

// ------------------------------------------- combined slip ---
await check("createCombinedSlip: one booking for N selections, one HTTP call", async () => {
  fetchBehavior = "ok";
  fetchCalls = 0;
  lastRequest = null;
  const selections = [
    { eventId: "sb-ev-1", marketId: "1", outcomeId: "1", fixtureId: "fx-1", homeTeam: "Arsenal", awayTeam: "Chelsea", predictedOutcome: "home" },
    { eventId: "sb-ev-2", marketId: "1", outcomeId: "2", fixtureId: "fx-2", homeTeam: "Real Madrid", awayTeam: "Barcelona", predictedOutcome: "draw" },
    { eventId: "sb-ev-3", marketId: "1", outcomeId: "3", fixtureId: "fx-3", homeTeam: "Inter", awayTeam: "Milan", predictedOutcome: "away" },
  ];
  const booking = await createCombinedSlip({
    id: "test-run-1",
    config: { sportyBetBookingEnabled: true },
    selections,
  });
  assert.ok(booking, "combined booking returned");
  assert.strictEqual(booking.shareCode, "WGB4BE");
  assert.strictEqual(fetchCalls, 1, "exactly one booking HTTP call for the whole slip");
  const sent = JSON.parse(lastRequest.opts.body);
  assert.strictEqual(sent.selections.length, 3, "all three selections in one slip");
  assert.deepStrictEqual(
    sent.selections.map((s) => s.outcomeId),
    ["1", "2", "3"]
  );
});

await check("createCombinedSlip: disabled config -> null, no fetch", async () => {
  fetchCalls = 0;
  const r = await createCombinedSlip({
    id: "test-run-2",
    config: { sportyBetBookingEnabled: false },
    selections: [{ eventId: "sb-ev-1", marketId: "1", outcomeId: "1", fixtureId: "fx-1" }],
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0, "no fetch when booking disabled");
});

await check("createCombinedSlip: booking failure is non-fatal, returns null", async () => {
  fetchBehavior = "throw";
  const r = await createCombinedSlip({
    id: "test-run-3",
    config: { sportyBetBookingEnabled: true },
    selections: [{ eventId: "sb-ev-1", marketId: "1", outcomeId: "1", fixtureId: "fx-1", homeTeam: "A", awayTeam: "B", predictedOutcome: "home" }],
  });
  assert.strictEqual(r, null, "never throws — failure is non-fatal");
  fetchBehavior = "ok";
});

await check("createCombinedSlip: empty selections -> null, no fetch", async () => {
  fetchCalls = 0;
  const r = await createCombinedSlip({
    id: "test-run-4",
    config: { sportyBetBookingEnabled: true },
    selections: [],
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0);
});

// -------------------------------------------------- run message ---
await check("formatRunMessage: cumulative tips + code, URL, deadline, slip-reservation wording", () => {
  const text = formatRunMessage({
    games: [
      {
        match: { home: { name: "Arsenal" }, away: { name: "Chelsea" }, league: { name: "Premier League" }, kickoff: FUTURE_KICKOFF },
        prediction: { predictedOutcome: "home", homeWin: 55, draw: 25, awayWin: 20, confidence: 72 },
      },
      {
        match: { home: { name: "Real Madrid" }, away: { name: "Barcelona" }, league: { name: "La Liga" }, kickoff: FUTURE_KICKOFF },
        prediction: { predictedOutcome: "draw", homeWin: 30, draw: 40, awayWin: 30, confidence: 65 },
      },
      {
        match: { home: { name: "Inter" }, away: { name: "Milan" }, league: { name: "Serie A" }, kickoff: FUTURE_KICKOFF },
        prediction: { predictedOutcome: "away", homeWin: 20, draw: 25, awayWin: 55, confidence: 70 },
      },
    ],
    booking: {
      shareCode: "WGB4BE",
      shareURL: "https://www.sportybet.com/ng/share/WGB4BE",
      deadline: "2026-10-10T17:30:00.000Z",
    },
  });
  assert.ok(text.includes("OBULU TIPS (3 games)"), "cumulative header with game count");
  assert.ok(text.includes("1. ⚽ Arsenal vs Chelsea"), "game 1 listed");
  assert.ok(text.includes("Pick: HOME (Arsenal)"), "home pick named");
  assert.ok(text.includes("Pick: DRAW (Draw)"), "draw pick named");
  assert.ok(text.includes("Pick: AWAY (Milan)"), "away pick named");
  assert.ok(text.includes("🎫 SportyBet booking code: WGB4BE"), "single code line present");
  assert.ok(text.includes("https://www.sportybet.com/ng/share/WGB4BE"), "URL line present");
  assert.ok(text.includes("code valid until"), "deadline line present");
  assert.ok(text.includes("Slip reservation only — no bet was placed."), "slip-reservation wording");
  assert.ok(!text.toLowerCase().includes("bet now"), "no betting call to action");
});

await check("formatRunMessage: tips still sent when booking is null (failed booking is non-fatal)", () => {
  const text = formatRunMessage({
    games: [
      {
        match: { home: { name: "Arsenal" }, away: { name: "Chelsea" }, kickoff: FUTURE_KICKOFF },
        prediction: { predictedOutcome: "home", homeWin: 55, draw: 25, awayWin: 20, confidence: 72 },
      },
    ],
    booking: null,
  });
  assert.ok(text.includes("OBULU TIPS (1 game)"), "tips still listed");
  assert.ok(text.includes("Arsenal vs Chelsea"), "tip content present");
  assert.ok(!text.includes("WGB4BE"), "no fabricated code on failure");
  assert.ok(text.includes("(no booking code this run)"), "honest fallback line");
});

globalThis.fetch = realFetch;

console.log(`\nsportybet-booking: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
