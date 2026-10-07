/**
 * OBULU API client.
 *
 * Base URL comes only from the Vite env var VITE_API_URL (default "" = same-origin /api).
 * No API keys live in frontend code.
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.status = status; // HTTP status, 0 = network failure
    this.code = code; // backend error code, e.g. DATA_PROVIDER_NOT_CONFIGURED
  }
}

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

// Offline Android build: serve everything on-device (sample data + real
// Poisson/Dixon-Coles model). Enabled with VITE_OBULU_OFFLINE=1.
import { localApiFetch } from "./localApi.js";

const OFFLINE = import.meta.env.VITE_OBULU_OFFLINE === "1";

// --- Request deduplication -----------------------------------------------
// If several components request the same URL simultaneously (e.g. 10 cards
// needing the same fixtures), only one network request goes out; the rest
// share its promise. Entries clear when settled.
const inflightGets = new Map();

// --- Cold-start retry ------------------------------------------------------
// Render's free tier sleeps when idle: the first request after a quiet
// period fails or hangs while the backend wakes (~up to a minute).
// Retry network failures with exponential backoff instead of showing an
// instant error.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS = [1500, 3000, 6000]; // ms between attempts 1..3

export async function apiFetch(path, params = {}) {
  if (OFFLINE) return localApiFetch(path, params);
  const { method, body: reqBody, headers, ...query } = params;
  const entries = Object.entries(query).filter(
    ([, v]) => v !== "" && v !== null && v !== undefined
  );
  const qs = new URLSearchParams(entries).toString();
  const url = `${API_BASE}/api${path}${qs ? `?${qs}` : ""}`;
  const isGet = !method || method.toUpperCase() === "GET";

  // Dedupe identical in-flight GETs.
  if (isGet && inflightGets.has(url)) return inflightGets.get(url);

  const task = (async () => {
    let lastErr = null;
    const attempts = isGet ? RETRY_DELAYS.length + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
      let res;
      try {
        res = await fetch(url, {
          ...(method ? { method } : {}),
          ...(reqBody !== undefined
            ? {
                body: typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody),
                headers: { "Content-Type": "application/json", ...(headers || {}) },
              }
            : {}),
        });
      } catch (e) {
        lastErr = new ApiError(
          0,
          "NETWORK_ERROR",
          attempt === 0
            ? "Could not reach the OBULU API. Check your connection and that the server is running, then try again."
            : "OBULU is waking up — loading the latest football data..."
        );
        continue; // retry: likely a Render cold start
      }

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (!res.ok) {
        // 5xx on a GET right after wake: the backend may still be starting.
        // Retry those too; 4xx are real client errors — throw immediately.
        if (isGet && res.status >= 500 && attempt < attempts - 1) {
          lastErr = new ApiError(res.status, body?.error || "REQUEST_FAILED", "OBULU is waking up — loading the latest football data...");
          continue;
        }
        throw new ApiError(
          res.status,
          body?.error || "REQUEST_FAILED",
          body?.message || `Request failed (HTTP ${res.status}).`
        );
      }
      return body ?? {};
    }
    throw lastErr;
  })();

  if (isGet) {
    inflightGets.set(url, task);
    task.then(
      () => inflightGets.delete(url),
      () => inflightGets.delete(url)
    );
  }
  return task;
}

export const getHealth = () => apiFetch("/health");
export const getLeagues = () => apiFetch("/leagues");
export const getUpcoming = (filters = {}) => apiFetch("/fixtures/upcoming", filters);
export const getAllFixtures = (filters = {}) => apiFetch("/fixtures/all", filters);
export const searchTeams = (q) => apiFetch("/teams/search", { q });
export const getMatch = (id) => apiFetch(`/matches/${encodeURIComponent(id)}`);
export const getAnalysis = (id) => apiFetch(`/matches/${encodeURIComponent(id)}/analysis`);
export const getPrediction = (id) => apiFetch(`/matches/${encodeURIComponent(id)}/prediction`);

/** Is the offline (on-device) Android build active? */
export const OFFLINE_MODE = OFFLINE;

// --- Prediction calendar / track record (GET /api/predictions/*) ---------------
export const getCalendar = (month) =>
  apiFetch("/predictions/calendar", { month });
export const getPredictionHistory = (params = {}) =>
  apiFetch("/predictions/history", params);
// NOTE: named getPredictionSnapshot because getPrediction() already maps to
// GET /matches/:id/prediction. This one maps to GET /api/predictions/:id.
export const getPredictionSnapshot = (id) =>
  apiFetch(`/predictions/${encodeURIComponent(id)}`);
export const getPredictionStats = (params = {}) =>
  apiFetch("/predictions/stats", params);

// --- Live tracking ------------------------------------------------------------
export const getLive = () => apiFetch("/live");
export const getLiveMatch = (fixtureId) =>
  apiFetch(`/live/${encodeURIComponent(fixtureId)}`);
export const getLiveHistory = (fixtureId) =>
  apiFetch(`/live/${encodeURIComponent(fixtureId)}/history`);

// --- SportyBet fixture browser (informational, online only) -------------------
export const getSportybetEvents = (params = {}) =>
  apiFetch("/sportybet/events", params);
export const getSportybetTournaments = () =>
  apiFetch("/sportybet/tournaments");
