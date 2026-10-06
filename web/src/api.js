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

export async function apiFetch(path, params = {}) {
  if (OFFLINE) return localApiFetch(path, params);
  const entries = Object.entries(params).filter(
    ([, v]) => v !== "" && v !== null && v !== undefined
  );
  const qs = new URLSearchParams(entries).toString();
  const url = `${API_BASE}/api${path}${qs ? `?${qs}` : ""}`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Could not reach the OBULU API. Check your connection and that the server is running, then try again."
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error || "REQUEST_FAILED",
      body?.message || `Request failed (HTTP ${res.status}).`
    );
  }
  return body ?? {};
}

export const getHealth = () => apiFetch("/health");
export const getLeagues = () => apiFetch("/leagues");
export const getUpcoming = (filters = {}) => apiFetch("/fixtures/upcoming", filters);
export const getAllFixtures = (filters = {}) => apiFetch("/fixtures/all", filters);
export const searchTeams = (q) => apiFetch("/teams/search", { q });
export const getMatch = (id) => apiFetch(`/matches/${encodeURIComponent(id)}`);
export const getAnalysis = (id) => apiFetch(`/matches/${encodeURIComponent(id)}/analysis`);
export const getPrediction = (id) => apiFetch(`/matches/${encodeURIComponent(id)}/prediction`);
