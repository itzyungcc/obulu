// OBULU Automation Agent — collector.
// Discovers upcoming fixtures from OBULU's configured data provider
// (football-data.org in production). The spec's Oddspedia investigation
// concluded there is no permitted machine-readable feed, so the provider
// OBULU already uses is the legitimate discovery source. Fixtures therefore
// arrive with authoritative provider IDs — no fragile cross-source matching.

import { getProvider, providerKind } from "../providers/index.js";
import { normalizeMatch } from "./normalizer.js";

const log = (...a) => console.log("[Automation][collector]", ...a);

export async function collectUpcoming({ maxHoursBeforeKickoff } = {}) {
  const provider = getProvider();
  if (!provider) {
    const err = new Error("PROVIDER_UNAVAILABLE");
    err.code = "PROVIDER_UNAVAILABLE";
    throw err;
  }

  const windowHours =
    Number.isFinite(maxHoursBeforeKickoff) && maxHoursBeforeKickoff > 0
      ? maxHoursBeforeKickoff
      : 72;

  let fixtures;
  try {
    fixtures = await provider.getUpcomingFixtures();
  } catch (e) {
    const err = new Error("PROVIDER_UNAVAILABLE");
    err.code = "PROVIDER_UNAVAILABLE";
    err.cause = e;
    throw err;
  }

  const now = Date.now();
  const cutoff = now + windowHours * 3600 * 1000;

  const out = [];
  for (const f of fixtures || []) {
    const kickoffMs = Date.parse(f.kickoff);
    if (!Number.isFinite(kickoffMs)) continue;
    // Only pre-match fixtures inside the discovery window.
    if (f.status !== "NS") continue;
    if (kickoffMs < now || kickoffMs > cutoff) continue;
    out.push(
      normalizeMatch({
        source: providerKind(),
        sourceMatchId: f.id,
        homeTeam: f.home?.name,
        awayTeam: f.away?.name,
        league: f.league?.name,
        leagueId: f.league?.id,
        kickoff: f.kickoff,
        status: f.status,
        fixture: f, // keep the raw provider fixture for the matcher
      })
    );
  }

  // Deduplicate by provider fixture id (defensive; provider should be unique).
  const seen = new Set();
  const deduped = out.filter((m) => {
    const key = `${m.source}:${m.sourceMatchId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  log(`discovered ${deduped.length} upcoming fixtures (window ${windowHours}h)`);
  return deduped;
}
