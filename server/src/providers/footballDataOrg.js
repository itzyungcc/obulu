// football-data.org v4 fallback provider. API key via FOOTBALL_DATA_ORG_KEY env only.
// Note: this API has no head-to-head or injuries endpoints, so those return
// empty data; team stats are derived from recent finished matches.
import config, { todayStr } from "../config.js";

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
  const res = await fetch(url, { headers: { "X-Auth-Token": config.footballDataOrgKey } });
  if (!res.ok) throw new Error(`football-data.org request failed with status ${res.status}`);
  return res.json();
}

function mapStatus(s) {
  const t = String(s || "").toUpperCase();
  if (["IN_PLAY", "PAUSED"].includes(t)) return "LIVE";
  if (["FINISHED", "AWARDED"].includes(t)) return "FT";
  return "NS";
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
    venue: m.venue || undefined,
    referee: (m.referees && m.referees[0] && m.referees[0].name) || undefined,
  };
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
    // No league/team scope: pull scheduled matches from a handful of major
    // competitions (free-tier friendly, best effort).
    const compIds = [2021, 2014, 2019, 2002, 2015]; // EPL, La Liga, Serie A, Bundesliga, Ligue 1
    for (const cid of compIds) {
      try {
        const json = await req(`/competitions/${cid}/matches`, {
          dateFrom: todayStr(0),
          dateTo: todayStr(7),
          status: "SCHEDULED",
        });
        matches.push(...(json.matches || []));
      } catch { /* best effort per competition */ }
    }
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

export async function getTeamStats(teamId, leagueId) {
  const params = { status: "FINISHED", limit: 10 };
  if (leagueId) params.competitions = idOf(leagueId);
  const json = await req(`/teams/${idOf(teamId)}/matches`, params);
  const matches = (json.matches || []).sort(
    (a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate)
  );
  const stats = buildStats(teamId, matches);
  if (leagueId) {
    try {
      const st = await getStandings(leagueId);
      const row = st[String(teamId)];
      if (row) { stats.position = row.position; stats.points = row.points; }
    } catch { /* optional */ }
  }
  return stats;
}

export async function getLeagueAvgs(leagueId) {
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

export async function getHeadToHead() {
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
