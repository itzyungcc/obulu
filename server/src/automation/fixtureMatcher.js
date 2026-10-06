// OBULU Automation Agent — fixture matcher.
// Because discovery runs against OBULU's own provider, every fixture arrives
// with an authoritative provider ID and is already "matched". This module
// exists to (a) validate the fixture is still a genuine pre-match fixture,
// (b) score matching confidence, and (c) keep the pipeline interface ready
// for a future external discovery source — where strict name/date/league
// matching (never silent guessing) would live.

import { getProvider } from "../providers/index.js";
import { sameTeam } from "./normalizer.js";

const log = (...a) => console.log("[Automation][matcher]", ...a);

export async function matchFixture(normalized) {
  const provider = getProvider();

  // Fast path: provider-native fixture with a valid id.
  if (normalized.sourceMatchId && provider) {
    try {
      const live = await provider.getMatch(normalized.sourceMatchId);
      if (!live) {
        return unmatched(normalized, "FIXTURE_MATCH_FAILED", "fixture no longer exists at provider");
      }
      if (live.status !== "NS") {
        return unmatched(
          normalized,
          "FIXTURE_MATCH_FAILED",
          `fixture status is ${live.status}, not pre-match`
        );
      }
      // Sanity: provider's own teams must agree with the discovered names.
      const homeOk = sameTeam(live.home?.name, normalized.homeTeam);
      const awayOk = sameTeam(live.away?.name, normalized.awayTeam);
      if (!homeOk || !awayOk) {
        return unmatched(
          normalized,
          "FIXTURE_MATCH_FAILED",
          "provider team names disagree with discovered fixture"
        );
      }
      return {
        outcome: "matched",
        fixtureId: String(live.id),
        confidence: 1.0,
        fixture: live,
        reason: null,
      };
    } catch (e) {
      return {
        outcome: "error",
        fixtureId: null,
        confidence: 0,
        fixture: null,
        reason: "PROVIDER_UNAVAILABLE",
        error: e,
      };
    }
  }

  return unmatched(normalized, "FIXTURE_MATCH_FAILED", "no provider fixture id");
}

function unmatched(normalized, code, reason) {
  log(`unmatched ${normalized.homeTeam} vs ${normalized.awayTeam}: ${reason}`);
  return {
    outcome: "unmatched",
    fixtureId: null,
    confidence: 0,
    fixture: null,
    reason: `${code}: ${reason}`,
  };
}
