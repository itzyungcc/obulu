// SportyBet share-booking tests — plain node asserts, run with `npm test`.
// Covers: createBooking success (stubbed fetch), HTTP error, 200 without
// shareCode (never fabricates), non-JSON body, invalid selections input
// (no HTTP attempted), HOME/DRAW/AWAY -> outcome id 1/2/3 mapping,
// disabled config -> null with no fetch, dry-run hook placement
// (structural), failure-is-non-fatal (stubbed fetch throw -> null, alert
// still goes out without a code), no fuzzy match -> silent skip, and the
// notifier booking block (code/deadline shown, slip-reservation wording,
// omitted entirely when booking is null).
// No live network: global fetch is stubbed and the SportyBet cache is
// seeded on a scratch DB — never the dev database.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-sportybet-booking-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;
process.env.SPORTYBET_ENABLED = "true";

const { createBooking } = await import("../src/sportybet/booking.js");
const { maybeCreateBooking } = await import("../src/automation/runner.js");
const { formatAlertMessage } = await import("../src/automation/notifier.js");
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
await check("maybeCreateBooking maps HOME->1, DRAW->2, AWAY->3", async () => {
  for (const [predicted, expected] of [["HOME", "1"], ["draw", "2"], ["Away", "3"]]) {
    seedEvents([cachedEvent()]);
    fetchBehavior = "ok";
    lastRequest = null;
    const { analysis, prediction, fixtureId } = analysisFor(predicted);
    const booking = await maybeCreateBooking({
      config: { sportyBetBookingEnabled: true },
      analysis,
      prediction,
      fixtureId,
    });
    assert.ok(booking, `booking returned for ${predicted}`);
    assert.strictEqual(booking.shareCode, "WGB4BE");
    assert.strictEqual(booking.eventId, "sb-ev-1");
    assert.strictEqual(booking.predictedOutcome, predicted.toLowerCase());
    const sent = JSON.parse(lastRequest.opts.body);
    assert.strictEqual(sent.selections[0].outcomeId, expected, `${predicted} -> ${expected}`);
    assert.strictEqual(sent.selections[0].marketId, "1");
  }
});

await check("maybeCreateBooking: disabled config returns null, no fetch", async () => {
  seedEvents([cachedEvent()]);
  fetchCalls = 0;
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await maybeCreateBooking({
    config: { sportyBetBookingEnabled: false },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0, "no fetch when booking disabled");
});

await check("runner: dry-run early-return sits before the booking hook (structural)", () => {
  const src = fs.readFileSync(new URL("../src/automation/runner.js", import.meta.url), "utf8");
  const dryRunIdx = src.indexOf("if (config.dryRun)");
  const bookingIdx = src.indexOf("await maybeCreateBooking(");
  assert.ok(dryRunIdx !== -1, "dry-run guard exists in runner.js");
  assert.ok(bookingIdx !== -1, "maybeCreateBooking hook exists in runner.js");
  assert.ok(dryRunIdx < bookingIdx, "dry-run return precedes the booking hook — dryRun=true never reaches booking");
});

await check("maybeCreateBooking: fetch failure is non-fatal, returns null", async () => {
  seedEvents([cachedEvent()]);
  fetchBehavior = "throw";
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await maybeCreateBooking({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null, "never throws — failure is non-fatal");
  fetchBehavior = "ok";
});

await check("maybeCreateBooking: no fuzzy match -> skipped silently, no fetch", async () => {
  seedEvents([cachedEvent({ homeTeam: "Real Madrid", awayTeam: "Barcelona", tournament: "Spain - La Liga" })]);
  fetchCalls = 0;
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await maybeCreateBooking({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0, "no HTTP without a matching event");
});

await check("maybeCreateBooking: no 1X2 odds -> skipped, no fetch", async () => {
  seedEvents([cachedEvent({ odds: null })]);
  fetchCalls = 0;
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await maybeCreateBooking({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0, "no HTTP when the event has no 1X2 odds");
});

await check("maybeCreateBooking: past kickoff -> skipped, no fetch", async () => {
  seedEvents([cachedEvent({ kickoffISO: new Date(Date.now() - 3600 * 1000).toISOString() })]);
  fetchCalls = 0;
  const { analysis, prediction, fixtureId } = analysisFor("HOME");
  const r = await maybeCreateBooking({
    config: { sportyBetBookingEnabled: true },
    analysis,
    prediction,
    fixtureId,
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fetchCalls, 0, "no HTTP for a match that already kicked off");
});

// -------------------------------------------------- notifier booking block ---
const basePayload = () => ({
  match: {
    home: { name: "Arsenal" },
    away: { name: "Chelsea" },
    league: { name: "England - Premier League" },
    kickoff: FUTURE_KICKOFF,
  },
  prediction: {
    predictedOutcome: "HOME",
    homeWin: 55,
    draw: 25,
    awayWin: 20,
    confidence: 72,
    dataCompleteness: 88,
  },
  modelVersion: "v1",
  qualification: { qualified: true },
});

await check("formatAlertMessage: booking block shows code, URL, deadline + slip-reservation wording", () => {
  const text = formatAlertMessage({
    ...basePayload(),
    booking: {
      shareCode: "WGB4BE",
      shareURL: "https://www.sportybet.com/ng/share/WGB4BE",
      deadline: "2026-10-10T17:30:00.000Z",
    },
  });
  assert.ok(text.includes("🎫 SportyBet booking code: WGB4BE"), "code line present");
  assert.ok(text.includes("https://www.sportybet.com/ng/share/WGB4BE"), "URL line present");
  assert.ok(text.includes("code valid until"), "deadline line present");
  assert.ok(text.includes("Slip reservation only — no bet was placed."), "slip-reservation wording");
});

await check("formatAlertMessage: no booking block when booking is null (failed booking still alerts)", () => {
  const text = formatAlertMessage({ ...basePayload(), booking: null });
  assert.ok(!text.includes("booking code"), "no booking block without a booking");
  assert.ok(text.includes("OBULU QUALIFIED MATCH"), "alert text still produced");
  const failed = formatAlertMessage({ ...basePayload(), booking: null });
  assert.ok(!failed.includes("WGB4BE"), "no fabricated code on failure");
});

globalThis.fetch = realFetch;

console.log(`\nsportybet-booking: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
