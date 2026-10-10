// OpenFootball historical results sync.
// Downloads public-domain match JSON from openfootball/football.json
// (GitHub raw, no API key, no rate limits) and stores finished matches in
// openfootball_results. Runs nightly; also runs on boot when the data is
// missing or older than 24h.
//
// football-data.org remains the source for upcoming fixtures and live
// scores. OpenFootball only supplements HISTORICAL team stats, which is
// where the provider quota (8 req/min) was being burned.

import { db } from "../db/database.js";
import { normalizeTeamName } from "../automation/normalizer.js";

const log = (...a) => console.log("[OpenFootball][sync]", ...a);

const RAW_BASE =
  "https://raw.githubusercontent.com/openfootball/football.json/master";

// football.json file key -> football-data.org competition id.
// Exported so history lookups can map a competition id back to a file key.
export const LEAGUES = {
  "en.1": 2021, // Premier League
  "es.1": 2014, // La Liga
  "it.1": 2019, // Serie A
  "de.1": 2002, // Bundesliga
  "fr.1": 2015, // Ligue 1
  "en.2": 2016, // Championship
  "nl.1": 2003, // Eredivisie
  "pt.1": 2017, // Primeira Liga
};

// Seasons to keep locally: last full season (baseline) + current season.
const SEASONS = ["2025-26", "2026-27"];

const SYNC_INTERVAL_MS = 24 * 3600 * 1000;
let timer = null;
let syncing = false;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function toRow(leagueCode, season, competitionId, m, syncedAt) {
  const ft = m.score && Array.isArray(m.score.ft) ? m.score.ft : null;
  if (!ft || ft[0] == null || ft[1] == null) return null; // upcoming, not history
  const ht = m.score && Array.isArray(m.score.ht) ? m.score.ht : [null, null];
  const t1 = String(m.team1 || "").trim();
  const t2 = String(m.team2 || "").trim();
  if (!t1 || !t2 || !m.date) return null;
  return {
    league_code: leagueCode,
    season,
    competition_id: competitionId,
    match_date: String(m.date).slice(0, 10),
    round: m.round ? String(m.round) : null,
    team1: t1,
    team2: t2,
    team1_key: normalizeTeamName(t1),
    team2_key: normalizeTeamName(t2),
    ft_home: Number(ft[0]),
    ft_away: Number(ft[1]),
    ht_home: ht[0] == null ? null : Number(ht[0]),
    ht_away: ht[1] == null ? null : Number(ht[1]),
    synced_at: syncedAt,
  };
}

const upsert = db.prepare(`
  INSERT INTO openfootball_results
    (league_code, season, competition_id, match_date, round,
     team1, team2, team1_key, team2_key,
     ft_home, ft_away, ht_home, ht_away, synced_at)
  VALUES
    (@league_code, @season, @competition_id, @match_date, @round,
     @team1, @team2, @team1_key, @team2_key,
     @ft_home, @ft_away, @ht_home, @ht_away, @synced_at)
  ON CONFLICT (league_code, season, match_date, team1_key, team2_key)
  DO UPDATE SET
    round = excluded.round,
    ft_home = excluded.ft_home, ft_away = excluded.ft_away,
    ht_home = excluded.ht_home, ht_away = excluded.ht_away,
    synced_at = excluded.synced_at
`);

export async function syncOnce() {
  if (syncing) {
    log("sync already running, skipping");
    return { skipped: true };
  }
  syncing = true;
  const syncedAt = new Date().toISOString();
  let filesOk = 0;
  let matchesUpserted = 0;
  let lastError = null;
  try {
    for (const season of SEASONS) {
      for (const [leagueCode, competitionId] of Object.entries(LEAGUES)) {
        const url = `${RAW_BASE}/${season}/${leagueCode}.json`;
        try {
          const data = await fetchJson(url);
          const matches = Array.isArray(data.matches) ? data.matches : [];
          const rows = [];
          for (const m of matches) {
            const row = toRow(leagueCode, season, competitionId, m, syncedAt);
            if (row) rows.push(row);
          }
          for (const r of rows) upsert.run(r);
          matchesUpserted += rows.length;
          filesOk++;
        } catch (e) {
          // One league failing must not kill the whole sync.
          lastError = `${leagueCode}/${season}: ${e.message}`;
          log(`file failed: ${lastError}`);
        }
        // Be polite to GitHub raw even though there's no formal rate limit.
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    db.prepare(
      `UPDATE openfootball_sync_state
       SET last_sync_at = ?, matches_synced = ?, last_error = ? WHERE id = 1`
    ).run(syncedAt, matchesUpserted, lastError);
    log(`sync done: ${filesOk}/${SEASONS.length * Object.keys(LEAGUES).length} files, ${matchesUpserted} matches`);
    return { filesOk, matchesUpserted, lastError };
  } finally {
    syncing = false;
  }
}

export function syncStatus() {
  try {
    const row = db
      .prepare("SELECT last_sync_at, matches_synced, last_error FROM openfootball_sync_state WHERE id = 1")
      .get();
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM openfootball_results")
      .get();
    return {
      lastSyncAt: row?.last_sync_at || null,
      matchesSynced: row?.matches_synced ?? 0,
      rowsInDb: count ? Number(count.c) : 0,
      lastError: row?.last_error || null,
    };
  } catch {
    return { lastSyncAt: null, matchesSynced: 0, rowsInDb: 0, lastError: null };
  }
}

function needsSync() {
  const s = syncStatus();
  if (!s.rowsInDb) return true;
  if (!s.lastSyncAt) return true;
  return Date.now() - Date.parse(s.lastSyncAt) > SYNC_INTERVAL_MS;
}

export function startOpenFootballSync() {
  if (timer) {
    log("sync scheduler already running");
    return true;
  }
  log("sync scheduler started: every 24h");
  if (needsSync()) {
    log("data missing or stale, syncing on boot");
    setTimeout(() => syncOnce().catch((e) => log(`boot sync failed: ${e.message}`)), 15000);
  }
  timer = setInterval(() => {
    syncOnce().catch((e) => log(`scheduled sync failed: ${e.message}`));
  }, SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function stopOpenFootballSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log("sync scheduler stopped");
  }
}
