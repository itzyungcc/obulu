// OBULU Automation Agent — pipeline runner.
// Orchestrates: collect → match → analyze → qualify → snapshot → dedup →
// notify. One failed match never stops the run. A run lock prevents
// overlapping runs. Rate limiting protects the provider quota.

import { db } from "../db/database.js";
import { loadAutomationConfig, loadEffectiveConfig } from "./automationConfig.js";
import { collectUpcoming } from "./collector.js";
import { matchFixture } from "./fixtureMatcher.js";
import { analyzeFixture } from "./analyze.js";
import { qualify } from "./qualification.js";
import { notify, notifySlip } from "./notifier.js";
import { recordPredictionSnapshot } from "../calendar/snapshots.js";
import { getCachedEvents } from "../sportybet/client.js";
import { createBooking } from "../sportybet/booking.js";
import { sameTeam } from "./normalizer.js";

const log = (...a) => console.log("[Automation]", ...a);

let inMemoryLock = false;

function runId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function alreadyAlerted(fixtureId, ruleVersion) {
  const row = db
    .prepare(
      `SELECT a.id FROM automation_alerts a
       JOIN automation_predictions p ON p.id = a.prediction_id
       JOIN automation_matches m ON m.id = p.automation_match_id
       WHERE m.fixture_id = ? AND a.rule_version = ? AND a.status = 'sent'
       LIMIT 1`
    )
    .get(String(fixtureId), ruleVersion);
  return Boolean(row);
}

function alertsSentToday() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM automation_alerts
       WHERE status = 'sent' AND date(sent_at) = date('now')`
    )
    .get();
  return row?.c ?? 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SportyBet outcome ids for the 1X2 market (mirror the events fetcher).
const OUTCOME_ID = { home: "1", draw: "2", away: "3" };

// Match a qualified fixture to a SportyBet event and build its 1X2 slip
// selection. Selections are collected across the run and combined into ONE
// booking code at the end of the run (createCombinedSlip). Never throws:
// any failure returns null and the fixture is simply left out of the slip.
export async function matchSportybetSelection({ config, analysis, prediction, fixtureId }) {
  if (!config.sportyBetBookingEnabled) return null;
  try {
    const home = analysis.match?.home?.name;
    const away = analysis.match?.away?.name;
    const outcomeId = OUTCOME_ID[String(prediction?.predictedOutcome || "").toLowerCase()];
    if (!home || !away || !outcomeId) return null;

    // Cached events only — never refetch uncached per fixture.
    const { events } = await getCachedEvents();
    const candidates = (Array.isArray(events) ? events : []).filter(
      (e) => e && sameTeam(e.homeTeam, home) && sameTeam(e.awayTeam, away)
    );
    if (!candidates.length) return null;

    // Prefer a same-tournament event when the fuzzy match is ambiguous.
    let event = candidates[0];
    if (candidates.length > 1) {
      const league = String(analysis.match?.league?.name || "").toLowerCase();
      const sameTourney = candidates.find((e) => {
        const t = String(e.tournament || "").toLowerCase();
        return t && league && (t.includes(league) || league.includes(t));
      });
      if (sameTourney) event = sameTourney;
    }

    if (!event.odds) {
      log(`slip selection skipped: no 1X2 odds for ${home} vs ${away}`);
      return null;
    }
    if (Date.parse(event.kickoffISO) <= Date.now()) {
      log(`slip selection skipped: kickoff already passed for ${home} vs ${away}`);
      return null;
    }

    return {
      eventId: event.eventId,
      marketId: "1",
      outcomeId,
      fixtureId: String(fixtureId || ""),
      homeTeam: home,
      awayTeam: away,
      predictedOutcome: String(prediction.predictedOutcome || "").toLowerCase(),
      league: analysis.match?.league?.name || null,
      kickoff: analysis.match?.kickoff || null,
    };
  } catch (e) {
    log(
      `slip selection failed for ${analysis.match?.home?.name} vs ${analysis.match?.away?.name}: ${e.code || e.message}`
    );
    return null;
  }
}

// SQLite cannot bind undefined, NaN, or objects. Sanitize numerics.
function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function runAutomation({ manual = false, overrides = {} } = {}) {
  const config = { ...loadEffectiveConfig(db), ...overrides };

  if (!config.enabled && !manual) {
    log("run skipped: automation disabled");
    return { skipped: true, reason: "disabled" };
  }
  if (inMemoryLock) {
    log("run skipped: another run is in progress");
    return { skipped: true, reason: "locked" };
  }
  const stale = db
    .prepare("SELECT id FROM automation_runs WHERE status = 'running' LIMIT 1")
    .get();
  if (stale) {
    log(`run skipped: run ${stale.id} still marked running`);
    return { skipped: true, reason: "locked" };
  }

  inMemoryLock = true;
  const id = runId();
  const startedAt = new Date().toISOString();
  const dryRun = config.dryRun ? 1 : 0;

  db.prepare(
    `INSERT INTO automation_runs (id, started_at, status, dry_run) VALUES (?, ?, 'running', ?)`
  ).run(id, startedAt, dryRun);
  log(`run ${id} started${dryRun ? " (dry-run)" : ""}`);

  const counts = {
    discovered: 0,
    matched: 0,
    analyzed: 0,
    qualified: 0,
    rejected: 0,
    alerted: 0,
    errors: 0,
  };

  try {
    // ---- Collect ----
    let discovered;
    try {
      discovered = await collectUpcoming({
        maxHoursBeforeKickoff: config.maxHoursBeforeKickoff,
      });
    } catch (e) {
      const code = e.code || "PROVIDER_UNAVAILABLE";
      log(`run ${id}: collector failed: ${code}`);
      finishRun(id, counts, "failed", code);
      return { runId: id, status: "failed", error: code, counts };
    }
    counts.discovered = discovered.length;

    // Soonest kickoff first; cap per run.
    discovered.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    const batch = discovered.slice(0, config.maxMatchesPerRun);

    let alertsToday = alertsSentToday();
    const slipSelections = [];

    for (const norm of batch) {
      try {
        await processOne({ id, norm, config, counts, getAlertsToday: () => alertsToday, bumpAlerts: () => alertsToday++, slipSelections });
      } catch (e) {
        counts.errors++;
        log(`run ${id}: match ${norm.homeTeam} vs ${norm.awayTeam} failed: ${e.code || e.message}`);
      }
      // Gentle pacing for the free-tier rate limit (~10 req/min).
      await sleep(1500);
    }

    // ---- Combined SportyBet slip: one booking code for every qualified
    // game in this run (slip reservation only — never a placed bet).
    // Non-fatal: a booking failure never fails the run.
    if (!dryRun && slipSelections.length > 0) {
      try {
        await createCombinedSlip({ id, config, selections: slipSelections });
      } catch (e) {
        log(`run ${id}: combined slip failed (non-fatal): ${e.message}`);
      }
    }

    finishRun(id, counts, "completed", null);
    log(
      `run ${id} completed: ${counts.discovered} discovered, ${counts.analyzed} analyzed, ` +
        `${counts.qualified} qualified, ${counts.alerted} alerted, ${counts.errors} errors`
    );
    return { runId: id, status: "completed", dryRun: Boolean(dryRun), counts };
  } catch (e) {
    finishRun(id, counts, "failed", e.message);
    return { runId: id, status: "failed", error: e.message, counts };
  } finally {
    inMemoryLock = false;
  }
}

async function processOne({ id: runId, norm, config, counts, getAlertsToday, bumpAlerts, slipSelections }) {
  // ---- Match ----
  const matched = await matchFixture(norm);
  const matchRow = db
    .prepare(
      `INSERT INTO automation_matches
         (run_id, source, source_match_id, fixture_id, home_team, away_team,
          league, league_id, kickoff, match_status, matching_confidence,
          match_outcome, match_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      norm.source,
      norm.sourceMatchId,
      matched.fixtureId,
      norm.homeTeam,
      norm.awayTeam,
      norm.league,
      norm.leagueId ? String(norm.leagueId) : null,
      norm.kickoff,
      norm.status,
      matched.confidence,
      matched.outcome,
      matched.reason
    );
  const automationMatchId = Number(matchRow.lastInsertRowid);

  const markError = (msg) => {
    try {
      db.prepare(
        `UPDATE automation_matches SET match_outcome = 'error', match_reason = ? WHERE id = ?`
      ).run(String(msg).slice(0, 500), automationMatchId);
    } catch {
      /* ignore */
    }
  };

  try {
    if (matched.outcome !== "matched") {
      counts.rejected++;
      return;
    }
    counts.matched++;

    // ---- Analyze (ONE authoritative engine) ----
    let analysis;
    try {
      analysis = await analyzeFixture(matched.fixture);
    } catch (e) {
      markError(`PREDICTION_FAILED: ${e.code || e.message}`);
      throw e;
    }
    counts.analyzed++;

    // Immutable calendar snapshot of the authoritative prediction (first
    // snapshot wins). Never throws; a snapshot failure must not break the run.
    try {
      recordPredictionSnapshot(analysis.match, analysis.prediction);
    } catch (e) {
      log(`run ${id}: snapshot failed (non-fatal): ${e.message}`);
    }

    // ---- Qualify ----
    const q = qualify({
      prediction: analysis.prediction,
      match: {
        league: analysis.match.league?.name,
        leagueId: analysis.match.league?.id,
        kickoff: analysis.match.kickoff,
        status: "NS",
      },
      config,
    });

    // ---- Snapshot (immutable) ----
    const p = analysis.prediction;
    let predictionId;
    try {
      const predRow = db
        .prepare(
          `INSERT INTO automation_predictions
             (automation_match_id, model_version, home_probability, draw_probability,
              away_probability, predicted_outcome, confidence, data_completeness,
              expected_home_goals, expected_away_goals, factors, blended_with_odds,
              qualified, qualification_reason, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          automationMatchId,
          analysis.modelVersion,
          num(p.homeWin, 0),
          num(p.draw, 0),
          num(p.awayWin, 0),
          p.predictedOutcome,
          num(p.confidence, 0),
          num(p.dataCompleteness, 0),
          num(p.expectedHomeGoals),
          num(p.expectedAwayGoals),
          JSON.stringify(p.factors || []),
          p.blendedWithOdds ? 1 : 0,
          q.qualified ? 1 : 0,
          q.qualified ? "passed all configured criteria" : q.reasons.join("; "),
          new Date().toISOString()
        );
      predictionId = Number(predRow.lastInsertRowid);
    } catch (e) {
      markError(`SNAPSHOT_FAILED: ${e.message}`);
      throw e;
    }

  if (!q.qualified) {
    counts.rejected++;
    log(`fixture ${matched.fixtureId} rejected: ${q.reasons.join("; ")}`);
    return;
  }
  counts.qualified++;

  // ---- Duplicate prevention ----
  if (alreadyAlerted(matched.fixtureId, config.ruleVersion)) {
    log(`fixture ${matched.fixtureId} already alerted under ${config.ruleVersion} — skipping`);
    return;
  }
  if (counts.alerted >= config.maxAlertsPerRun) {
    log(`run ${runId}: max alerts per run reached (${config.maxAlertsPerRun})`);
    return;
  }
  if (getAlertsToday() >= config.maxAlertsPerDay) {
    log(`daily alert cap reached (${config.maxAlertsPerDay})`);
    return;
  }

  // ---- Notify ----
  if (config.dryRun) {
    log(`[dry-run] would alert: ${analysis.match.home.name} vs ${analysis.match.away.name} (${p.predictedOutcome}, conf ${p.confidence.toFixed(0)})`);
    return;
  }

  // SportyBet slip selection: collected across the run and combined into
  // ONE booking code at the end of the run (createCombinedSlip). The alert
  // goes out immediately without a code; the slip message follows the run.
  const selection = await matchSportybetSelection({
    config,
    analysis,
    prediction: p,
    fixtureId: matched.fixtureId,
  });
  if (selection) slipSelections.push(selection);

  const results = await notify({
    config,
    payload: {
      match: analysis.match,
      prediction: p,
      modelVersion: analysis.modelVersion,
      qualification: q,
    },
  });

  const now = new Date().toISOString();
  // In-app alert is always recorded (this powers the in-app notification feed).
  db.prepare(
    `INSERT OR IGNORE INTO automation_alerts
       (prediction_id, rule_version, notification_type, sent_at, status, error)
     VALUES (?, ?, 'in_app', ?, 'sent', NULL)`
  ).run(predictionId, config.ruleVersion, now);

  if (results.telegram && !results.telegram.skipped) {
    db.prepare(
      `INSERT OR IGNORE INTO automation_alerts
         (prediction_id, rule_version, notification_type, sent_at, status, error)
       VALUES (?, ?, 'telegram', ?, ?, ?)`
    ).run(
      predictionId,
      config.ruleVersion,
      now,
      results.telegram.ok ? "sent" : "failed",
      results.telegram.ok ? null : results.telegram.reason
    );
  }

  counts.alerted++;
  bumpAlerts();
  log(`alert sent: ${analysis.match.home.name} vs ${analysis.match.away.name}`);
  } catch (e) {
    // Catch-all for any failure in the post-match pipeline stages.
    const detail = `${e.code || e.name}: ${e.message}\n${(e.stack || "").split("\n").slice(1, 4).join("\n")}`;
    markError(`PIPELINE_FAILED: ${detail}`);
    throw e;
  }
}

// Create ONE combined SportyBet share-booking for every qualified game in
// the run (slip reservation only — never a placed bet). Persists one
// sportybet_bookings row per fixture sharing the code, then sends a single
// combined slip message to Telegram. Never throws: any failure is logged
// and the run is unaffected (the per-game pick alerts already went out).
export async function createCombinedSlip({ id: runId, config, selections }) {
  if (!config.sportyBetBookingEnabled) {
    log(`run ${runId}: combined slip disabled, skipping`);
    return null;
  }
  const items = (Array.isArray(selections) ? selections : []).slice(0, 20);
  if (!items.length) return null;

  let booking;
  try {
    booking = await createBooking(
      items.map((s) => ({
        eventId: s.eventId,
        marketId: "1",
        outcomeId: s.outcomeId,
      }))
    );
  } catch (e) {
    log(`run ${runId}: combined booking failed: ${e.message}`);
    return null;
  }

  const now = new Date().toISOString();
  for (const s of items) {
    try {
      const alertRow = db
        .prepare(
          `SELECT a.id FROM automation_alerts a
           JOIN automation_predictions p ON p.id = a.prediction_id
           JOIN automation_matches m ON m.id = p.automation_match_id
           WHERE m.fixture_id = ? AND a.notification_type = 'in_app'
           ORDER BY a.id DESC LIMIT 1`
        )
        .get(String(s.fixtureId));
      db.prepare(
        `INSERT INTO sportybet_bookings
           (alert_id, fixture_id, sportybet_event_id, home_team, away_team,
            predicted_outcome, share_code, share_url, deadline, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        alertRow ? Number(alertRow.id) : null,
        String(s.fixtureId),
        String(s.eventId || ""),
        String(s.homeTeam || ""),
        String(s.awayTeam || ""),
        String(s.predictedOutcome || ""),
        booking.shareCode,
        booking.shareURL,
        booking.deadline,
        now
      );
    } catch (e) {
      log(`run ${runId}: slip persistence failed for ${s.homeTeam} vs ${s.awayTeam} (non-fatal): ${e.message}`);
    }
  }

  const results = await notifySlip({ config, games: items, booking }).catch((e) => ({
    telegram: { ok: false, reason: e.message },
  }));
  log(
    `run ${runId}: combined slip ${booking.shareCode} (${items.length} games), ` +
      `telegram=${results.telegram && results.telegram.ok ? "sent" : "failed/skipped"}`
  );
  return booking;
}

function finishRun(id, counts, status, error) {
  db.prepare(
    `UPDATE automation_runs SET
       completed_at = ?, status = ?,
       discovered_count = ?, matched_count = ?, analyzed_count = ?,
       qualified_count = ?, rejected_count = ?, alerted_count = ?,
       error_count = ?, error = ?
     WHERE id = ?`
  ).run(
    new Date().toISOString(),
    status,
    counts.discovered,
    counts.matched,
    counts.analyzed,
    counts.qualified,
    counts.rejected,
    counts.alerted,
    counts.errors,
    error,
    id
  );
}
