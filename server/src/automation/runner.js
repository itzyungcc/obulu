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
import { notify } from "./notifier.js";

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

    for (const norm of batch) {
      try {
        await processOne({ id, norm, config, counts, getAlertsToday: () => alertsToday, bumpAlerts: () => alertsToday++ });
      } catch (e) {
        counts.errors++;
        log(`run ${id}: match ${norm.homeTeam} vs ${norm.awayTeam} failed: ${e.code || e.message}`);
      }
      // Gentle pacing for the free-tier rate limit (~10 req/min).
      await sleep(1500);
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

async function processOne({ id: runId, norm, config, counts, getAlertsToday, bumpAlerts }) {
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
