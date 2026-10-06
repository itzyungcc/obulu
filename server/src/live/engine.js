// OBULU Live Prediction Engine.
// Polls the provider for in-play fixtures, computes live win/draw/win
// probabilities from the pre-match baseline + live state, and persists
// snapshots only when the picture materially changes.
//
// Design mirrors the automation scheduler: in-process unref'd setInterval,
// a tick guard so polls never overlap, sequential provider calls through
// the provider's own rate limiter, gentle pacing, and the engine NEVER
// throws — a provider/API failure keeps the last known state and the tick
// continues.
import config from "../config.js";
import { db } from "../db/database.js";
import { getProvider } from "../providers/index.js";
import { analyzeFixture } from "../automation/analyze.js";
import { getSnapshot } from "../calendar/snapshots.js";
import { computeLivePrediction } from "../model/livePredict.js";

const log = (...a) => console.log("[Live]", ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory latest live state: fixtureId -> { fixture, preMatch,
// baselineSource, live, score, minute, minuteSource, redCards, stats,
// trackedSince, lastSeen, lastSnapshot }. DB persistence is write-only
// snapshots; reads are always from this map (fast).
const latest = new Map();

let timer = null;
let tickInFlight = false;

// Observability for GET /api/live/status: when the last poll ran, whether it
// errored, and how many live fixtures the provider reported. Updated on every
// tick so a silent failure is visible instead of looking like "no matches".
let lastPollAt = null;
let lastPollError = null;
let lastFixtureCount = null;

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function outcomeOf(home, away) {
  if (home > away) return "HOME";
  if (away > home) return "AWAY";
  return "DRAW";
}

// Persist-decision for live_predictions rows. Pure + exported for tests.
// next: { homeWin, draw, awayWin, scoreHome, scoreAway, redHome, redAway }
// prev: null on first sighting, else { ...next, createdAtMs }
export function shouldPersistSnapshot(
  prev,
  next,
  { deltaThreshold = 3, maxGapMs = 10 * 60 * 1000, nowMs = Date.now() } = {}
) {
  if (!prev) return true;
  const deltas = [
    Math.abs(next.homeWin - prev.homeWin),
    Math.abs(next.draw - prev.draw),
    Math.abs(next.awayWin - prev.awayWin),
  ];
  if (deltas.some((d) => d >= deltaThreshold)) return true;
  if (next.scoreHome !== prev.scoreHome || next.scoreAway !== prev.scoreAway) return true;
  if (next.redHome !== prev.redHome || next.redAway !== prev.redAway) return true;
  if (nowMs - prev.createdAtMs >= maxGapMs) return true;
  return false;
}

function persistSnapshot(fixtureId, state) {
  const lv = state.live;
  db.prepare(
    `INSERT INTO live_predictions
       (fixture_id, minute, minute_source, score_home, score_away,
        red_home, red_away, home_win, draw, away_win, predicted_outcome,
        confidence_score, confidence_label, factors, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(fixtureId),
    num(state.minute),
    state.minuteSource || null,
    num(state.score?.home),
    num(state.score?.away),
    num(state.redCards?.home, 0),
    num(state.redCards?.away, 0),
    lv.homeWin,
    lv.draw,
    lv.awayWin,
    lv.predictedOutcome,
    num(lv.confidence?.score),
    lv.confidence?.label || null,
    JSON.stringify(lv.factors || []),
    new Date().toISOString()
  );
}

function trackFixture(fx) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO live_matches (fixture_id, home_team, away_team, league, kickoff, status, last_seen)
     VALUES (?, ?, ?, ?, ?, 'TRACKING', ?)
     ON CONFLICT(fixture_id) DO UPDATE
       SET status = 'TRACKING', last_seen = excluded.last_seen,
           home_team = excluded.home_team, away_team = excluded.away_team`
  ).run(
    String(fx.id),
    fx.home?.name || null,
    fx.away?.name || null,
    fx.league?.name || null,
    fx.kickoff || null,
    now
  );
}

function baselineFromSnapshot(row) {
  return {
    homeWin: row.home_win,
    draw: row.draw,
    awayWin: row.away_win,
    predictedOutcome: row.predicted_outcome,
    confidence: { score: row.confidence_score, label: row.confidence_label },
    expectedGoals: {
      home: row.expected_home_goals,
      away: row.expected_away_goals,
    },
  };
}

// Baseline for live probabilities: prefer the immutable calendar snapshot
// (the same prediction the user saw pre-match); fall back to a fresh
// computation through the automation's analyzeFixture helper (never a
// duplicated model call).
async function resolveBaseline(fixtureId, fx) {
  const row = getSnapshot(fixtureId);
  if (
    row &&
    row.expected_home_goals != null &&
    row.expected_away_goals != null
  ) {
    return { source: "snapshot", preMatch: baselineFromSnapshot(row) };
  }
  try {
    const analysis = await analyzeFixture(fx);
    const p = analysis.prediction || {};
    if (p.expectedHomeGoals == null || p.expectedAwayGoals == null) {
      log(`fixture ${fixtureId}: fresh baseline has no expected goals`);
      return null;
    }
    return {
      source: "fresh",
      preMatch: {
        homeWin: p.homeWin,
        draw: p.draw,
        awayWin: p.awayWin,
        predictedOutcome: String(p.predictedOutcome || "").toUpperCase(),
        confidence: {
          score: num(p.confidence),
          label: p.confidenceLabel || null,
        },
        expectedGoals: {
          home: p.expectedHomeGoals,
          away: p.expectedAwayGoals,
        },
      },
    };
  } catch (e) {
    log(`fixture ${fixtureId}: baseline failed: ${e.message}`);
    return null;
  }
}

async function processLiveFixture(provider, fx) {
  const fixtureId = String(fx.id);
  let detail;
  try {
    detail = await provider.getLiveMatch(fixtureId);
  } catch (e) {
    log(`fixture ${fixtureId}: getLiveMatch failed, keeping last state: ${e.message}`);
    return;
  }
  if (!detail) {
    log(`fixture ${fixtureId}: no live detail, keeping last state`);
    return;
  }

  let state = latest.get(fixtureId);
  if (!state) {
    const baseline = await resolveBaseline(fixtureId, fx);
    if (!baseline) return; // retried next tick
    state = {
      fixture: fx,
      preMatch: baseline.preMatch,
      baselineSource: baseline.source,
      trackedSince: new Date().toISOString(),
      lastSnapshot: null,
    };
    latest.set(fixtureId, state);
    try {
      trackFixture(fx);
    } catch (e) {
      log(`fixture ${fixtureId}: track failed: ${e.message}`);
    }
  } else {
    state.fixture = fx;
  }

  const reds = detail.redCards || { home: 0, away: 0 };
  const score = detail.score || { home: 0, away: 0 };
  let live;
  try {
    live = computeLivePrediction({
      preMatch: state.preMatch,
      live: {
        scoreHome: score.home,
        scoreAway: score.away,
        minute: detail.minute,
        redCardsHome: reds.home,
        redCardsAway: reds.away,
        stats: detail.stats || null,
        homeName: fx.home?.name,
        awayName: fx.away?.name,
      },
    });
  } catch (e) {
    log(`fixture ${fixtureId}: compute failed: ${e.message}`);
    return;
  }

  state.live = live;
  state.score = { home: score.home, away: score.away };
  state.minute = detail.minute;
  state.minuteSource = detail.minuteSource || null;
  state.redCards = { home: reds.home || 0, away: reds.away || 0 };
  state.stats = detail.stats || null;
  state.lastSeen = new Date().toISOString();
  state.missedPolls = 0; // seen again: reset the finalize grace counter
  try {
    db.prepare("UPDATE live_matches SET last_seen = ? WHERE fixture_id = ?").run(
      state.lastSeen,
      fixtureId
    );
  } catch {
    /* best effort */
  }

  const next = {
    homeWin: live.homeWin,
    draw: live.draw,
    awayWin: live.awayWin,
    scoreHome: num(score.home, 0),
    scoreAway: num(score.away, 0),
    redHome: reds.home || 0,
    redAway: reds.away || 0,
  };
  if (
    shouldPersistSnapshot(state.lastSnapshot, next, {
      deltaThreshold: config.liveDeltaThreshold,
      maxGapMs: config.liveMaxSnapshotGapMin * 60 * 1000,
    })
  ) {
    try {
      persistSnapshot(fixtureId, state);
      state.lastSnapshot = { ...next, createdAtMs: Date.now() };
    } catch (e) {
      log(`fixture ${fixtureId}: persist failed: ${e.message}`);
    }
  }
}

// A tracked fixture left the live list (finished, postponed, or vanished
// from the provider). Record the engine's final verdict against the actual
// result and stop tracking it. Exported for tests.
export async function finalizeFixture(provider, fixtureId, state) {
  let actualOutcome = null;
  try {
    const match = await provider.getMatch(fixtureId);
    if (!match) {
      log(`fixture ${fixtureId}: vanished at provider, finalizing without result`);
    } else if (match.status === "FT" && match.score && match.score.home != null) {
      actualOutcome = outcomeOf(match.score.home, match.score.away);
    } else if (["CANCELLED", "POSTPONED", "ABANDONED"].includes(match.status)) {
      log(`fixture ${fixtureId}: ${match.status}, finalizing`);
    } else {
      // Still live-ish at the provider (flap) — keep tracking, retry later.
      return;
    }
  } catch (e) {
    log(`fixture ${fixtureId}: finalize lookup failed, keeping tracked: ${e.message}`);
    return;
  }

  try {
    if (state.live) {
      const liveCorrect =
        actualOutcome != null
          ? state.live.predictedOutcome === actualOutcome
            ? 1
            : 0
          : null;
      db.prepare(
        `UPDATE prediction_snapshots
         SET live_final_home = ?, live_final_draw = ?, live_final_away = ?,
             live_final_outcome = ?, live_correct = ?
         WHERE fixture_id = ?`
      ).run(
        state.live.homeWin,
        state.live.draw,
        state.live.awayWin,
        state.live.predictedOutcome,
        liveCorrect,
        fixtureId
      );
      log(
        `fixture ${fixtureId}: finalized live verdict ${state.live.predictedOutcome}` +
          (actualOutcome ? ` vs actual ${actualOutcome}` : " (result unknown)")
      );
    }
    db.prepare(
      `UPDATE live_matches SET status = 'FINISHED', finished_at = ? WHERE fixture_id = ?`
    ).run(new Date().toISOString(), fixtureId);
  } catch (e) {
    log(`fixture ${fixtureId}: finalize write failed: ${e.message}`);
  }
  latest.delete(fixtureId);
}

export async function pollOnce(providerOverride) {
  const provider = providerOverride || getProvider();
  if (!provider) {
    lastPollError = "no provider configured";
    return;
  }
  let fixtures;
  try {
    fixtures = await provider.getLiveFixtures();
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    lastFixtureCount = Array.isArray(fixtures) ? fixtures.length : 0;
  } catch (e) {
    lastPollAt = new Date().toISOString();
    lastPollError = String(e.message || e).slice(0, 300);
    log(`getLiveFixtures failed, keeping last state: ${e.message}`);
    return;
  }
  const seen = new Set();
  const batch = (Array.isArray(fixtures) ? fixtures : []).slice(0, config.liveMaxMatches);
  for (const fx of batch) {
    seen.add(String(fx.id));
    try {
      await processLiveFixture(provider, fx);
    } catch (e) {
      log(`fixture ${fx.id} failed, keeping last state: ${e.message}`);
    }
    await sleep(500); // gentle pacing between fixtures
  }
  for (const [id, state] of latest) {
    if (!seen.has(id)) {
      // Grace period before finalizing: providers report half-time as
      // PAUSED (not IN_PLAY), so a match briefly leaves the live list for
      // ~15 minutes. Only finalize after N consecutive absences.
      state.missedPolls = (state.missedPolls || 0) + 1;
      if (state.missedPolls < config.liveFinalizeMissedPolls) continue;
      try {
        await finalizeFixture(provider, id, state);
      } catch (e) {
        log(`finalize ${id} failed: ${e.message}`);
      }
    }
  }
}

async function tick() {
  if (tickInFlight) return; // never overlap polls
  tickInFlight = true;
  try {
    await pollOnce();
  } catch (e) {
    log("tick failed (non-fatal):", e.message);
  } finally {
    tickInFlight = false;
  }
}

export function startLiveEngine() {
  if (!config.liveEnabled) {
    log("engine not started: LIVE_ENABLED is false");
    return false;
  }
  if (timer) {
    log("engine already running");
    return true;
  }
  const ms = config.livePollSeconds * 1000;
  log(`engine started: polling every ${config.livePollSeconds}s`);
  timer = setInterval(tick, ms);
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function stopLiveEngine() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log("engine stopped");
  }
}

// Fast in-memory read for the /api/live routes.
export function getLiveStates() {
  return Array.from(latest.entries()).map(([fixtureId, s]) => ({
    fixtureId,
    fixture: s.fixture,
    preMatch: s.preMatch,
    baselineSource: s.baselineSource,
    live: s.live,
    score: s.score,
    minute: s.minute,
    minuteSource: s.minuteSource,
    redCards: s.redCards,
    stats: s.stats,
    trackedSince: s.trackedSince,
    lastSeen: s.lastSeen,
  }));
}

// Engine health for GET /api/live/status. Answers even when the provider is
// down so a dead poller is distinguishable from "no live matches".
export function getEngineStatus() {
  return {
    enabled: config.liveEnabled === true,
    running: timer !== null,
    pollSeconds: config.livePollSeconds,
    maxMatches: config.liveMaxMatches,
    lastPollAt,
    lastPollError,
    lastFixtureCount,
    trackedCount: latest.size,
  };
}
