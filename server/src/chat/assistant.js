// OBULU Chat — Gemini-powered assistant grounded in real OBULU data.
// The bot ONLY answers from data we feed it (fixtures, predictions, jackpot,
// automation status). It never invents matches or probabilities.
// Informational only: no betting advice, no bet placement, no odds selling.

import { getProvider } from "../providers/index.js";
import { db } from "../db/database.js";
import { analyzeFixture } from "../automation/analyze.js";
import { sameTeam } from "../automation/normalizer.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

export function chatConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// --- Context builders (real OBULU data only) ---

async function upcomingContext(limit = 15) {
  try {
    const provider = getProvider();
    if (!provider) return "No data provider configured.";
    const fixtures = (await provider.getUpcomingFixtures()) || [];
    const now = Date.now();
    const upcoming = fixtures
      .filter((f) => f.status === "NS" && Date.parse(f.kickoff) >= now)
      .slice(0, limit);
    if (!upcoming.length) return "No upcoming fixtures found.";
    return upcoming
      .map(
        (f) =>
          `- ${f.home?.name} vs ${f.away?.name} (${f.league?.name || "?"}, ${f.kickoff})`
      )
      .join("\n");
  } catch (e) {
    return `Fixture lookup failed: ${e.message}`;
  }
}

function recentPredictionsContext(limit = 10) {
  try {
    const rows = db
      .prepare(
        `SELECT home_team, away_team, league, predicted_outcome, home_win, draw, away_win,
                confidence_score, kickoff_date, status
         FROM prediction_snapshots
         ORDER BY predicted_at DESC LIMIT ?`
      )
      .all(limit);
    if (!rows.length) return "No predictions recorded yet.";
    return rows
      .map(
        (r) =>
          `- ${r.home_team} vs ${r.away_team} (${r.league}, ${r.kickoff_date}): ` +
          `pick ${r.predicted_outcome} ` +
          `(${Math.round(r.home_win || 0)}/${Math.round(r.draw || 0)}/${Math.round(r.away_win || 0)}), ` +
          `confidence ${Math.round(r.confidence_score || 0)} [${r.status}]`
      )
      .join("\n");
  } catch {
    return "Prediction history unavailable.";
  }
}

function automationContext() {
  try {
    const run = db
      .prepare(
        `SELECT id, started_at, fixtures_discovered, fixtures_matched, fixtures_analyzed,
                matches_qualified, alerts_sent, errors
         FROM automation_runs ORDER BY started_at DESC LIMIT 1`
      )
      .get();
    if (!run) return "Automation has not run yet.";
    return (
      `Last automation run ${run.started_at}: ${run.fixtures_discovered} fixtures discovered, ` +
      `${run.fixtures_analyzed} analyzed, ${run.matches_qualified} qualified, ` +
      `${run.alerts_sent} alerts sent, ${run.errors} errors.`
    );
  } catch {
    return "Automation status unavailable.";
  }
}

const SYSTEM_PROMPT = `You are OBULU Assistant, a football prediction analyst inside the OBULU app.
OBULU is an informational football statistics platform. Its predictions come from a Poisson/Dixon-Coles statistical model.

STRICT RULES:
- Answer ONLY from the OBULU data provided below. If the data doesn't cover the question, say so plainly — never invent matches, scores, or probabilities.
- Keep answers short and phone-friendly (2-4 sentences unless detail is asked for).
- Probabilities are the model's statistical estimates, not guarantees.
- NEVER give betting advice, never recommend stakes, never suggest anyone should bet. You may explain what the model's numbers mean.
- If asked about a specific match, look for it in the data. Team name matching is fuzzy (e.g. "Man City" = "Manchester City").
- Today's date context is included in the data timestamps (UTC).

OBULU DATA:
`;

// --- Gemini call ---

async function askGemini(systemData, history, userMessage) {
  const key = process.env.GEMINI_API_KEY;
  const contents = [
    ...history.slice(-8).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];
  const res = await fetch(GEMINI_URL(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT + systemData }] },
      contents,
      generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini returned an empty response");
  return text.trim();
}

// --- Public API ---

// Simple in-memory per-IP rate limit: 20 messages/hour.
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < 3600 * 1000);
  if (fresh.length >= 20) return true;
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return false;
}

export async function chatReply({ message, history = [], ip }) {
  if (!chatConfigured()) {
    const err = new Error("CHAT_NOT_CONFIGURED");
    err.code = "CHAT_NOT_CONFIGURED";
    throw err;
  }
  if (rateLimited(ip || "unknown")) {
    const err = new Error("RATE_LIMITED");
    err.code = "RATE_LIMITED";
    throw err;
  }
  const text = String(message || "").trim().slice(0, 1000);
  if (!text) {
    const err = new Error("EMPTY_MESSAGE");
    err.code = "EMPTY_MESSAGE";
    throw err;
  }

  const [fixtures, predictions, automation] = await Promise.all([
    upcomingContext(),
    Promise.resolve(recentPredictionsContext()),
    Promise.resolve(automationContext()),
  ]);
  const systemData = [
    "UPCOMING FIXTURES:",
    fixtures,
    "",
    "RECENT OBULU PREDICTIONS:",
    predictions,
    "",
    "AUTOMATION:",
    automation,
  ].join("\n");

  const reply = await askGemini(systemData, history, text);
  return { reply, model: GEMINI_MODEL };
}
