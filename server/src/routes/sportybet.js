// OBULU SportyBet events router — informational only.
// Read-only browsing of upcoming SportyBet football events (no betting,
// no booking codes, no account access). Data comes from SportyBet's
// unofficial upcoming-events endpoint via ../sportybet/client.js; served
// from a 15-minute server-side cache.

import express from "express";
import { getCachedEvents, sportyBetEnabled } from "../sportybet/client.js";

const router = express.Router();

function mapDisabledError(e, res) {
  if (e?.code === "SPORTYBET_DISABLED") {
    return res.status(503).json({ error: "SPORTYBET_DISABLED" });
  }
  return res.status(502).json({ error: "SPORTYBET_UNAVAILABLE" });
}

// GET /api/sportybet/events?q=&tournament=&page=1&limit=20
// q matches "home vs away" or either team name, case-insensitive.
// tournament is an exact match against the tournament name.
router.get("/events", async (req, res) => {
  try {
    if (!sportyBetEnabled()) {
      return res.status(503).json({ error: "SPORTYBET_DISABLED" });
    }
    const { events, cachedAt } = await getCachedEvents();

    const q = String(req.query.q || "").trim().toLowerCase();
    const tournament = String(req.query.tournament || "").trim();

    let filtered = events;
    if (tournament) {
      filtered = filtered.filter((e) => e.tournament === tournament);
    }
    if (q) {
      filtered = filtered.filter((e) => {
        const combo = `${e.homeTeam} vs ${e.awayTeam}`.toLowerCase();
        return (
          combo.includes(q) ||
          e.homeTeam.toLowerCase().includes(q) ||
          e.awayTeam.toLowerCase().includes(q)
        );
      });
    }

    // Soonest kickoff first.
    filtered = filtered
      .slice()
      .sort((a, b) => Date.parse(a.kickoffISO) - Date.parse(b.kickoffISO));

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const pageItems = filtered.slice((page - 1) * limit, page * limit);

    res.json({
      events: pageItems.map((e) => ({
        eventId: e.eventId,
        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,
        kickoff: e.kickoffISO,
        tournament: e.tournament,
        odds: e.odds,
      })),
      total,
      page,
      totalPages,
      cachedAt,
    });
  } catch (e) {
    mapDisabledError(e, res);
  }
});

// GET /api/sportybet/tournaments — distinct tournament names, sorted.
router.get("/tournaments", async (req, res) => {
  try {
    if (!sportyBetEnabled()) {
      return res.status(503).json({ error: "SPORTYBET_DISABLED" });
    }
    const { events, cachedAt } = await getCachedEvents();
    const names = [...new Set(events.map((e) => e.tournament).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    res.json({ tournaments: names, cachedAt });
  } catch (e) {
    mapDisabledError(e, res);
  }
});

export default router;
