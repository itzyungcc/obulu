// OBULU Automation Agent — match normalizer.
// Normalizes team names and match records so fixtures from any source can be
// compared reliably. Since the primary discovery source is OBULU's own
// provider, most records arrive already clean; this module keeps the pipeline
// source-agnostic and provides the alias/normalization layer the spec's
// fixture-matching stage requires.

// Common suffixes/tokens that do not distinguish teams.
const NOISE_TOKENS = [/\bfc\b/g, /\bafc\b/g, /\bsc\b/g, /\bac\b/g];

const SUFFIX_STRIP = /\s+(fc|afc|sc|ac|cf|bk|fk|if|sk)$/i;

// Curated alias map: normalized key -> canonical key.
const ALIASES = {
  "man united": "manchester united",
  "man utd": "manchester united",
  "manchester utd": "manchester united",
  "man city": "manchester city",
  "spurs": "tottenham hotspur",
  "tottenham": "tottenham hotspur",
  "west ham": "west ham united",
  "wolves": "wolverhampton wanderers",
  "brighton": "brighton and hove albion",
  "newcastle": "newcastle united",
  "leicester": "leicester city",
  "atletico madrid": "atletico de madrid",
  "athletic bilbao": "athletic club",
  "real sociedad": "real sociedad de futbol",
  "inter": "internazionale",
  "inter milan": "internazionale",
  "ac milan": "milan",
  "as roma": "roma",
  "psg": "paris saint germain",
  "paris sg": "paris saint germain",
  "bayern": "bayern munich",
  "bayern munchen": "bayern munich",
  "bvb": "borussia dortmund",
  "dortmund": "borussia dortmund",
  "rb leipzig": "rasenballsport leipzig",
  "leverkusen": "bayer leverkusen",
};

export function normalizeTeamName(raw) {
  if (!raw) return "";
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[.'`]/g, "");
  s = s.replace(/&/g, "and");
  s = s.replace(/[^a-z0-9\s-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Resolve alias before suffix stripping so "man united fc" works.
  if (ALIASES[s]) return ALIASES[s];
  s = s.replace(SUFFIX_STRIP, "").trim();
  for (const re of NOISE_TOKENS) s = s.replace(re, " ");
  s = s.replace(/\s+/g, " ").trim();
  return ALIASES[s] || s;
}

// Strict team equality: same normalized key AND not a risky substring match.
// Never matches two teams merely because one name contains the other unless
// the shorter is a known alias of the longer.
export function sameTeam(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  return na === nb;
}

export function normalizeMatch(raw) {
  return {
    source: raw.source || "football-data.org",
    sourceMatchId: String(raw.sourceMatchId ?? raw.id ?? ""),
    homeTeam: String(raw.homeTeam ?? raw.home?.name ?? ""),
    awayTeam: String(raw.awayTeam ?? raw.away?.name ?? ""),
    homeTeamKey: normalizeTeamName(raw.homeTeam ?? raw.home?.name ?? ""),
    awayTeamKey: normalizeTeamName(raw.awayTeam ?? raw.away?.name ?? ""),
    league: String(raw.league ?? raw.league?.name ?? ""),
    leagueId: raw.leagueId ?? raw.league?.id ?? null,
    country: raw.country ?? null,
    kickoff: raw.kickoff, // ISO-8601 UTC
    status: raw.status ?? "NS",
    sourceUrl: raw.sourceUrl ?? null,
    collectedAt: new Date().toISOString(),
    fixture: raw.fixture ?? null, // raw provider fixture for the matcher
  };
}
