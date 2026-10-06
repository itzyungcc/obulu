// OBULU Prediction Calendar — result resolver.
// Periodically resolves PENDING snapshots once matches are over:
//   FT    -> scores recorded, snapshot marked CORRECT / INCORRECT
//   CANCELLED | POSTPONED | ABANDONED -> VOID (never counted in accuracy)
// Runs on its own in-process unref'd interval (10 min). Sequential provider
// calls with gentle pacing; one failure never kills the pass, and the
// resolver itself never throws.
import { db } from "../db/database.js";
import { getProvider } from "../providers/index.js";

const log = (...a) => console.log("[Calendar][resolver]", ...a);

const RESOLVE_AFTER_MIN = 100; // don't bother the provider before FT is plausible
const BATCH_LIMIT = 20;
const PACE_MS = 1000;
const INTERVAL_MS = 10 * 60 * 1000;

let timer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function outcomeOf(home, away) {
  if (home > away) return "HOME";
  if (away > home) return "AWAY";
  return "DRAW";
}

async function resolveOne(row, provider) {
  const match = await provider.getMatch(row.fixture_id);
  if (!match) {
    log(`fixture ${row.fixture_id}: not found at provider, will retry`);
    return;
  }
  const now = new Date().toISOString();
  if (match.status === "FT") {
    const sh = match.score && match.score.home;
    const sa = match.score && match.score.away;
    if (sh == null || sa == null) {
      log(`fixture ${row.fixture_id}: FT but no score yet, will retry`);
      return;
    }
    const actualOutcome = outcomeOf(sh, sa);
    const verdict = actualOutcome === row.predicted_outcome ? "CORRECT" : "INCORRECT";
    db.prepare(
      `UPDATE prediction_snapshots
       SET status = ?, actual_home_score = ?, actual_away_score = ?,
           actual_outcome = ?, resolved_at = ?
       WHERE id = ? AND status = 'PENDING'`
    ).run(verdict, sh, sa, actualOutcome, now, row.id);
    log(`fixture ${row.fixture_id}: ${sh}-${sa} -> ${verdict}`);
  } else if (["CANCELLED", "POSTPONED", "ABANDONED"].includes(match.status)) {
    db.prepare(
      `UPDATE prediction_snapshots
       SET status = 'VOID', resolved_at = ?
       WHERE id = ? AND status = 'PENDING'`
    ).run(now, row.id);
    log(`fixture ${row.fixture_id}: ${match.status} -> VOID`);
  }
  // Anything else (NS, LIVE, unexpected): leave PENDING for the next pass.
}

export async function resolvePendingSnapshots(providerOverride) {
  try {
    const provider = providerOverride || getProvider();
    if (!provider) return; // honest no-op: no provider, nothing to resolve
    const cutoff = new Date(Date.now() - RESOLVE_AFTER_MIN * 60 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT id, fixture_id, predicted_outcome
         FROM prediction_snapshots
         WHERE status = 'PENDING' AND kickoff < ?
         ORDER BY kickoff ASC LIMIT ?`
      )
      .all(cutoff, BATCH_LIMIT);
    if (!rows.length) return;
    for (const row of rows) {
      try {
        await resolveOne(row, provider);
      } catch (e) {
        log(`fixture ${row.fixture_id} failed: ${e.message}`);
      }
      await sleep(PACE_MS); // protect the free-tier quota
    }
  } catch (e) {
    log("pass failed (non-fatal):", e.message);
  }
}

export function startResolver() {
  if (timer) {
    log("resolver already running");
    return true;
  }
  log("result resolver started: every 10 min");
  timer = setInterval(() => {
    resolvePendingSnapshots();
  }, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function stopResolver() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log("resolver stopped");
  }
}
