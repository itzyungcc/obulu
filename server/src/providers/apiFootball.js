// API-Football provider (api-sports.io v3). API key via API_FOOTBALL_KEY env only.
import config, { currentSeason, todayStr } from "../config.js";

export const name = "api-football";
export const sampleData = false;

const BASE = "https://v3.football.api-sports.io";

async function req(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { "x-apisports-key": config.apiFootballKey } });
  if (!res.ok) throw new Error(`API-Football request failed with status ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API-Football error: ${JSON.stringify(json.errors)}`);
  }
  return json.response;
}

function mapStatus(short) {
  const t = String(short || "").toUpperCase();
  if (["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT"].includes(t)) return "LIVE";
  if (["FT", "AET", "PEN"].includes(t)) return "FT";
  return "NS";
}

function mapFixture(f) {
  return {
    id: String(f.fixture.id),
    league: { id: String(f.league.id), name: f.league.name, country: f.league.country },
    home: { id: String(f.teams.home.id), name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: String(f.teams.away.id), name: f.teams.away.name, logo: f.teams.away.logo },
    kickoff: f.fixture.date,
    status: mapStatus(f.fixture.status && f.fixture.status.short),
    venue: (f.fixture.venue && f.fixture.venue.name) || undefined,
    referee: f.fixture.referee || undefined,
  };
}

export async function getLeagues() {
  const r = await req("/leagues", { current: "true" });
  return (Array.isArray(r) ? r : []).map((l) => {
    const cur = (l.seasons || []).find((s) => s.current);
    return {
      id: String(l.league.id),
      name: l.league.name,
      country: l.league.country,
      logo: l.league.logo,
      season: String((cur && cur.year) || currentSeason()),
    };
  });
}

export async function getUpcomingFixtures({ league, date, team } = {}) {
  const params = {};
  if (league) {
    params.league = league;
    params.season = currentSeason();
  }
  if (team) params.team = team;
  if (date) {
    params.date = date;
  } else {
    params.from = todayStr(0);
    params.to = todayStr(14);
  }
  const r = await req("/fixtures", params);
  return (Array.isArray(r) ? r : [])
    .map(mapFixture)
    .filter((f) => f.status === "NS" || f.status === "LIVE");
}

export async function searchTeams(q) {
  const r = await req("/teams", { search: q });
  return (Array.isArray(r) ? r : []).map((t) => ({
    id: String(t.team.id),
    name: t.team.name,
    country: t.team.country,
    logo: t.team.logo,
  }));
}

export async function getMatch(id) {
  const r = await req("/fixtures", { id });
  const arr = Array.isArray(r) ? r : [];
  return arr.length ? mapFixture(arr[0]) : null;
}

export async function getTeamStats(teamId, leagueId) {
  const season = currentSeason();
  const raw = await req("/teams/statistics", { league: leagueId, season, team: teamId });
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return null;

  const fx = await req("/fixtures", { team: teamId, league: leagueId, season, last: 10 });
  const recentForm = (Array.isArray(fx) ? fx : [])
    .filter((f) => f.goals && f.goals.home != null && f.goals.away != null)
    .sort((a, b) => Date.parse(b.fixture.date) - Date.parse(a.fixture.date))
    .slice(0, 10)
    .map((f) => {
      const isHome = String(f.teams.home.id) === String(teamId);
      return {
        opponent: isHome ? f.teams.away.name : f.teams.home.name,
        scoreH: f.goals.home,
        scoreA: f.goals.away,
        home: isHome,
        date: f.fixture.date.slice(0, 10),
      };
    });

  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  return {
    teamId: String(teamId),
    played: num(s.fixtures && s.fixtures.played && s.fixtures.played.total) || recentForm.length,
    wins: num(s.fixtures && s.fixtures.wins && s.fixtures.wins.total),
    draws: num(s.fixtures && s.fixtures.draws && s.fixtures.draws.total),
    losses: num(s.fixtures && s.fixtures.loses && s.fixtures.loses.total),
    goalsFor: num(s.goals && s.goals.for && s.goals.for.total && s.goals.for.total.total),
    goalsAgainst: num(s.goals && s.goals.against && s.goals.against.total && s.goals.against.total.total),
    cleanSheets: num(s.clean_sheet && s.clean_sheet.total),
    homePlayed: num(s.fixtures && s.fixtures.played && s.fixtures.played.home),
    homeGF: num(s.goals && s.goals.for && s.goals.for.total && s.goals.for.total.home),
    homeGA: num(s.goals && s.goals.against && s.goals.against.total && s.goals.against.total.home),
    awayPlayed: num(s.fixtures && s.fixtures.played && s.fixtures.played.away),
    awayGF: num(s.goals && s.goals.for && s.goals.for.total && s.goals.for.total.away),
    awayGA: num(s.goals && s.goals.against && s.goals.against.total && s.goals.against.total.away),
    recentForm,
    position: undefined,
    points: undefined,
  };
}

export async function getLeagueAvgs(leagueId) {
  const r = await req("/standings", { league: leagueId, season: currentSeason() });
  const arr = Array.isArray(r) ? r : [];
  const table = (arr[0] && arr[0].league && arr[0].league.standings && arr[0].league.standings[0]) || [];
  let h = 0, a = 0, n = 0;
  for (const row of table) {
    if (row.home && row.home.played > 0) { h += row.home.goals.for / row.home.played; n++; }
    if (row.away && row.away.played > 0) { a += row.away.goals.for / row.away.played; }
  }
  if (!n) return null;
  return { avgHomeGoals: h / n, avgAwayGoals: a / n, credible: true };
}

export async function getHeadToHead(homeId, awayId) {
  const r = await req("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 });
  const arr = (Array.isArray(r) ? r : [])
    .filter((f) => f.goals && f.goals.home != null && f.goals.away != null)
    .sort((a, b) => Date.parse(b.fixture.date) - Date.parse(a.fixture.date));
  let homeWins = 0, draws = 0, awayWins = 0;
  const lastMeetings = arr.map((f) => {
    const hs = f.goals.home, as = f.goals.away;
    const homeIsQueriedHome = String(f.teams.home.id) === String(homeId);
    const homeWon = hs > as;
    if (hs === as) draws++;
    else if ((homeWon && homeIsQueriedHome) || (!homeWon && !homeIsQueriedHome)) homeWins++;
    else awayWins++;
    return {
      date: f.fixture.date.slice(0, 10),
      home: f.teams.home.name,
      away: f.teams.away.name,
      scoreH: hs,
      scoreA: as,
    };
  });
  return { played: arr.length, homeWins, draws, awayWins, lastMeetings };
}

export async function getStandings(leagueId) {
  const r = await req("/standings", { league: leagueId, season: currentSeason() });
  const arr = Array.isArray(r) ? r : [];
  const table = (arr[0] && arr[0].league && arr[0].league.standings && arr[0].league.standings[0]) || [];
  const out = {};
  for (const row of table) {
    out[String(row.team.id)] = {
      position: row.rank,
      played: row.all ? row.all.played : 0,
      points: row.points,
    };
  }
  return out;
}

export async function getInjuries(teamId, leagueId) {
  const r = await req("/injuries", { league: leagueId, season: currentSeason(), team: teamId });
  return (Array.isArray(r) ? r : []).map((x) => ({
    player: (x.player && x.player.name) || "Unknown",
    reason: (x.player && (x.player.reason || x.player.type)) || "Unknown",
  }));
}
