import { useEffect, useState } from "react";
import {
  apiFetch,
  OFFLINE_MODE,
  getSportybetEvents,
  getSportybetTournaments,
} from "../api.js";

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function parseLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+(?:vs\.?|v\.?)\s+|\s+[-–—]\s+/i);
      if (parts.length !== 2) return { raw: line, home: "", away: "" };
      return { raw: line, home: parts[0].trim(), away: parts[1].trim() };
    })
    .filter((g) => g.home && g.away);
}

const PICK_LABEL = { 1: "HOME WIN", X: "DRAW", 2: "AWAY WIN" };

function fmtOdds(odds) {
  if (!odds) return null;
  const h = odds.home ?? odds["1"];
  const d = odds.draw ?? odds.X;
  const a = odds.away ?? odds["2"];
  if (h == null) return null;
  return `1 ${h} · X ${d ?? "—"} · 2 ${a ?? "—"}`;
}

function GameCard({ r, index }) {
  if (!r.matched) {
    return (
      <article className="auto-card">
        <div className="auto-card-head">
          <span className="auto-num">{index + 1}</span>
          <div>
            <div className="auto-match">
              {r.home} <span className="vs">vs</span> {r.away}
            </div>
            <div className="auto-sub warn">Not matched — {r.reason}</div>
          </div>
        </div>
      </article>
    );
  }
  const pr = r.probabilities || {};
  return (
    <article className="auto-card">
      <div className="auto-card-head">
        <span className="auto-num">{index + 1}</span>
        <div>
          <div className="auto-match">
            {r.home} <span className="vs">vs</span> {r.away}
          </div>
          <div className="auto-sub">
            {r.league || ""} · {fmtDateTime(r.kickoff)}
          </div>
        </div>
        <span className={`pick-badge pick-${r.pick}`}>{r.pick}</span>
      </div>
      <div className="prob-row">
        <div className="prob">
          <span className="prob-label">1</span>
          <div className="prob-bar">
            <div className="prob-fill" style={{ width: `${pr.home || 0}%` }} />
          </div>
          <span className="prob-val">{pr.home ?? "—"}%</span>
        </div>
        <div className="prob">
          <span className="prob-label">X</span>
          <div className="prob-bar">
            <div className="prob-fill" style={{ width: `${pr.draw || 0}%` }} />
          </div>
          <span className="prob-val">{pr.draw ?? "—"}%</span>
        </div>
        <div className="prob">
          <span className="prob-label">2</span>
          <div className="prob-bar">
            <div className="prob-fill" style={{ width: `${pr.away || 0}%` }} />
          </div>
          <span className="prob-val">{pr.away ?? "—"}%</span>
        </div>
      </div>
      <div className="auto-sub">
        OBULU pick: <strong>{PICK_LABEL[r.pick] || r.pick}</strong>
        {" · "}confidence {r.confidence}%
        {r.confidenceLabel ? ` (${r.confidenceLabel})` : ""}
        {r.oddsUsed && <span className="odds-aware">odds-aware</span>}
        {r.expectedGoals?.home != null && (
          <> · xG {Number(r.expectedGoals.home).toFixed(2)}–{Number(r.expectedGoals.away).toFixed(2)}</>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// SportyBet event browser (online only; hidden entirely in OFFLINE_MODE).
// Browses upcoming SportyBet fixtures — informational fixture/odds data used
// to calibrate the statistical model. No betting language anywhere.
// ---------------------------------------------------------------------------

function normTournament(t) {
  if (typeof t === "string") return { id: t, name: t };
  return { id: t.id ?? t.name, name: t.name ?? t.id };
}

function SportybetBrowser({ loading, setLoading, setError, setResults }) {
  const [query, setQuery] = useState("");
  const [tournament, setTournament] = useState("");
  const [page, setPage] = useState(1);
  const [tournaments, setTournaments] = useState([]);
  const [data, setData] = useState(null);
  const [sbLoading, setSbLoading] = useState(true);
  const [sbError, setSbError] = useState("");
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    let cancelled = false;
    getSportybetTournaments()
      .then((d) => {
        if (!cancelled) setTournaments(Array.isArray(d.tournaments) ? d.tournaments : []);
      })
      .catch(() => {
        if (!cancelled) setTournaments([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setSbLoading(true);
      try {
        const d = await getSportybetEvents({
          q: query,
          tournament,
          page,
          limit: 20,
        });
        if (!cancelled) {
          setData(d);
          setSbError("");
        }
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setSbError(e.message || "Could not load SportyBet events.");
        }
      } finally {
        if (!cancelled) setSbLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, tournament, page]);

  function toggle(ev) {
    setSelected((prev) =>
      prev.some((s) => s.eventId === ev.eventId)
        ? prev.filter((s) => s.eventId !== ev.eventId)
        : [...prev, ev]
    );
  }

  async function analyzeSelected() {
    if (selected.length === 0 || loading) return;
    setLoading(true);
    setError("");
    setResults(null);
    try {
      const data = await apiFetch("/jackpot/analyze", {
        method: "POST",
        body: JSON.stringify({ eventIds: selected.map((e) => e.eventId) }),
      });
      setResults(data);
    } catch (e) {
      setError(e.message || "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  const events = data?.events || [];
  const totalPages = data?.totalPages || 1;

  return (
    <section className="sb-browser">
      <h2>Browse SportyBet fixtures</h2>
      <p className="muted">
        Browse upcoming SportyBet fixtures — informational fixture and odds
        data used to calibrate the statistical model. Select games, then run
        OBULU's full model on them.
      </p>

      <div className="sb-filters">
        <input
          type="text"
          placeholder="Search teams…"
          aria-label="Search SportyBet events"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Filter by tournament"
          value={tournament}
          onChange={(e) => {
            setTournament(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All tournaments</option>
          {tournaments.map((t) => {
            const { id, name } = normTournament(t);
            return (
              <option key={String(id)} value={String(id)}>
                {name}
              </option>
            );
          })}
        </select>
      </div>

      {sbError && (
        <div className="error-box">
          SportyBet events unavailable right now — paste the games below
          instead.
          <div className="muted small">{sbError}</div>
        </div>
      )}

      {selected.length > 0 && (
        <div className="sb-chips">
          {selected.map((e) => (
            <span key={e.eventId} className="sb-chip">
              {e.homeTeam} vs {e.awayTeam}
              <button
                type="button"
                onClick={() => toggle(e)}
                aria-label={`Remove ${e.homeTeam} vs ${e.awayTeam}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {sbLoading && <p className="muted">Loading events…</p>}

      {!sbLoading && !sbError && events.length === 0 && (
        <p className="muted">No events found — try the paste box below.</p>
      )}

      {!sbLoading &&
        events.map((ev) => {
          const isSel = selected.some((s) => s.eventId === ev.eventId);
          const odds = fmtOdds(ev.odds);
          return (
            <button
              key={ev.eventId}
              type="button"
              className={`sb-row${isSel ? " selected" : ""}`}
              onClick={() => toggle(ev)}
              aria-pressed={isSel}
            >
              <span className="sb-check" aria-hidden="true">
                {isSel ? "✓" : ""}
              </span>
              <span className="sb-main">
                <span className="sb-match">
                  {ev.homeTeam} <span className="vs">vs</span> {ev.awayTeam}
                </span>
                <span className="sb-meta">
                  {ev.tournament || ""}
                  {ev.kickoff ? ` · ${fmtDateTime(ev.kickoff)}` : ""}
                </span>
                {odds && <span className="sb-odds">{odds}</span>}
              </span>
            </button>
          );
        })}

      {!sbLoading && !sbError && totalPages > 1 && (
        <div className="sb-pager">
          <button
            type="button"
            className="btn-small"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            ← Prev
          </button>
          <span className="muted small">
            Page {data?.page || page} of {totalPages}
            {data?.total != null ? ` · ${data.total} events` : ""}
          </span>
          <button
            type="button"
            className="btn-small"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages}
          >
            Next →
          </button>
        </div>
      )}

      {selected.length > 0 && (
        <div className="row">
          <button
            className="btn gold"
            onClick={analyzeSelected}
            disabled={loading || selected.length === 0}
          >
            {loading
              ? "Analyzing…"
              : `Analyze selected (${selected.length})`}
          </button>
        </div>
      )}

      <hr className="sb-divider" />
    </section>
  );
}

export default function Jackpot() {
  const [text, setText] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const games = parseLines(text);

  async function analyze() {
    if (games.length === 0) return;
    setLoading(true);
    setError("");
    setResults(null);
    try {
      const data = await apiFetch("/jackpot/analyze", {
        method: "POST",
        body: JSON.stringify({ games: games.map((g) => ({ home: g.home, away: g.away })) }),
      });
      setResults(data);
    } catch (e) {
      setError(e.message || "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <h1>Jackpot Analyzer</h1>
      <p className="muted">
        Paste the jackpot games below — one per line, e.g.{" "}
        <code>Liverpool vs Man City</code>. OBULU matches each to its fixture
        data and runs the full statistical model on every game.
      </p>

      {!OFFLINE_MODE && (
        <SportybetBrowser
          loading={loading}
          setLoading={setLoading}
          setError={setError}
          setResults={setResults}
        />
      )}

      <h2>Or paste the games</h2>
      <textarea
        className="jackpot-input"
        rows={8}
        placeholder={"Aston Villa vs Brentford\nIpswich Town vs Fulham\nLiverpool vs Man City"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button
          className="btn gold"
          onClick={analyze}
          disabled={loading || games.length === 0}
        >
          {loading ? "Analyzing…" : `Analyze ${games.length} game${games.length === 1 ? "" : "s"}`}
        </button>
        {games.length > 0 && (
          <span className="muted">{games.length} game{games.length === 1 ? "" : "s"} detected</span>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      {results && (
        <div className="jackpot-results">
          <h2>
            Results{" "}
            <span className="muted">
              ({results.matched}/{results.total} matched)
            </span>
          </h2>
          {results.results.map((r, i) => (
            <GameCard key={i} r={r} index={i} />
          ))}
          <p className="muted small">{results.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
