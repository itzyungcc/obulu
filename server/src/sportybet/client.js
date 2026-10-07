// SportyBet upcoming-events fetch client — informational data only.
//
// Unofficial endpoint (https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents),
// no API key. SportyBet may change, rate-limit, or block it at any time —
// treat every failure as a clean error, NEVER synthesize or return fake events.
// Fetch technique mirrors the standalone sportybet-api reference (params and
// browser-mimicking headers) but ports only the upcoming-events fetching and
// 1X2 odds extraction. Share-booking creation (server/src/sportybet/booking.js)
// was explicitly authorized by the user on 2026-10-07 — booking codes are slip
// reservations only, never placed bets; nothing else betting-related is ported.

import { cacheGet, cacheSet } from "../cache.js";

const SPORTYBET_BASE = "https://www.sportybet.com";
const EVENTS_PATH = "/api/ng/factsCenter/pcUpcomingEvents";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const PAGE_PACING_MS = 1000;

export const SPORTYBET_CACHE_KEY = "sportybet:events";

const MARKET_IDS = "1,18,10,29,11,26,36,14,16,45,47,60,60100";

export const SPORTYBET_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "Current-Country": "NG",
  "Current-Language": "en",
  Origin: "https://www.sportybet.com",
  Referer: "https://www.sportybet.com/ng/",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
};

export function sportyBetEnabled() {
  return process.env.SPORTYBET_ENABLED !== "false";
}

function checkEnabled() {
  if (!sportyBetEnabled()) {
    const err = new Error("SPORTYBET_DISABLED");
    err.code = "SPORTYBET_DISABLED";
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch one page of upcoming football (soccer) events.
export async function fetchEventsPage(page = 1) {
  checkEnabled();
  const url =
    `${SPORTYBET_BASE}${EVENTS_PATH}` +
    `?sportId=sr:sport:1` +
    `&marketId=${MARKET_IDS}` +
    `&pageSize=${PAGE_SIZE}` +
    `&pageNum=${page}` +
    `&todayGames=false` +
    `&timeline=720` +
    `&_t=${Date.now()}`;

  let response;
  try {
    response = await fetch(url, { method: "GET", headers: SPORTYBET_HEADERS });
  } catch (e) {
    throw new Error(`SportyBet request failed: ${e.message}`);
  }

  if (!response.ok) {
    throw new Error(`SportyBet HTTP ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("SportyBet returned invalid JSON");
  }
  return data;
}

function tournamentEvents(data) {
  return Array.isArray(data?.data?.tournaments) ? data.data.tournaments : [];
}

// Normalize one raw SportyBet event to OBULU's event shape.
// Returns null when the event is missing teams or a kickoff time.
export function normalizeEvent(e, tournamentName) {
  if (!e || typeof e !== "object") return null;

  const homeTeam = String(e.homeTeamName || "").trim();
  const awayTeam = String(e.awayTeamName || "").trim();
  const kickoffMs = Number(e.estimateStartTime);
  if (!homeTeam || !awayTeam || !Number.isFinite(kickoffMs) || kickoffMs <= 0) {
    return null;
  }

  return {
    eventId: String(e.eventId ?? ""),
    homeTeam,
    awayTeam,
    kickoffISO: new Date(kickoffMs).toISOString(),
    tournament: tournamentName || String(e.sport?.category?.tournament?.name || "") || null,
    odds: extract1x2Odds(e),
  };
}

// Extract decimal 1X2 odds from the event's markets. Market id "1" is the 1X2
// (Full Time Result) market; outcomes id "1" -> home, "2" -> draw, "3" -> away
// (fall back to desc "Home"/"Draw"/"Away"). Returns null when the market or
// any outcome odds are missing/invalid.
export function extract1x2Odds(e) {
  const markets = Array.isArray(e?.markets) ? e.markets : [];
  const m1x2 = markets.find((m) => m && String(m.id) === "1");
  if (!m1x2 || !Array.isArray(m1x2.outcomes)) return null;

  const byId = { home: "1", draw: "2", away: "3" };
  const byDesc = { home: "home", draw: "draw", away: "away" };
  const odds = {};
  for (const key of ["home", "draw", "away"]) {
    const outcome = m1x2.outcomes.find((o) => {
      if (!o) return false;
      if (String(o.id) === byId[key]) return true;
      const desc = String(o.desc || "").trim().toLowerCase();
      return desc === byDesc[key];
    });
    const value = outcome ? parseFloat(outcome.odds) : NaN;
    if (!Number.isFinite(value) || value < 1.01) return null;
    odds[key] = value;
  }
  return odds;
}

// Fetch all upcoming events (sequential pages with pacing; stops early when a
// page is short). Returns an array of normalized events.
export async function getAllEvents({ maxPages = MAX_PAGES } = {}) {
  checkEnabled();
  const events = [];
  const limit = Math.max(1, Math.min(maxPages, 10));
  for (let page = 1; page <= limit; page++) {
    const data = await fetchEventsPage(page);
    let count = 0;
    for (const t of tournamentEvents(data)) {
      const tName = t?.name || "";
      for (const e of Array.isArray(t?.events) ? t.events : []) {
        const norm = normalizeEvent(e, tName);
        if (norm) {
          events.push(norm);
          count++;
        }
      }
    }
    if (count < PAGE_SIZE) break; // short page: no more data
    if (page < limit) await sleep(PAGE_PACING_MS);
  }
  return events;
}

// Cached events: 15-min TTL via the shared fixtures TTL. Returns
// { events, cachedAt } (cachedAt is ISO; set at fetch time).
export async function getCachedEvents() {
  checkEnabled();
  const hit = cacheGet(SPORTYBET_CACHE_KEY);
  if (hit) return hit;
  const events = await getAllEvents();
  const payload = { events, cachedAt: new Date().toISOString() };
  cacheSet(SPORTYBET_CACHE_KEY, payload, "fixtures");
  return payload;
}
