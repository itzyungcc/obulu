/**
 * Side-by-side PRE-MATCH vs LIVE probability bars with movement arrows.
 * Shared by the Live page and the MatchAnalysis live panel.
 */
import { toPct, clamp } from "./PredictionCard.jsx";

const OUTCOMES = [
  { key: "HOME", label: "Home win" },
  { key: "DRAW", label: "Draw" },
  { key: "AWAY", label: "Away win" },
];

function Movement({ delta }) {
  const d = Math.round(delta);
  if (d >= 1) {
    return (
      <span className="move move-up" aria-label={`up ${d} points from pre-match`}>
        <span aria-hidden="true">↑</span>
      </span>
    );
  }
  if (d <= -1) {
    return (
      <span className="move move-down" aria-label={`down ${Math.abs(d)} points from pre-match`}>
        <span aria-hidden="true">↓</span>
      </span>
    );
  }
  return (
    <span className="move move-flat" aria-label="unchanged from pre-match">
      <span aria-hidden="true">–</span>
    </span>
  );
}

function ProbBar({ label, value, pair }) {
  const pct = clamp(value);
  return (
    <div className="prob-pair-row">
      <span className="prob-pair-label">{label}</span>
      <div
        className="bar-track"
        role="img"
        aria-label={`${pair} ${label}: ${Math.round(pct)} percent`}
      >
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="outcome-pct">{Math.round(pct)}%</span>
    </div>
  );
}

export default function LiveProbBars({ live, preMatch, homeName, awayName }) {
  const liveProbs = live || {};
  const preProbs = preMatch || {};
  const livePredicted = liveProbs.predictedOutcome;
  const conf = liveProbs.confidence || {};

  return (
    <div className="prob-pairs">
      {OUTCOMES.map((o) => {
        const name = o.key === "HOME" ? homeName : o.key === "AWAY" ? awayName : null;
        const label = name || o.label;
        const liveV = toPct(liveProbs[o.key === "HOME" ? "homeWin" : o.key === "DRAW" ? "draw" : "awayWin"]);
        const preV = toPct(preProbs[o.key === "HOME" ? "homeWin" : o.key === "DRAW" ? "draw" : "awayWin"]);
        const isPredicted = livePredicted === o.key;
        return (
          <div key={o.key} className={`prob-pair${isPredicted ? " predicted" : ""}`}>
            <div className="prob-pair-head">
              <span className="prob-pair-name">
                {label}
                {isPredicted && (
                  <span className="badge badge-predicted">predicted</span>
                )}
              </span>
              <Movement delta={liveV - preV} />
            </div>
            <ProbBar label="Pre-match" value={preV} pair="Pre-match" />
            <ProbBar label="Live" value={liveV} pair="Live" />
          </div>
        );
      })}
      {conf.label && (
        <p className="live-conf">
          Model confidence: <strong>{conf.label}</strong>
        </p>
      )}
    </div>
  );
}
