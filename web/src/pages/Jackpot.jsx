import { useState } from "react";
import { apiFetch } from "../api.js";

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
        {" · "}confidence {r.confidence}%{r.confidenceLabel ? ` (${r.confidenceLabel})` : ""}
        {r.expectedGoals?.home != null && (
          <> · xG {Number(r.expectedGoals.home).toFixed(2)}–{Number(r.expectedGoals.away).toFixed(2)}</>
        )}
      </div>
    </article>
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
