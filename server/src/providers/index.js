// Provider selection.
// Priority: SAMPLE_DATA=true -> sample provider (dev only).
// Else API_FOOTBALL_KEY -> api-football, else FOOTBALL_DATA_ORG_KEY ->
// football-data.org, else null (routes then return 503, never fake data).
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
