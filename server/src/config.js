// Central configuration — everything comes from environment variables.
function bool(v, d = false) {
  if (v == null) return d;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function floatInRange(v, dflt, min, max) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const config = {
  port: parseInt(process.env.PORT || "3001", 10) || 3001,
  apiFootballKey: process.env.API_FOOTBALL_KEY || "",
  footballDataOrgKey: process.env.FOOTBALL_DATA_ORG_KEY || "",
  oddsApiKey: process.env.ODDS_API_KEY || "",
  sampleData: bool(process.env.SAMPLE_DATA, false),
  dbPath: process.env.DB_PATH || "./data/obulu.db",
  modelOddsWeight: floatInRange(process.env.MODEL_ODDS_WEIGHT, 0.75, 0, 1),
};

export default config;

// API-Football seasons run Aug->May; pick the season that contains "now".
export function currentSeason() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

export function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
