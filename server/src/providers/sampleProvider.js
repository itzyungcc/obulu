// SAMPLE provider — dev-only, obviously-marked fake dataset.
// Used ONLY when SAMPLE_DATA=true. Every payload is flagged sampleData:true
// and league names carry a "SAMPLE:" prefix so sample data can never be
// mistaken for live data.
export const name = "sample";
export const sampleData = true;

function isoDaysFromNow(days, hour = 17, minute = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function pastIso(daysAgo, hour = 17, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString().slice(0, 10);
}

const LEAGUES = [
  { id: "sample-epl", name: "SAMPLE: Premier League", country: "Sampleland", season: "2026/27" },
  { id: "sample-laliga", name: "SAMPLE: La Liga", country: "Sampleland", season: "2026/27" },
];

const TEAMS = [
  { id: "sample-team-arsenal", name: "Arsenal", leagueId: "sample-epl" },
  { id: "sample-team-chelsea", name: "Chelsea", leagueId: "sample-epl" },
  { id: "sample-team-liverpool", name: "Liverpool", leagueId: "sample-epl" },
  { id: "sample-team-mancity", name: "Manchester City", leagueId: "sample-epl" },
  { id: "sample-team-manutd", name: "Manchester United", leagueId: "sample-epl" },
  { id: "sample-team-spurs", name: "Tottenham Hotspur", leagueId: "sample-epl" },
  { id: "sample-team-realmadrid", name: "Real Madrid", leagueId: "sample-laliga" },
  { id: "sample-team-barcelona", name: "Barcelona", leagueId: "sample-laliga" },
  { id: "sample-team-atletico", name: "Atlético Madrid", leagueId: "sample-laliga" },
];

function teamRef(id) {
  const t = TEAMS.find((x) => x.id === id);
  return { id: t.id, name: t.name, country: "Sampleland" };
}

// [opponentId, scoreFor, scoreAgainst, isHome, daysAgo]
function form(rows) {
  return rows.map(([opp, sf, sa, home, daysAgo]) => ({
    opponent: TEAMS.find((t) => t.id === opp).name,
    scoreH: home ? sf : sa,
    scoreA: home ? sa : sf,
    home,
    date: pastIso(daysAgo),
  }));
}

const STATS = {
  "sample-team-arsenal": {
    played: 12, wins: 8, draws: 3, losses: 1, goalsFor: 26, goalsAgainst: 10,
    cleanSheets: 5, homePlayed: 6, homeGF: 16, homeGA: 4, awayPlayed: 6, awayGF: 10, awayGA: 6,
    position: 1, points: 27,
    recentForm: form([
      ["sample-team-chelsea", 2, 0, true, 3],
      ["sample-team-liverpool", 1, 1, false, 7],
      ["sample-team-mancity", 3, 1, true, 10],
      ["sample-team-spurs", 2, 1, false, 14],
      ["sample-team-manutd", 1, 0, true, 17],
      ["sample-team-chelsea", 2, 2, false, 21],
      ["sample-team-liverpool", 2, 0, true, 24],
      ["sample-team-mancity", 0, 1, false, 28],
      ["sample-team-spurs", 4, 2, true, 31],
      ["sample-team-manutd", 1, 1, false, 35],
    ]),
  },
  "sample-team-chelsea": {
    played: 12, wins: 6, draws: 3, losses: 3, goalsFor: 20, goalsAgainst: 14,
    cleanSheets: 4, homePlayed: 6, homeGF: 12, homeGA: 6, awayPlayed: 6, awayGF: 8, awayGA: 8,
    position: 4, points: 21,
    recentForm: form([
      ["sample-team-arsenal", 0, 2, false, 3],
      ["sample-team-spurs", 2, 1, true, 7],
      ["sample-team-manutd", 1, 1, false, 10],
      ["sample-team-liverpool", 0, 2, true, 14],
      ["sample-team-mancity", 2, 0, false, 17],
      ["sample-team-arsenal", 2, 2, true, 21],
      ["sample-team-spurs", 3, 0, false, 24],
      ["sample-team-manutd", 1, 2, true, 28],
      ["sample-team-liverpool", 1, 1, false, 31],
      ["sample-team-mancity", 2, 1, true, 35],
    ]),
  },
  "sample-team-liverpool": {
    played: 12, wins: 7, draws: 2, losses: 3, goalsFor: 24, goalsAgainst: 13,
    cleanSheets: 4, homePlayed: 6, homeGF: 15, homeGA: 5, awayPlayed: 6, awayGF: 9, awayGA: 8,
    position: 2, points: 23,
    recentForm: form([
      ["sample-team-mancity", 2, 2, true, 4],
      ["sample-team-arsenal", 1, 1, true, 7],
      ["sample-team-spurs", 3, 0, false, 11],
      ["sample-team-chelsea", 2, 0, false, 14],
      ["sample-team-manutd", 1, 2, true, 18],
      ["sample-team-mancity", 1, 0, false, 22],
      ["sample-team-arsenal", 0, 2, false, 24],
      ["sample-team-spurs", 2, 1, true, 29],
      ["sample-team-chelsea", 1, 1, true, 31],
      ["sample-team-manutd", 3, 1, false, 36],
    ]),
  },
  "sample-team-mancity": {
    played: 12, wins: 7, draws: 3, losses: 2, goalsFor: 25, goalsAgainst: 12,
    cleanSheets: 5, homePlayed: 6, homeGF: 16, homeGA: 5, awayPlayed: 6, awayGF: 9, awayGA: 7,
    position: 3, points: 24,
    recentForm: form([
      ["sample-team-liverpool", 2, 2, false, 4],
      ["sample-team-manutd", 3, 1, true, 8],
      ["sample-team-arsenal", 1, 3, false, 10],
      ["sample-team-spurs", 2, 0, true, 15],
      ["sample-team-chelsea", 0, 2, true, 17],
      ["sample-team-liverpool", 0, 1, true, 22],
      ["sample-team-manutd", 2, 2, false, 26],
      ["sample-team-arsenal", 1, 0, true, 28],
      ["sample-team-spurs", 4, 1, false, 33],
      ["sample-team-chelsea", 1, 2, false, 35],
    ]),
  },
  "sample-team-manutd": {
    played: 12, wins: 4, draws: 3, losses: 5, goalsFor: 15, goalsAgainst: 18,
    cleanSheets: 2, homePlayed: 6, homeGF: 9, homeGA: 8, awayPlayed: 6, awayGF: 6, awayGA: 10,
    position: 6, points: 15,
    recentForm: form([
      ["sample-team-spurs", 1, 1, true, 5],
      ["sample-team-mancity", 1, 3, false, 8],
      ["sample-team-chelsea", 1, 1, true, 10],
      ["sample-team-liverpool", 2, 1, false, 18],
      ["sample-team-arsenal", 0, 1, false, 17],
      ["sample-team-spurs", 0, 2, false, 23],
      ["sample-team-mancity", 2, 2, true, 26],
      ["sample-team-chelsea", 2, 1, false, 28],
      ["sample-team-liverpool", 1, 3, true, 36],
      ["sample-team-arsenal", 1, 1, true, 35],
    ]),
  },
  "sample-team-spurs": {
    played: 12, wins: 3, draws: 4, losses: 5, goalsFor: 14, goalsAgainst: 20,
    cleanSheets: 1, homePlayed: 6, homeGF: 8, homeGA: 10, awayPlayed: 6, awayGF: 6, awayGA: 10,
    position: 7, points: 13,
    recentForm: form([
      ["sample-team-manutd", 1, 1, false, 5],
      ["sample-team-chelsea", 1, 2, false, 7],
      ["sample-team-liverpool", 0, 3, true, 11],
      ["sample-team-arsenal", 1, 2, true, 14],
      ["sample-team-mancity", 0, 2, false, 15],
      ["sample-team-manutd", 2, 0, true, 23],
      ["sample-team-chelsea", 0, 3, true, 24],
      ["sample-team-liverpool", 1, 2, false, 29],
      ["sample-team-arsenal", 2, 4, false, 31],
      ["sample-team-mancity", 1, 4, true, 33],
    ]),
  },
  "sample-team-realmadrid": {
    played: 10, wins: 7, draws: 2, losses: 1, goalsFor: 22, goalsAgainst: 9,
    cleanSheets: 4, homePlayed: 5, homeGF: 14, homeGA: 4, awayPlayed: 5, awayGF: 8, awayGA: 5,
    position: 1, points: 23,
    recentForm: form([
      ["sample-team-barcelona", 2, 1, true, 6],
      ["sample-team-atletico", 1, 1, false, 12],
      ["sample-team-barcelona", 3, 0, false, 20],
      ["sample-team-atletico", 2, 0, true, 27],
      ["sample-team-barcelona", 1, 2, true, 40],
      ["sample-team-atletico", 2, 2, false, 48],
      ["sample-team-barcelona", 2, 0, true, 60],
      ["sample-team-atletico", 1, 0, false, 75],
      ["sample-team-barcelona", 0, 0, false, 90],
      ["sample-team-atletico", 3, 1, true, 110],
    ]),
  },
  "sample-team-barcelona": {
    played: 10, wins: 6, draws: 2, losses: 2, goalsFor: 20, goalsAgainst: 11,
    cleanSheets: 3, homePlayed: 5, homeGF: 12, homeGA: 5, awayPlayed: 5, awayGF: 8, awayGA: 6,
    position: 2, points: 20,
    recentForm: form([
      ["sample-team-realmadrid", 1, 2, false, 6],
      ["sample-team-atletico", 2, 2, true, 13],
      ["sample-team-realmadrid", 0, 3, true, 20],
      ["sample-team-atletico", 1, 0, false, 30],
      ["sample-team-realmadrid", 2, 1, false, 40],
      ["sample-team-atletico", 3, 1, true, 55],
      ["sample-team-realmadrid", 0, 2, false, 60],
      ["sample-team-atletico", 1, 1, true, 80],
      ["sample-team-realmadrid", 0, 0, true, 90],
      ["sample-team-atletico", 2, 0, false, 105],
    ]),
  },
  "sample-team-atletico": {
    played: 10, wins: 5, draws: 3, losses: 2, goalsFor: 14, goalsAgainst: 10,
    cleanSheets: 4, homePlayed: 5, homeGF: 8, homeGA: 4, awayPlayed: 5, awayGF: 6, awayGA: 6,
    position: 3, points: 18,
    recentForm: form([
      ["sample-team-realmadrid", 1, 1, true, 12],
      ["sample-team-barcelona", 2, 2, false, 13],
      ["sample-team-realmadrid", 0, 2, false, 27],
      ["sample-team-barcelona", 0, 1, true, 30],
      ["sample-team-realmadrid", 2, 2, true, 48],
      ["sample-team-barcelona", 1, 3, false, 55],
      ["sample-team-realmadrid", 0, 1, true, 75],
      ["sample-team-barcelona", 1, 1, false, 80],
      ["sample-team-realmadrid", 1, 3, false, 110],
      ["sample-team-barcelona", 0, 2, true, 105],
    ]),
  },
};

const FIXTURES = [
  { id: "sample-match-1", leagueId: "sample-epl", homeId: "sample-team-arsenal", awayId: "sample-team-chelsea", days: 1, hour: 17, minute: 30, venue: "Sample Stadium North" },
  { id: "sample-match-2", leagueId: "sample-epl", homeId: "sample-team-liverpool", awayId: "sample-team-mancity", days: 2, hour: 15, minute: 0, venue: "Sample Stadium East" },
  { id: "sample-match-3", leagueId: "sample-epl", homeId: "sample-team-spurs", awayId: "sample-team-manutd", days: 4, hour: 12, minute: 30, venue: "Sample Stadium South" },
  { id: "sample-match-4", leagueId: "sample-laliga", homeId: "sample-team-realmadrid", awayId: "sample-team-barcelona", days: 5, hour: 20, minute: 0, venue: "Sample Stadium West" },
  { id: "sample-match-5", leagueId: "sample-laliga", homeId: "sample-team-atletico", awayId: "sample-team-realmadrid", days: 8, hour: 18, minute: 0, venue: "Sample Stadium Central" },
];

function mapFixture(f) {
  const league = LEAGUES.find((l) => l.id === f.leagueId);
  return {
    id: f.id,
    league: { id: league.id, name: league.name, country: league.country },
    home: teamRef(f.homeId),
    away: teamRef(f.awayId),
    kickoff: isoDaysFromNow(f.days, f.hour, f.minute),
    status: "NS",
    venue: f.venue,
    referee: "A. Sample",
  };
}

const H2H = {
  "sample-team-arsenal|sample-team-chelsea": {
    played: 5, homeWins: 2, draws: 2, awayWins: 1,
    lastMeetings: [
      { date: pastIso(3), home: "Arsenal", away: "Chelsea", scoreH: 2, scoreA: 0 },
      { date: pastIso(21), home: "Chelsea", away: "Arsenal", scoreH: 2, scoreA: 2 },
      { date: pastIso(120), home: "Arsenal", away: "Chelsea", scoreH: 1, scoreA: 1 },
      { date: pastIso(200), home: "Chelsea", away: "Arsenal", scoreH: 0, scoreA: 1 },
      { date: pastIso(320), home: "Arsenal", away: "Chelsea", scoreH: 0, scoreA: 2 },
    ],
  },
  "sample-team-liverpool|sample-team-mancity": {
    played: 5, homeWins: 2, draws: 2, awayWins: 1,
    lastMeetings: [
      { date: pastIso(4), home: "Liverpool", away: "Manchester City", scoreH: 2, scoreA: 2 },
      { date: pastIso(22), home: "Manchester City", away: "Liverpool", scoreH: 0, scoreA: 1 },
      { date: pastIso(130), home: "Liverpool", away: "Manchester City", scoreH: 1, scoreA: 0 },
      { date: pastIso(210), home: "Manchester City", away: "Liverpool", scoreH: 3, scoreA: 1 },
      { date: pastIso(330), home: "Liverpool", away: "Manchester City", scoreH: 1, scoreA: 1 },
    ],
  },
  "sample-team-realmadrid|sample-team-barcelona": {
    played: 5, homeWins: 3, draws: 1, awayWins: 1,
    lastMeetings: [
      { date: pastIso(6), home: "Real Madrid", away: "Barcelona", scoreH: 2, scoreA: 1 },
      { date: pastIso(20), home: "Barcelona", away: "Real Madrid", scoreH: 0, scoreA: 3 },
      { date: pastIso(40), home: "Real Madrid", away: "Barcelona", scoreH: 1, scoreA: 2 },
      { date: pastIso(60), home: "Barcelona", away: "Real Madrid", scoreH: 0, scoreA: 2 },
      { date: pastIso(90), home: "Real Madrid", away: "Barcelona", scoreH: 0, scoreA: 0 },
    ],
  },
};

const INJURIES = {
  "sample-team-arsenal": [{ player: "Sample Winger", reason: "Hamstring" }],
  "sample-team-chelsea": [{ player: "Sample Fullback", reason: "Ankle" }],
  "sample-team-liverpool": [],
  "sample-team-mancity": [{ player: "Sample Midfielder", reason: "Knee" }],
  "sample-team-manutd": [],
  "sample-team-spurs": [{ player: "Sample Keeper", reason: "Shoulder" }],
  "sample-team-realmadrid": [],
  "sample-team-barcelona": [{ player: "Sample Defender", reason: "Calf" }],
  "sample-team-atletico": [],
};

// Sample decimal odds (informational blend input only — never shown as tips).
const SAMPLE_ODDS = {
  "sample-match-1": { home: 1.95, draw: 3.6, away: 3.8 },
  "sample-match-2": { home: 2.6, draw: 3.3, away: 2.7 },
  "sample-match-3": { home: 2.9, draw: 3.4, away: 2.4 },
  "sample-match-4": { home: 2.2, draw: 3.5, away: 3.1 },
  "sample-match-5": { home: 3.4, draw: 3.3, away: 2.1 },
};

export async function getLeagues() {
  return LEAGUES.map((l) => ({ ...l }));
}

export async function getUpcomingFixtures({ league, date, team } = {}) {
  let list = FIXTURES.map(mapFixture);
  if (league) list = list.filter((f) => f.league.id === league);
  if (team) list = list.filter((f) => f.home.id === team || f.away.id === team);
  if (date) list = list.filter((f) => f.kickoff.slice(0, 10) === date);
  return list;
}

export async function searchTeams(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  return TEAMS.filter((t) => t.name.toLowerCase().includes(needle)).map((t) => ({
    id: t.id,
    name: t.name,
    country: "Sampleland",
  }));
}

export async function getMatch(id) {
  const f = FIXTURES.find((x) => x.id === id);
  return f ? mapFixture(f) : null;
}

export async function getTeamStats(teamId) {
  const s = STATS[teamId];
  if (!s) return null;
  return { teamId, ...s };
}

export async function getLeagueAvgs(leagueId) {
  const teams = TEAMS.filter((t) => t.leagueId === leagueId);
  let h = 0, a = 0, n = 0;
  for (const t of teams) {
    const s = STATS[t.id];
    if (s && s.homePlayed > 0 && s.awayPlayed > 0) {
      h += s.homeGF / s.homePlayed;
      a += s.awayGF / s.awayPlayed;
      n++;
    }
  }
  if (!n) return null;
  return { avgHomeGoals: h / n, avgAwayGoals: a / n, credible: true };
}

export async function getHeadToHead(homeId, awayId) {
  const key1 = `${homeId}|${awayId}`;
  const key2 = `${awayId}|${homeId}`;
  if (H2H[key1]) return H2H[key1];
  if (H2H[key2]) {
    // Flip perspective so homeWins refers to the queried home side.
    const h = H2H[key2];
    return { played: h.played, homeWins: h.awayWins, draws: h.draws, awayWins: h.homeWins, lastMeetings: h.lastMeetings };
  }
  return { played: 0, homeWins: 0, draws: 0, awayWins: 0, lastMeetings: [] };
}

export async function getStandings(leagueId) {
  const out = {};
  for (const t of TEAMS.filter((x) => x.leagueId === leagueId)) {
    const s = STATS[t.id];
    if (s) out[t.id] = { position: s.position, played: s.played, points: s.points };
  }
  return out;
}

export async function getInjuries(teamId) {
  return (INJURIES[teamId] || []).map((x) => ({ ...x }));
}

export async function getOdds(matchId) {
  const o = SAMPLE_ODDS[matchId];
  return o ? { ...o } : null;
}
