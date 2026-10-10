// OpenFootball local history queries.
// Computes team stats from the synced openfootball_results table in the
// SAME shape as the provider's getTeamStats, so callers can use it as a
// drop-in replacement. Returns null when local data is insufficient —
// the caller then falls back to the provider API.
//
// Shape (matches footballDataOrg.buildStats):
//   { teamId, played, wins, draws, losses, goalsFor, goalsAgainst,
//     cleanSheets, homePlayed, homeGF, homeGA, awayPlayed, awayGF, awayGA,
//     recentForm: [{ opponent, scoreH, scoreA, home, date }],
//     position: undefined, points: undefined, source: 'openfootball' }

import { db } from "../db/database.js";
import { normalizeTeamName } from "../automation/normalizer.js";

const MIN_MATCHES = 5; // fewer than this -> fall back to the provider

export function getLocalTeamStats(teamName, { limit = 10 } = {}) {
  const key = normalizeTeamName(teamName);
  if (!key) return null;
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT match_date, team1, team2, team1_key, team2_key, ft_home, ft_away
         FROM openfootball_results
         WHERE (team1_key = ? OR team2_key = ?)
           AND ft_home IS NOT NULL AND ft_away IS NOT NULL
         ORDER BY match_date DESC
         LIMIT ?`
      )
      .all(key, key, limit);
  } catch {
    return null;
  }
  if (!rows || rows.length < MIN_MATCHES) return null;

  let played = 0, wins = 0, draws = 0, losses = 0;
  let gf = 0, ga = 0, cs = 0;
  let hP = 0, hGF = 0, hGA = 0, aP = 0, aGF = 0, aGA = 0;
  const recentForm = [];

  for (const r of rows) {
    const isHome = r.team1_key === key;
    const f = isHome ? r.ft_home : r.ft_away;
    const a = isHome ? r.ft_away : r.ft_home;
    played++;
    if (f > a) wins++;
    else if (f === a) draws++;
    else losses++;
    gf += f;
    ga += a;
    if (a === 0) cs++;
    if (isHome) { hP++; hGF += f; hGA += a; }
    else { aP++; aGF += f; aGA += a; }
    recentForm.push({
      opponent: isHome ? r.team2 : r.team1,
      scoreH: r.ft_home,
      scoreA: r.ft_away,
      home: isHome,
      date: r.match_date,
    });
  }

  return {
    teamId: `ofb:${key}`,
    played, wins, draws, losses,
    goalsFor: gf, goalsAgainst: ga, cleanSheets: cs,
    homePlayed: hP, homeGF: hGF, homeGA: hGA,
    awayPlayed: aP, awayGF: aGF, awayGA: aGA,
    recentForm,
    position: undefined,
    points: undefined,
    source: "openfootball",
  };
}

// How many distinct teams we have history for (observability).
export function historyCoverage() {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT team1_key) AS c FROM openfootball_results`
      )
      .get();
    return row ? Number(row.c) : 0;
  } catch {
    return 0;
  }
}
