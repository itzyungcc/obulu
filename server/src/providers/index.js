// Provider selection.
// Priority: SAMPLE_DATA=true -> sample provider (dev only).
// Else API_FOOTBALL_KEY -> api-football, else FOOTBALL_DATA_ORG_KEY ->
// football-data.org, else null (routes then return 503, never fake data).
//
// Every provider normalizes to the same shapes:
//
//   Fixture: { id, league: { id, name, country }, home: { id, name, logo },
//              away: { id, name, logo }, kickoff (ISO), status, venue, referee,
//              score: { home, away } | null }
//     status is one of: "NS" | "LIVE" | "FT" | "CANCELLED" | "POSTPONED" |
//     "ABANDONED". score is the full-time (or current) score when the
//     provider reports one, else null.
//
//   LiveFixture (from getLiveFixtures): Fixture + { status: "LIVE",
//     score: { home, away }, minute: number | null,
//     minuteSource: "provider" | "estimated" }
//
//   LiveMatch (from getLiveMatch): LiveFixture +
//     { redCards: { home, away }, stats: null | { shots, shotsOnTarget,
//       possession, corners, fouls } } — each stat is { home, away } with
//       null for anything the provider does not report. stats is null on
//       tiers without detailed in-play data.
import config from "../config.js";
import * as sample from "./sampleProvider.js";
import * as apiFootball from "./apiFootball.js";
import * as footballDataOrg from "./footballDataOrg.js";

export function providerKind() {
  if (config.sampleData) return "sample";
  if (config.apiFootballKey) return "api-football";
  if (config.footballDataOrgKey) return "football-data.org";
  return "none";
}

export function getProvider() {
  const kind = providerKind();
  if (kind === "sample") return sample;
  if (kind === "api-football") return apiFootball;
  if (kind === "football-data.org") return footballDataOrg;
  return null;
}

// Whether the optional odds blend input is configured (env key present).
export function oddsEnabled() {
  return Boolean(config.oddsApiKey);
}
