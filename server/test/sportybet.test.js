// SportyBet integration tests — plain node asserts, run with `npm test`.
// Covers: normalizeEvent 1X2 odds extraction (market id "1", outcome ids
// 1/2/3, plus desc fallback), missing-1X2-market -> odds null,
// estimateStartTime epoch ms -> kickoffISO, events missing teams/kickoff
// are skipped (null), route-level search/filter/pagination over a stubbed
// cached event list, the tournaments list, cache-hit (no refetch) and
// expired-cache (refetch) behaviour, analyze-with-eventIds end-to-end
// (known id -> matched + oddsUsed + sportyBetEventId; unknown id ->
// matched:false), and graceful failure when the upstream fetch throws.
// No live network: global fetch is stubbed (localhost passes through so the
// in-process express server is reachable), and the cache is seeded on a
// scratch DB — never the dev database.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-sportybet-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;
process.env.SAMPLE_DATA = "true"; // sample provider for the jackpot path
process.env.SPORTYBET_ENABLED = "true";

const {
  normalizeEvent,
  getCachedEvents,
  SPORTYBET_CACHE_KEY,
} = await import("../src/sportybet/client.js");
const { cacheSet, cacheInvalidate, CACHE_VERSION } = await import("../src/cache.js");
const { db } = await import("../src/db/database.js");
const { default: sportybetRouter } = await import("../src/routes/sportybet.js");
const { default: jackpotRouter } = await import("../src/routes/jackpot.js");
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

// ------------------------------------------------------------ fixtures ---
const KICKOFF_MS = Date.parse("2026-10-10T17:30:00Z");

// Raw SportyBet-shaped event (as the unofficial upcoming-events endpoint
// returns it).
const sbRaw = (over = {}) => ({
  eventId: "sb-1",
  homeTeamName: "Arsenal",
  awayTeamName: "Chelsea",
  estimateStartTime: KICKOFF_MS,
  markets: [
    {
      id: "1",
      outcomes: [
        { id: "1", desc: "Home", odds: "2.10" },
        { id: "2", desc: "Draw", odds: "3.40" },
        { id: "3", desc: "Away", odds: "3.60" },
      ],
    },
    { id: "18", outcomes: [{ id: "1", odds: "1.90" }] },
  ],
  ...over,
});

// Normalized event, as getCachedEvents() serves it.
const sbNorm = (over = {}) => ({
  eventId: "sb-1",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  kickoffISO: new Date(KICKOFF_MS).toISOString(),
  tournament: "England - Premier League",
  odds: { home: 2.1, draw: 3.4, away: 3.6 },
  ...over,
});

function seedSportyBetCache(events) {
  cacheSet(SPORTYBET_CACHE_KEY, { events, cachedAt: "2026-10-07T00:00:00.000Z" }, "fixtures");
}

// ------------------------------------------------------- stubbed fetch ---
const realFetch = globalThis.fetch.bind(globalThis);
let fetchCalls = 0;
let fetchBehavior = "ok"; // "ok" | "throw"

const fetchPayload = {
  data: {
    tournaments: [
      {
        name: "England - Premier League",
        events: [sbRaw({ eventId: "sb-net-1" })],
      },
    ],
  },
};

globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (s.includes("localhost") || s.includes("127.0.0.1")) {
    return realFetch(url, opts); // in-process express server passes through
  }
  fetchCalls++;
  if (fetchBehavior === "throw") {
    throw new Error("boom");
  }
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(fetchPayload)),
  };
};

// ------------------------------------------------------ express server ---
const app = express();
app.use(express.json());
app.use("/api/sportybet", sportybetRouter);
app.use("/api/jackpot", jackpotRouter);
const httpServer = app.listen(0);
await new Promise((r) => httpServer.on("listening", r));
const base = `http://localhost:${httpServer.address().port}/api`;
const get = (path) => realFetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.json() }));

// --------------------------------------------- normalizeEvent: 1X2 odds ---
await check("normalizeEvent extracts 1X2 odds from market id 1 (outcome ids 1/2/3)", () => {
  const n = normalizeEvent(sbRaw(), "England - Premier League");
  assert.ok(n, "expected a normalized event");
  assert.deepStrictEqual(n.odds, { home: 2.1, draw: 3.4, away: 3.6 });
  assert.strictEqual(n.homeTeam, "Arsenal");
  assert.strictEqual(n.awayTeam, "Chelsea");
  assert.strictEqual(n.eventId, "sb-1");
  assert.strictEqual(n.tournament, "England - Premier League");
});

await check("normalizeEvent falls back to outcome desc Home/Draw/Away", () => {
  const n = normalizeEvent(
    sbRaw({
      markets: [
        {
          id: "1",
          outcomes: [
            { id: "101", desc: "Home", odds: "1.95" },
            { id: "102", desc: "Draw", odds: "3.55" },
            { id: "103", desc: "Away", odds: "4.00" },
          ],
        },
      ],
    })
  );
  assert.deepStrictEqual(n.odds, { home: 1.95, draw: 3.55, away: 4.0 });
});

await check("normalizeEvent odds null when the 1X2 market is missing", () => {
  const noMarkets = normalizeEvent(sbRaw({ markets: [] }));
  assert.ok(noMarkets && noMarkets.odds === null, "no markets at all");
  const otherMarkets = normalizeEvent(sbRaw({ markets: [{ id: "18", outcomes: [{ id: "1", odds: "1.90" }] }] }));
  assert.ok(otherMarkets && otherMarkets.odds === null, "market 18 only");
});

await check("normalizeEvent odds null when a 1X2 outcome is missing or invalid", () => {
  const missing = normalizeEvent(
    sbRaw({
      markets: [{ id: "1", outcomes: [{ id: "1", desc: "Home", odds: "2.10" }] }],
    })
  );
  assert.ok(missing && missing.odds === null, "draw/away absent");
  const junk = normalizeEvent(
    sbRaw({
      markets: [
        {
          id: "1",
          outcomes: [
            { id: "1", desc: "Home", odds: "2.10" },
            { id: "2", desc: "Draw", odds: "3.40" },
            { id: "3", desc: "Away", odds: "abc" },
          ],
        },
      ],
    })
  );
  assert.ok(junk && junk.odds === null, "non-numeric odds");
});

await check("normalizeEvent converts estimateStartTime epoch ms to kickoffISO", () => {
  const n = normalizeEvent(sbRaw());
  assert.strictEqual(n.kickoffISO, new Date(KICKOFF_MS).toISOString());
  assert.strictEqual(n.kickoffISO, "2026-10-10T17:30:00.000Z");
});

await check("normalizeEvent falls back to event.sport.category.tournament.name, else null", () => {
  const nested = normalizeEvent(sbRaw({ sport: { category: { tournament: { name: "Nested Cup" } } } }));
  assert.strictEqual(nested.tournament, "Nested Cup");
  const none = normalizeEvent(sbRaw());
  assert.strictEqual(none.tournament, null);
});

await check("normalizeEvent skips events missing teams or kickoff", () => {
  assert.strictEqual(normalizeEvent(sbRaw({ homeTeamName: "" })), null, "empty home");
  assert.strictEqual(normalizeEvent(sbRaw({ awayTeamName: "  " })), null, "blank away");
  assert.strictEqual(normalizeEvent(sbRaw({ homeTeamName: undefined })), null, "missing home");
  assert.strictEqual(normalizeEvent(sbRaw({ estimateStartTime: 0 })), null, "zero kickoff");
  assert.strictEqual(normalizeEvent(sbRaw({ estimateStartTime: -5 })), null, "negative kickoff");
  assert.strictEqual(normalizeEvent(sbRaw({ estimateStartTime: undefined })), null, "missing kickoff");
  assert.strictEqual(normalizeEvent(null), null, "null event");
  assert.strictEqual(normalizeEvent("nope"), null, "non-object event");
});

// --------------------------------------------- route: search / filter -----
const CACHED_EVENTS = [
  sbNorm({ eventId: "sb-1", homeTeam: "Arsenal", awayTeam: "Chelsea", kickoffISO: "2026-10-10T17:30:00.000Z", tournament: "England - Premier League" }),
  sbNorm({ eventId: "sb-2", homeTeam: "Liverpool", awayTeam: "Manchester City", kickoffISO: "2026-10-10T15:00:00.000Z", tournament: "England - Premier League", odds: { home: 2.4, draw: 3.3, away: 2.9 } }),
  sbNorm({ eventId: "sb-3", homeTeam: "Real Madrid", awayTeam: "Barcelona", kickoffISO: "2026-10-11T20:00:00.000Z", tournament: "Spain - La Liga", odds: null }),
];

await check("events: q matches team name case-insensitively, soonest first", async () => {
  seedSportyBetCache(CACHED_EVENTS);
  fetchCalls = 0;
  const { status, body } = await get("/sportybet/events?q=arsenal");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.events[0].eventId, "sb-1");
  assert.strictEqual(body.events[0].kickoff, "2026-10-10T17:30:00.000Z");
  assert.deepStrictEqual(body.events[0].odds, { home: 2.1, draw: 3.4, away: 3.6 });

  const up = await get("/sportybet/events?q=CHELSEA");
  assert.strictEqual(up.body.total, 1, "case-insensitive match");

  const combo = await get(`/sportybet/events?q=${encodeURIComponent("arsenal vs chelsea")}`);
  assert.strictEqual(combo.body.total, 1, "home vs away combo matches");

  const city = await get("/sportybet/events?q=city");
  assert.strictEqual(city.body.total, 1);
  assert.strictEqual(city.body.events[0].eventId, "sb-2");
  assert.strictEqual(fetchCalls, 0, "served from cache, no network");
});

await check("events: tournament filter is exact, pagination math holds", async () => {
  seedSportyBetCache(CACHED_EVENTS);
  const { status, body } = await get(`/sportybet/events?tournament=${encodeURIComponent("Spain - La Liga")}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.events[0].eventId, "sb-3");

  const loose = await get("/sportybet/events?tournament=La%20Liga");
  assert.strictEqual(loose.body.total, 0, "non-exact tournament must not match");

  const p1 = await get("/sportybet/events?limit=2&page=1");
  assert.strictEqual(p1.body.total, 3);
  assert.strictEqual(p1.body.page, 1);
  assert.strictEqual(p1.body.totalPages, 2);
  assert.strictEqual(p1.body.events.length, 2);
  // Soonest kickoff first.
  assert.strictEqual(p1.body.events[0].eventId, "sb-2");
  assert.strictEqual(p1.body.events[1].eventId, "sb-1");
  assert.strictEqual(typeof p1.body.cachedAt, "string", "cachedAt surfaced");

  const p2 = await get("/sportybet/events?limit=2&page=2");
  assert.strictEqual(p2.body.events.length, 1);
  assert.strictEqual(p2.body.events[0].eventId, "sb-3");
});

await check("tournaments: distinct names, sorted", async () => {
  seedSportyBetCache(CACHED_EVENTS);
  const { status, body } = await get("/sportybet/tournaments");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.tournaments, ["England - Premier League", "Spain - La Liga"]);
});

// ------------------------------------------------------------- caching ---
await check("cache-hit: second getCachedEvents does not refetch", async () => {
  cacheInvalidate("sportybet:");
  fetchCalls = 0;
  fetchBehavior = "ok";
  const first = await getCachedEvents();
  assert.strictEqual(fetchCalls, 1, "first call fetches");
  assert.strictEqual(first.events.length, 1);
  assert.strictEqual(first.events[0].eventId, "sb-net-1");
  assert.deepStrictEqual(first.events[0].odds, { home: 2.1, draw: 3.4, away: 3.6 }, "network events normalized");
  const second = await getCachedEvents();
  assert.strictEqual(fetchCalls, 1, "second call is a cache hit");
  assert.deepStrictEqual(second.events, first.events);
});

await check("expired cache refetches", async () => {
  fetchCalls = 0;
  db.prepare("UPDATE cache_meta SET expires_at = ? WHERE key = ?")
    .run(new Date(Date.now() - 1000).toISOString(), CACHE_VERSION + SPORTYBET_CACHE_KEY);
  const again = await getCachedEvents();
  assert.strictEqual(fetchCalls, 1, "expired cache triggers refetch");
  assert.strictEqual(again.events.length, 1);
});

// ---------------------------------------------------- graceful failure ---
await check("fetch failure surfaces a clean error, never fake events", async () => {
  cacheInvalidate("sportybet:");
  fetchBehavior = "throw";
  await assert.rejects(getCachedEvents(), /SportyBet request failed: boom/);

  const { status, body } = await get("/sportybet/events");
  assert.strictEqual(status, 502);
  assert.strictEqual(body.error, "SPORTYBET_UNAVAILABLE");
  assert.strictEqual(body.events, undefined, "no events key on error");

  fetchBehavior = "ok";
});

await check("SPORTYBET_ENABLED=false -> 503 SPORTYBET_DISABLED", async () => {
  process.env.SPORTYBET_ENABLED = "false";
  const { status, body } = await get("/sportybet/events");
  assert.strictEqual(status, 503);
  assert.strictEqual(body.error, "SPORTYBET_DISABLED");
  const t = await get("/sportybet/tournaments");
  assert.strictEqual(t.status, 503);
  process.env.SPORTYBET_ENABLED = "true";
});

// --------------------------------- jackpot analyze with eventIds (e2e) ----
await check("analyze eventIds: known id matched with oddsUsed, unknown id unmatched", async () => {
  // sb-known mirrors a sample-provider fixture (Arsenal vs Chelsea) so the
  // fuzzy match resolves; sb-nope does not exist in the SportyBet cache.
  seedSportyBetCache([
    sbNorm({
      eventId: "sb-known",
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      kickoffISO: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      odds: { home: 2.1, draw: 3.4, away: 3.6 },
    }),
  ]);
  fetchCalls = 0;

  const res = await realFetch(`${base}/jackpot/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventIds: ["sb-known", "sb-nope"] }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.strictEqual(body.total, 2);
  assert.strictEqual(body.matched, 1);

  const known = body.results.find((r) => r.sportyBetEventId === "sb-known");
  assert.ok(known, "known result present");
  assert.strictEqual(known.matched, true);
  assert.strictEqual(known.home, "Arsenal");
  assert.strictEqual(known.away, "Chelsea");
  assert.strictEqual(known.oddsUsed, true, "1X2 odds passed into the model");
  assert.ok(["1", "X", "2"].includes(known.pick), "pick is a 1X2 code");
  assert.ok(known.probabilities && Number.isFinite(known.probabilities.home), "probabilities present");

  const unknown = body.results.find((r) => r.sportyBetEventId === "sb-nope");
  assert.ok(unknown, "unknown result present");
  assert.strictEqual(unknown.matched, false);
  assert.strictEqual(unknown.oddsUsed, false);

  assert.strictEqual(fetchCalls, 0, "SportyBet side served from cache, no network");
});

await check("analyze eventIds: empty list rejected with 400", async () => {
  seedSportyBetCache([sbNorm()]);
  const res = await realFetch(`${base}/jackpot/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventIds: [] }),
  });
  assert.strictEqual(res.status, 400);
});

httpServer.close();
globalThis.fetch = realFetch;

console.log(`\nsportybet: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
