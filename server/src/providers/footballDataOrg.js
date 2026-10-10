// football-data.org v4 fallback provider. API key via FOOTBALL_DATA_ORG_KEY env only.
// Note: this API has no head-to-head or injuries endpoints, so those return
// empty data; team stats are derived from recent finished matches.
// Free tier offers no minute field on matches — the live minute is derived
// from kickoff elapsed and marked minuteSource "estimated".
import config, { todayStr } from "../config.js";
import { estimateMinute } from "../model/livePredict.js";
import { fetchWithTimeout, dedup, recordApiCall } from "../perf.js";
import { cacheGet, cacheSet } from "../cache.js";

export const name = "football-data.org";
export const sampleData = false;

const BASE = "https://api.football-data.org/v4";
const idOf = (id) => String(id).replace(/^fd-/, "");

// Free-tier rate limit: 10 requests/minute. We stay at 8/min for safety.
// Simple sliding-window limiter shared by all requests from this process.
const requestTimes = [];
const MAX_REQ_PER_MIN = 8;

async function respectRateLimit() {
  const now = Date.now();
  while (requestTimes.length && requestTimes[0] <= now - 60000) {
    requestTimes.shift();
  }
  if (requestTimes.length >= MAX_REQ_PER_MIN) {
    const waitMs = requestTimes[0] + 60000 - now + 200;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    return respectRateLimit();
  }
  requestTimes.push(Date.now());
}

async function req(path, params = {}) {
  await respectRateLimit();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  // Timeout + one retry: a hanging upstream must never hang our request.
  const t0 = Date.now();
  try {
    const { res } = await fetchWithTimeout(
      url,
      { headers: { "X-Auth-Token": config.footballDataOrgKey } },
      { timeoutMs: 20000, retries: 1, retryDelayMs: 1500 }
    );
    if (!res.ok) throw new Error(`football-data.org request failed with status ${res.status}`);
    const json = await res.json();
    recordApiCall(Date.now() - t0, true);
    return json;
  } catch (e) {
    recordApiCall(Date.now() - t0, false);
    throw e;
  }
}

// Run async fn over items with at most `limit` in flight at once.
// Preserves input order in the results array.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function mapStatus(s) {
  const t = String(s || "").toUpperCase();
  if (["IN_PLAY", "PAUSED"].includes(t)) return "LIVE";
  if (["FINISHED", "AWARDED"].includes(t)) return "FT";
  // Explicit non-playable states (surfaced so resolvers/automation can
  // distinguish them from plain pre-match). The automation's matchFixture
  // rejects anything that is not exactly "NS", so these never slip into
  // the pre-match pipeline.
  if (t === "CANCELED") return "CANCELLED";
  if (t === "POSTPONED") return "POSTPONED";
  if (t === "SUSPENDED") return "ABANDONED";
  return "NS";
}

// Full-time (or current) score when the provider reports one, else null.
function scoreOf(m) {
  const ft = m.score && m.score.fullTime;
  if (!ft || ft.home == null || ft.away == null) return null;
  return { home: ft.home, away: ft.away };
}

function mapFixture(m) {
  const comp = m.competition || {};
  return {
    id: `fd-${m.id}`,
    league: {
      id: `fd-${comp.id}`,
      name: comp.name,
      country: comp.area && comp.area.name,
    },
    home: { id: `fd-${m.homeTeam.id}`, name: m.homeTeam.name, logo: m.homeTeam.crest },
    away: { id: `fd-${m.awayTeam.id}`, name: m.awayTeam.name, logo: m.awayTeam.crest },
    kickoff: m.utcDate,
    status: mapStatus(m.status),
    score: scoreOf(m),
    venue: m.venue || undefined,
    referee: (m.referees && m.referees[0] && m.referees[0].name) || undefined,
  };
}

// Free-tier (TIER_ONE) competition ids shared by upcoming + live discovery.
const TIER_ONE_IDS = [
  2021, // Premier League
  2014, // La Liga
  2019, // Serie A
  2002, // Bundesliga
  2015, // Ligue 1
  2001, // UEFA Champions League
  2016, // Championship
  2003, // Eredivisie
  2017, // Primeira Liga
  2013, // Brazilian Serie A
];

function mapLiveFixture(m) {
  const f = mapFixture(m);
  const hasMinute = Number.isFinite(m.minute);
  return {
    ...f,
    status: "LIVE",
    score: scoreOf(m) || { home: 0, away: 0 },
    minute: hasMinute ? m.minute : estimateMinute(m.utcDate),
    minuteSource: hasMinute ? "provider" : "estimated",
  };
}

function redCardsFromBookings(bookings, homeId) {
  const out = { home: 0, away: 0 };
  for (const b of bookings || []) {
    const card = String(b.card || "").toUpperCase();
    if (card !== "RED_CARD" && card !== "SECOND_YELLOW_CARD") continue;
    const teamId = b.team && b.team.id != null ? `fd-${b.team.id}` : null;
    // Only count attributable cards — never guess a side.
    if (teamId === homeId) out.home++;
    else if (teamId) out.away++;
  }
  return out;
}

export async function getLeagues() {
  const json = await req("/competitions");
  return (json.competitions || []).map((c) => ({
    id: `fd-${c.id}`,
    name: c.name,
    country: c.area && c.area.name,
    logo: c.emblem || undefined,
    season: c.currentSeason ? String(new Date(c.currentSeason.startDate).getFullYear()) : undefined,
  }));
}

export async function getUpcomingFixtures({ league, date, team } = {}) {
  let matches = [];
  if (team) {
    const json = await req(`/teams/${idOf(team)}/matches`, { status: "SCHEDULED" });
    matches = json.matches || [];
  } else if (league) {
    const json = await req(`/competitions/${idOf(league)}/matches`, {
      dateFrom: todayStr(0),
      dateTo: todayStr(14),
      status: "SCHEDULED",
    });
    matches = json.matches || [];
  } else {
    // No league/team scope: pull scheduled matches from all free-tier
    // (TIER_ONE) competitions. Fetched concurrently (3 at a time) through
    // the shared rate limiter — the old sequential loop took 10x longer.
    // Best effort per competition.
    const results = await mapConcurrent(
      TIER_ONE_IDS,
      3,
      async (cid) => {
        try {
          const json = await req(`/competitions/${cid}/matches`, {
            dateFrom: todayStr(0),
            dateTo: todayStr(7),
            status: "SCHEDULED",
          });
          return json.matches || [];
        } catch {
          return [];
        }
      }
    );
    for (const arr of results) matches.push(...arr);
  }
  let list = matches.map(mapFixture).filter((f) => f.status === "NS" || f.status === "LIVE");
  if (date) list = list.filter((f) => f.kickoff.slice(0, 10) === date);
  return list.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

export async function searchTeams(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  const json = await req("/teams", { limit: 500 });
  return (json.teams || [])
    .filter((t) => t.name.toLowerCase().includes(needle) || (t.shortName || "").toLowerCase().includes(needle))
    .slice(0, 25)
    .map((t) => ({ id: `fd-${t.id}`, name: t.name, country: t.area && t.area.name, logo: t.crest }));
}

export async function getMatch(id) {
  try {
    const m = await req(`/matches/${idOf(id)}`);
    return mapFixture(m);
  } catch {
    return null;
  }
}

// Live engine interface ---------------------------------------------------
// One request for every live match across all free-tier competitions.
export async function getLiveFixtures() {
  const json = await req("/matches", {
    status: "IN_PLAY",
    competitions: TIER_ONE_IDS.join(","),
  });
  return (json.matches || [])
    .map(mapLiveFixture)
    .filter((f) => f.status === "LIVE")
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

// Free tier: /matches embeds score + bookings inline. Red cards are derived
// from the bookings list; detailed stats are NOT available -> stats is null,
// never fabricated.
export async function getLiveMatch(fixtureId) {
  try {
    const m = await req(`/matches/${idOf(fixtureId)}`);
    const base = mapLiveFixture(m);
    return {
      ...base,
      redCards: redCardsFromBookings(m.bookings, base.home.id),
      stats: null,
    };
  } catch {
    return null;
  }
}

function buildStats(teamId, matches) {
  // matches: finished matches, most recent first
  let played = 0, wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, cs = 0;
  let hP = 0, hGF = 0, hGA = 0, aP = 0, aGF = 0, aGA = 0;
  const recentForm = [];
  for (const m of matches) {
    const score = m.score && m.score.fullTime;
    if (!score || score.home == null || score.away == null) continue;
    const isHome = `fd-${m.homeTeam.id}` === String(teamId);
    const f = isHome ? score.home : score.away;
    const a = isHome ? score.away : score.home;
    played++;
    if (f > a) wins++; else if (f === a) draws++; else losses++;
    gf += f; ga += a;
    if (a === 0) cs++;
    if (isHome) { hP++; hGF += f; hGA += a; } else { aP++; aGF += f; aGA += a; }
    recentForm.push({
      opponent: isHome ? m.awayTeam.name : m.homeTeam.name,
      scoreH: score.home,
      scoreA: score.away,
      home: isHome,
      date: (m.utcDate || "").slice(0, 10),
    });
  }
  return {
    teamId: String(teamId),
    played, wins, draws, losses,
    goalsFor: gf, goalsAgainst: ga, cleanSheets: cs,
    homePlayed: hP, homeGF: hGF, homeGA: hGA,
    awayPlayed: aP, awayGF: aGF, awayGA: aGA,
    recentForm,
    position: undefined,
    points: undefined,
  };
}

export async function getTeamStats(teamId, leagueId, teamNameHint = null) {
  // Prefer free local OpenFootball history when it has enough data for this
  // team: zero provider quota burned. Falls back to the provider API.
  if (teamNameHint) {
    try {
      const { getLocalTeamStats } = await import("../openfootball/history.js");
      const local = getLocalTeamStats(teamNameHint, { limit: 10 });
      if (local) {
        // Best effort: enrich with league position from cached standings.
        if (leagueId) {
          try {
            const st = await cachedStandings(leagueId);
            const row = st[String(teamId)] || st[local.teamId];
            if (row) { local.position = row.position; local.points = row.points; }
          } catch { /* optional */ }
        }
        return local;
      }
    } catch { /* fall through to provider */ }
  }
  const params = { status: "FINISHED", limit: 10 };
  if (leagueId) params.competitions = idOf(leagueId);
  const json = await req(`/teams/${idOf(teamId)}/matches`, params);
  const matches = (json.matches || []).sort(
    (a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate)
  );
  const stats = buildStats(teamId, matches);
  if (leagueId) {
    try {
      // Standings are cached + deduped: home and away lookups for the same
      // league share one API call instead of two.
      const st = await cachedStandings(leagueId);
      const row = st[String(teamId)];
      if (row) { stats.position = row.position; stats.points = row.points; }
    } catch { /* optional */ }
  }
  return stats;
}

// Standings change slowly: cache 6h and dedupe concurrent callers so N
// components asking for the same league trigger exactly one API request.
async function cachedStandings(leagueId) {
  const key = `standings:${idOf(leagueId)}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return dedup(`standings:${idOf(leagueId)}`, async () => {
    const hit2 = cacheGet(key);
    if (hit2) return hit2;
    const st = await getStandings(leagueId);
    cacheSet(key, st, "standings");
    return st;
  });
}

export async function getLeagueAvgs(leagueId) {
  // Prefer free local history: league averages barely move week to week.
  try {
    const { LEAGUES } = await import("../openfootball/sync.js");
    const { getLocalLeagueAvgs } = await import("../openfootball/history.js");
    const code = Object.keys(LEAGUES).find((k) => String(LEAGUES[k]) === String(idOf(leagueId)));
    if (code) {
      const local = getLocalLeagueAvgs(code);
      if (local) return local;
    }
  } catch { /* fall through to provider */ }
  const json = await req(`/competitions/${idOf(leagueId)}/standings`);
  const table = ((json.standings || []).find((s) => s.type === "TOTAL") || {}).table || [];
  let tot = 0, n = 0;
  for (const row of table) {
    if (row.playedGames > 0) { tot += row.goalsFor / row.playedGames; n++; }
  }
  if (!n) return null;
  const avg = tot / n;
  // No home/away split available: apply a typical home/away share (documented estimate).
  return { avgHomeGoals: avg * 0.56, avgAwayGoals: avg * 0.44, credible: true };
}

export async function getHeadToHead(homeId, awayId, homeName = null, awayName = null) {
  // football-data.org has no h2h endpoint; the local OpenFootball history
  // is the only source. Returns the empty shape when names are unknown
  // or local data is thin (callers treat it as "no h2h signal").
  if (homeName && awayName) {
    try {
      const { getLocalHeadToHead } = await import("../openfootball/history.js");
      const local = getLocalHeadToHead(homeName, awayName);
      if (local) return local;
    } catch { /* fall through */ }
  }
  // Not available on football-data.org.
  return { played: 0, homeWins: 0, draws: 0, awayWins: 0, lastMeetings: [] };
}

export async function getStandings(leagueId) {
  const json = await req(`/competitions/${idOf(leagueId)}/standings`);
  const table = ((json.standings || []).find((s) => s.type === "TOTAL") || {}).table || [];
  const out = {};
  for (const row of table) {
    out[`fd-${row.team.id}`] = {
      position: row.position,
      played: row.playedGames,
      points: row.points,
    };
  }
  return out;
}

export async function getInjuries() {
  // Not available on football-data.org.
  return [];
}
