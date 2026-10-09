// OBULU AI — Gemini-powered assistant, rebuilt for reliability.
//
// Architecture: browser -> POST /api/assistant/stream (SSE) -> this module
// -> Gemini streamGenerateContent. The API key never leaves the server.
//
// Reliability design:
// - Streaming: first token is forwarded immediately; the UI never stares at
//   a spinner for the whole generation.
// - Bounded time: 30s to first token, 75s total per request, then a
//   controlled TIMEOUT error. Nothing hangs forever.
// - Retries: up to 2 automatic retries (3 attempts total) on transient
//   failures (network, 5xx, 429) with backoff. Model-chain fallback on
//   404/400.
// - Every request ends in exactly one terminal state: ok | timeout |
//   error | cancelled.
// - Page context: when the frontend supplies real match data, it is used
//   directly and the expensive fixtures fetch is skipped.
// - Logging: timing + outcome + error category. Never the API key.

import { getProvider } from "../providers/index.js";
import { db } from "../db/database.js";

const MODEL_CHAIN = (process.env.GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-flash-latest")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const GEMINI_STREAM_URL = (key, model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
const GEMINI_URL = (key, model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const FIRST_TOKEN_TIMEOUT_MS = 40000;
const TOTAL_TIMEOUT_MS = 75000;
const MAX_ATTEMPTS = 2; // 1 initial + 1 retry (worst case ~81s < 90s frontend cap)
const RETRY_DELAYS_MS = [1000];

export function chatConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function assistantModels() {
  return [...MODEL_CHAIN];
}

// ---------------------------------------------------------------------------
// Context builders (real OBULU data only)
// ---------------------------------------------------------------------------

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

// Page context supplied by the frontend (real data already on screen).
// When present, the expensive fixtures fetch is skipped.
function pageContextText(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  if (ctx.page === "match" && ctx.match) {
    const m = ctx.match;
    const p = m.prediction || {};
    const lines = [
      "CURRENT PAGE: match analysis (data shown on screen right now).",
      `Match: ${m.home || "?"} vs ${m.away || "?"}${m.league ? ` (${m.league})` : ""}${m.kickoff ? `, kickoff ${m.kickoff}` : ""}.`,
    ];
    if (p.homeWin != null) {
      lines.push(
        `OBULU prediction: ${p.outcome || "?"} — home ${Math.round(p.homeWin)}%, draw ${Math.round(p.draw || 0)}%, away ${Math.round(p.awayWin)}%.` +
          (p.confidence != null ? ` Confidence ${Math.round(p.confidence)} (${p.confidenceLabel || ""}).` : "")
      );
    }
    if (Array.isArray(m.factors) && m.factors.length) {
      lines.push("Prediction factors: " + m.factors.slice(0, 8).join(" | "));
    }
    if (m.form) lines.push(`Form notes: ${String(m.form).slice(0, 500)}`);
    return lines.join("\n");
  }
  if (ctx.page) return `CURRENT PAGE: ${ctx.page}.`;
  return "";
}

const SYSTEM_PROMPT = `You are OBULU AI, the intelligent football analysis assistant inside the OBULU app.
OBULU is an informational football statistics platform. Its predictions come from a Poisson/Dixon-Coles statistical model.

STRICT RULES:
- Answer ONLY from the OBULU data provided below. If the data doesn't cover the question, say so plainly — never invent matches, scores, probabilities, injuries, odds, or team news.
- Keep answers concise and phone-friendly: 2-6 short paragraphs or bullet points unless the user asks for detail.
- Probabilities are the model's statistical estimates, not guarantees. Use language like "OBULU estimates…", "based on the available data…", "there's still uncertainty…". Never claim certainty about future results.
- NEVER give betting advice, never recommend stakes, never suggest anyone should bet. You may explain what the model's numbers mean.
- If asked about a specific match, look for it in the data. Team name matching is fuzzy (e.g. "Man City" = "Manchester City").
- Do not pretend to have accessed data that was not supplied to you.

OBULU DATA:
`;

// ---------------------------------------------------------------------------
// Gemini streaming core
// ---------------------------------------------------------------------------

function buildPayload(systemData, history, userMessage, model) {
  const generationConfig = { maxOutputTokens: 500, temperature: 0.4 };
  // Keep thinking cheap: Gemini 2.5 uses a numeric budget, Gemini 3+ uses a
  // level string (numeric budgets are rejected with 400 on 3.x). The rolling
  // alias is treated as current-generation. If the API rejects the field,
  // the caller retries the same model without it.
  const thinking = thinkingConfigFor(model);
  if (thinking) generationConfig.thinkingConfig = thinking;
  return {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT + systemData }] },
    contents: [
      ...history.slice(-8).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.text || "").slice(0, 2000) }],
      })),
      { role: "user", parts: [{ text: userMessage }] },
    ],
    generationConfig,
  };
}

// Exported for unit tests.
export function thinkingConfigFor(model) {
  if (/2\.5/.test(model)) return { thinkingBudget: 256 };
  return { thinkingLevel: "low" };
}

function classifyError(status, message) {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "AUTH";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 400) return "BAD_REQUEST";
  if (status >= 500) return "UPSTREAM_5XX";
  if (/abort/i.test(message || "")) return "TIMEOUT";
  return "NETWORK";
}

const TRANSIENT = new Set(["RATE_LIMITED", "UPSTREAM_5XX", "NETWORK", "TIMEOUT"]);

// Parse one Gemini SSE data payload into text delta ("" if none).
function sseTextDelta(data) {
  try {
    const json = JSON.parse(data);
    const parts = json.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  } catch {
    return "";
  }
}

/**
 * Stream a Gemini reply. Calls onToken(text) for each delta.
 * Resolves { text, model, firstTokenMs, totalMs } or throws a coded error:
 *   TIMEOUT | RATE_LIMITED | AUTH | UPSTREAM | EMPTY_RESPONSE | CANCELLED
 * `signal` (AbortSignal) cancels the request -> throws CANCELLED.
 */
export async function chatReplyStream({ systemData, history = [], userMessage, onToken, signal, timeouts = {} }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error("CHAT_NOT_CONFIGURED");
    err.code = "CHAT_NOT_CONFIGURED";
    throw err;
  }
  const firstTokenTimeout = timeouts.firstTokenMs ?? FIRST_TOKEN_TIMEOUT_MS;
  const totalTimeout = timeouts.totalMs ?? TOTAL_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastErr = null;
  // Models whose thinking field was rejected (400): retry without it.
  const thinkingStripped = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const model = MODEL_CHAIN[(attempt - 1) % MODEL_CHAIN.length];
    // Build the payload per attempt: the thinking field depends on the model.
    const payload = buildPayload(systemData, history, userMessage, model);
    if (thinkingStripped.has(model)) delete payload.generationConfig.thinkingConfig;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) {
        const err = new Error("CANCELLED");
        err.code = "CANCELLED";
        throw err;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const firstTokenTimer = setTimeout(() => ctrl.abort(), firstTokenTimeout);
    const totalTimer = setTimeout(() => ctrl.abort(), totalTimeout);
    let firstTokenAt = 0;

    try {
      const res = await fetch(GEMINI_STREAM_URL(key, model), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        const category = classifyError(res.status, t);
        lastErr = new Error(`Gemini ${res.status} on ${model}`);
        lastErr.code = category;
        lastErr.status = res.status;
        // The thinking field may be rejected on some model generations (400
        // with no field named). Retry the same model once without it; the
        // attempt-- keeps this param fix from consuming the retry budget.
        if (category === "BAD_REQUEST" && !thinkingStripped.has(model) && payload.generationConfig?.thinkingConfig) {
          thinkingStripped.add(model);
          logAttempt({ model, attempt, outcome: "thinking_retry", totalMs: Date.now() - startedAt });
          attempt--;
          continue;
        }
        // Model missing / bad request: fall through to next model immediately.
        if (category === "MODEL_NOT_FOUND" || category === "BAD_REQUEST") {
          logAttempt({ model, attempt, outcome: category.toLowerCase(), totalMs: Date.now() - startedAt });
          continue;
        }
        if (TRANSIENT.has(category) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAYS_MS[attempt - 1] || 2000);
          continue;
        }
        throw lastErr;
      }

      // Stream SSE chunks.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let gotToken = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const delta = sseTextDelta(data);
          if (delta) {
            if (!gotToken) {
              gotToken = true;
              firstTokenAt = Date.now();
              clearTimeout(firstTokenTimer);
            }
            fullText += delta;
            if (onToken) onToken(delta);
          }
        }
        if (signal?.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          const err = new Error("CANCELLED");
          err.code = "CANCELLED";
          throw err;
        }
      }

      const text = fullText.trim();
      if (!text) {
        lastErr = new Error("EMPTY_RESPONSE");
        lastErr.code = "EMPTY_RESPONSE";
        // One extra attempt for empty responses is handled by the loop.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAYS_MS[attempt - 1] || 2000);
          continue;
        }
        throw lastErr;
      }
      const totalMs = Date.now() - startedAt;
      logAttempt({ model, attempt, outcome: "ok", firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null, totalMs });
      return { text, model, firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null, totalMs };
    } catch (e) {
      if (e.code === "CANCELLED" || signal?.aborted) {
        const err = new Error("CANCELLED");
        err.code = "CANCELLED";
        throw err;
      }
      // Terminal codes set deliberately upstream: pass through unchanged.
      if (
        e.code === "EMPTY_RESPONSE" ||
        e.code === "AUTH" ||
        e.code === "MODEL_NOT_FOUND" ||
        e.code === "BAD_REQUEST"
      ) {
        logAttempt({ model, attempt, outcome: e.code.toLowerCase(), totalMs: Date.now() - startedAt });
        throw e;
      }
      const category =
        typeof e.code === "string" && TRANSIENT.has(e.code)
          ? e.code
          : /abort/i.test(e.name || "")
            ? "TIMEOUT"
            : "NETWORK";
      // Never mutate the original error (e.g. DOMException.code is read-only).
      lastErr = Object.assign(new Error(e.message || "request failed"), { code: category });
      if (e.status) lastErr.status = e.status;
      logAttempt({ model, attempt, outcome: category.toLowerCase(), totalMs: Date.now() - startedAt });
      if (e.code === "MODEL_NOT_FOUND" || e.code === "BAD_REQUEST" || e.code === "AUTH") throw lastErr;
      if (TRANSIENT.has(category) && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1] || 2000);
        continue;
      }
      // Normalize to a small set of terminal codes.
      if (category === "TIMEOUT") lastErr.code = "TIMEOUT";
      else if (category === "RATE_LIMITED") lastErr.code = "RATE_LIMITED";
      else if (category === "UPSTREAM_5XX" || category === "NETWORK") lastErr.code = "UPSTREAM";
      throw lastErr;
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || Object.assign(new Error("UPSTREAM"), { code: "UPSTREAM" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recent attempt metadata for GET /api/assistant/diagnostics. Timing and
// outcome only — never message content, never the API key.
const recentAttempts = [];
const MAX_ATTEMPT_LOG = 50;

function logAttempt({ model, attempt, outcome, firstTokenMs, totalMs }) {
  const entry = {
    t: new Date().toISOString(),
    model,
    attempt,
    outcome,
    firstTokenMs: firstTokenMs ?? null,
    totalMs: totalMs ?? null,
  };
  recentAttempts.push(entry);
  if (recentAttempts.length > MAX_ATTEMPT_LOG) recentAttempts.shift();
  // Timing + outcome only. Never the API key or conversation content.
  console.log(
    `[assistant] model=${model} attempt=${attempt} outcome=${outcome}` +
      (firstTokenMs != null ? ` firstTokenMs=${firstTokenMs}` : "") +
      (totalMs != null ? ` totalMs=${totalMs}` : "")
  );
}

export function getAssistantDiagnostics() {
  return {
    models: assistantModels(),
    recentAttempts: [...recentAttempts].reverse(),
  };
}

// Lists models available to the configured API key (names only; the key is
// never exposed). Used to pick a working model when the chain 404s.
export async function listAvailableModels() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error("CHAT_NOT_CONFIGURED");
    err.code = "CHAT_NOT_CONFIGURED";
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { signal: ctrl.signal }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.code = classifyError(res.status, "");
      throw err;
    }
    return (data.models || [])
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean)
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

// Greetings and meta questions need no fixture data: skip the provider call
// entirely (faster + smaller prompt). Everything else gets the full context.
const SMALLTALK_RE = /^(hi|hey|hello|yo|thanks?|thank you|ok|okay|bye|good\s?(morning|afternoon|evening|day)|what can you do|help|who are you|what are you)\b/i;

function needsFixtures(userMessage) {
  return !SMALLTALK_RE.test(String(userMessage || "").trim());
}

export async function buildSystemData(pageContext, userMessage = "") {
  const page = pageContextText(pageContext);
  if (page) {
    // Match-page fast path: real on-screen data, no fixtures fetch.
    const [predictions, automation] = await Promise.all([
      Promise.resolve(recentPredictionsContext()),
      Promise.resolve(automationContext()),
    ]);
    return [page, "", "RECENT OBULU PREDICTIONS:", predictions, "", "AUTOMATION:", automation].join("\n");
  }
  const [fixtures, predictions, automation] = await Promise.all([
    needsFixtures(userMessage) ? upcomingContext() : Promise.resolve(""),
    Promise.resolve(recentPredictionsContext()),
    Promise.resolve(automationContext()),
  ]);
  return [
    ...(fixtures ? ["UPCOMING FIXTURES:", fixtures, ""] : []),
    "RECENT OBULU PREDICTIONS:",
    predictions,
    "",
    "AUTOMATION:",
    automation,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

function checkRateLimit(ip) {
  if (rateLimited(ip || "unknown")) {
    const err = new Error("RATE_LIMITED");
    err.code = "RATE_LIMITED";
    throw err;
  }
}

function cleanMessage(message) {
  const text = String(message || "").trim().slice(0, 1000);
  if (!text) {
    const err = new Error("EMPTY_MESSAGE");
    err.code = "EMPTY_MESSAGE";
    throw err;
  }
  return text;
}

/**
 * Streaming entry point used by POST /api/assistant/stream.
 * onToken receives text deltas. Resolves the full reply or throws a coded error.
 */
export async function assistantReplyStream({ message, history = [], pageContext = null, ip, onToken, signal }) {
  if (!chatConfigured()) {
    const err = new Error("CHAT_NOT_CONFIGURED");
    err.code = "CHAT_NOT_CONFIGURED";
    throw err;
  }
  checkRateLimit(ip);
  const text = cleanMessage(message);
  const systemData = await buildSystemData(pageContext, text);
  return chatReplyStream({ systemData, history, userMessage: text, onToken, signal });
}

/**
 * Non-streaming entry point (kept for the /api/chat route + Chat tab).
 * Collects the stream; falls back to a single generateContent call if the
 * streaming HTTP request itself fails before any token.
 */
export async function chatReply({ message, history = [], ip, pageContext = null }) {
  if (!chatConfigured()) {
    const err = new Error("CHAT_NOT_CONFIGURED");
    err.code = "CHAT_NOT_CONFIGURED";
    throw err;
  }
  checkRateLimit(ip);
  const text = cleanMessage(message);
  const systemData = await buildSystemData(pageContext, text);
  let full = "";
  try {
    const { text: reply, model } = await chatReplyStream({
      systemData,
      history,
      userMessage: text,
      onToken: (d) => { full += d; },
    });
    return { reply, model };
  } catch (e) {
    if (full.trim()) return { reply: full.trim(), model: "partial" };
    throw e;
  }
}
