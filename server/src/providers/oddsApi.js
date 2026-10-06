// The Odds API — OPTIONAL provider used ONLY as a statistical blend input to
// the prediction model (market-implied probabilities). Values are never
// displayed as betting tips or recommendations anywhere in the API.
// Key via ODDS_API_KEY env only; never exposed to clients.
import config from "../config.js";

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

// Best-effort lookup of decimal h2h prices for a fixture.
// Returns { home, draw, away } or null when unavailable.
export async function getOdds(match) {
  if (!config.oddsApiKey) return null;
  try {
    const url =
      "https://api.the-odds-api.com/v4/sports/soccer/odds/?regions=uk,eu&markets=h2h&dateFormat=iso&apiKey=" +
      encodeURIComponent(config.oddsApiKey);
    const res = await fetch(url);
    if (!res.ok) return null;
    const events = await res.json();
    if (!Array.isArray(events)) return null;

    const hn = norm(match.home.name);
    const an = norm(match.away.name);
    const kick = Date.parse(match.kickoff);

    const ev = events.find((e) => {
      const t = Date.parse(e.commence_time);
      if (!Number.isFinite(t) || !Number.isFinite(kick)) return false;
      if (Math.abs(t - kick) > 6 * 3600 * 1000) return false;
      const eh = norm(e.home_team), ea = norm(e.away_team);
      return (eh.includes(hn) || hn.includes(eh)) && (ea.includes(an) || an.includes(ea));
    });
    const bookmakers = (ev && ev.bookmakers) || [];
    if (!bookmakers.length) return null;
    const market = (bookmakers[0].markets || []).find((m) => m.key === "h2h");
    const outcomes = (market && market.outcomes) || [];
    const price = (nm) => {
      const o = outcomes.find((x) => norm(x.name) === norm(nm));
      return o && Number.isFinite(+o.price) ? +o.price : null;
    };
    const draw = outcomes.find((x) => /draw/i.test(x.name));
    const home = price(ev.home_team);
    const away = price(ev.away_team);
    const drawP = draw && Number.isFinite(+draw.price) ? +draw.price : null;
    if (!home || !drawP || !away) return null;
    return { home, draw: drawP, away };
  } catch {
    return null;
  }
}
