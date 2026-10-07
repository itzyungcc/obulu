// OBULU Jackpot analyzer — informational only.
// Accepts a list of jackpot games (team names as published by the bookmaker),
// fuzzy-matches them to OBULU's provider fixtures, and runs each through the
// ONE authoritative OBULU prediction engine (Poisson/Dixon-Coles).
// Read-only: no betting, no bookmaker interaction, no account access.

import express from "express";
import { getProvider } from "../providers/index.js";
import { sameTeam, normalizeTeamName } from "../automation/normalizer.js";
import { analyzeFixture } from "../automation/analyze.js";
import { cacheGet, cacheSet } from "../cache.js";
import { getCachedEvents, sportyBetEnabled } from "../sportybet/client.js";

const router = express.Router();

// Fixture cache: 7-day window, 15-min TTL. The automation scheduler also
// refreshes provider data on its own cadence; this keeps jackpot analyses
// fast without hammering the rate-limited provider API.
const FIXTURE_CACHE_KEY = "jackpot:fixtures:7d";

async function getUpcomingFixturesCached(provider) {
  const hit = cacheGet(FIXTURE_CACHE_KEY);
  if (hit) return hit;
  const fixtures = (await provider.getUpcomingFixtures()) || [];
  cacheSet(FIXTURE_CACHE_KEY, fixtures, "fixtures");
  return fixtures;
}

// Parse one pasted line into {home, away}. Accepts "Home vs Away",
// "Home v Away", "Home - Away", "Home – Away".
export function parseJackpotLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  const parts = s.split(/\s+(?:vs\.?|v\.?)\s+|\s+[-–—]\s+/i);
  if (parts.length !== 2) return null;
  const home = parts[0].trim();
  const away = parts[1].trim();
  if (!home || !away) return null;
  return { home, away };
}

// POST /api/jackpot/analyze  { games: [{home, away}] }  OR  { eventIds: [...] }  (max 20)
// The eventIds path uses SportyBet upcoming-event ids (see /api/sportybet/events)
// and passes the event's 1X2 odds into the model so the prediction is odds-aware.
router.post("/analyze", async (req, res) => {
  try {
    const body = req.body || {};
    const useEventIds = Array.isArray(body.eventIds);

    // Resolve each requested game to {home, away, odds?, sportyBetEventId?}.
    let entries;
    if (useEventIds) {
      const eventIds = body.eventIds;
      if (eventIds.length === 0) {
        return res.status(400).json({ error: "Provide eventIds: [...] or games: [{home, away}]" });
      }
      if (eventIds.length > 20) {
        return res.status(400).json({ error: "Maximum 20 games per request" });
      }
      if (!sportyBetEnabled()) {
        return res.status(503).json({ error: "SPORTYBET_DISABLED" });
      }
      let sbEvents;
      try {
        sbEvents = (await getCachedEvents()).events;
      } catch (e) {
        return res.status(502).json({ error: "SPORTYBET_UNAVAILABLE" });
      }
      const byId = new Map(sbEvents.map((e) => [String(e.eventId), e]));
      entries = eventIds.map((id) => {
        const ev = byId.get(String(id));
        if (!ev) return { sportyBetEventId: String(id), unknown: true };
        return {
          home: ev.homeTeam,
          away: ev.awayTeam,
          odds: ev.odds || null,
          sportyBetEventId: ev.eventId,
        };
      });
    } else {
      const games = body.games;
      if (!Array.isArray(games) || games.length === 0) {
        return res.status(400).json({ error: "Provide games: [{home, away}]" });
      }
      if (games.length > 20) {
        return res.status(400).json({ error: "Maximum 20 games per request" });
      }
      entries = games.map((g) => ({
        home: String(g.home || "").trim(),
        away: String(g.away || "").trim(),
        odds: null,
        sportyBetEventId: null,
      }));
    }

    const provider = getProvider();
    if (!provider) {
      return res.status(503).json({ error: "PROVIDER_UNAVAILABLE" });
    }

    // One fetch of upcoming fixtures (7-day window covers weekend jackpots),
    // served from cache when fresh.
    let fixtures = [];
    try {
      fixtures = await getUpcomingFixturesCached(provider);
    } catch (e) {
      return res.status(503).json({ error: "PROVIDER_UNAVAILABLE", detail: e.message });
    }
    const now = Date.now();
    const upcoming = fixtures.filter(
      (f) => f.status === "NS" && Date.parse(f.kickoff) >= now - 3600 * 1000
    );

    const results = [];
    for (const g of entries) {
      if (g.unknown) {
        results.push({
          sportyBetEventId: g.sportyBetEventId,
          matched: false,
          reason: "unknown SportyBet event",
          oddsUsed: false,
        });
        continue;
      }
      const home = g.home || "";
      const away = g.away || "";
      if (!home || !away) {
        results.push({ home, away, matched: false, reason: "empty team name", oddsUsed: false, sportyBetEventId: g.sportyBetEventId || null });
        continue;
      }

      // Fuzzy match against provider fixtures (both teams must agree).
      const fixture = upcoming.find(
        (f) => sameTeam(f.home?.name, home) && sameTeam(f.away?.name, away)
      );
      if (!fixture) {
        results.push({
          home,
          away,
          matched: false,
          reason: "no upcoming fixture found for these teams",
          oddsUsed: false,
          sportyBetEventId: g.sportyBetEventId || null,
        });
        continue;
      }

      try {
        const analysis = await analyzeFixture(fixture, g.odds ? { odds: g.odds } : {});
        const p = analysis.prediction;
        const pick =
          p.predictedOutcome === "home"
            ? "1"
            : p.predictedOutcome === "away"
              ? "2"
              : "X";
        results.push({
          home: fixture.home.name,
          away: fixture.away.name,
          matched: true,
          kickoff: fixture.kickoff,
          league: fixture.league?.name || null,
          pick,
          probabilities: {
            home: Math.round(p.homeWin),
            draw: Math.round(p.draw),
            away: Math.round(p.awayWin),
          },
          confidence: Math.round(p.confidence ?? 0),
          confidenceLabel: p.confidenceLabel || null,
          expectedGoals: {
            home: p.expectedHomeGoals,
            away: p.expectedAwayGoals,
          },
          oddsUsed: p.blendedWithOdds === true,
          sportyBetEventId: g.sportyBetEventId || null,
        });
      } catch (e) {
        results.push({
          home: fixture.home.name,
          away: fixture.away.name,
          matched: false,
          reason: `analysis failed: ${e.code || e.message}`,
          oddsUsed: false,
          sportyBetEventId: g.sportyBetEventId || null,
        });
      }
    }

    res.json({
      analyzedAt: new Date().toISOString(),
      total: results.length,
      matched: results.filter((r) => r.matched).length,
      results,
      disclaimer:
        "Statistical analysis for information only. Not betting advice.",
    });
  } catch (e) {
    console.error("[Jackpot]", e);
    res.status(500).json({ error: "ANALYSIS_FAILED", detail: e.message });
  }
});

// GET /api/jackpot/health — quick check the provider is reachable.
router.get("/health", async (_req, res) => {
  const provider = getProvider();
  res.json({ provider: !!provider, ok: !!provider });
});

export default router;
