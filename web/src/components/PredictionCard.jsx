const DISCLAIMER =
  "Predictions are statistical estimates based on available data and are not guarantees of match results.";

// Backend may send probabilities as 0–1 or 0–100; normalise defensively.
function toPct(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return n > 1 ? n : n * 100;
}
function clamp(v) {
  return Math.min(100, Math.max(0, v));
}

export default function PredictionCard({ prediction, homeName, awayName }) {
  if (!prediction) return null;

  const outcomes = [
    { key: "HOME", label: homeName || "Home", value: toPct(prediction.homeWin) },
    { key: "DRAW", label: "Draw", value: toPct(prediction.draw) },
    { key: "AWAY", label: awayName || "Away", value: toPct(prediction.awayWin) },
  ];
  const conf = prediction.confidence || {};
  const confPct = conf.score != null ? clamp(toPct(conf.score)) : null;

  return (
    <section className="card prediction-card" aria-labelledby="prediction-heading">
      <h2 id="prediction-heading">Match prediction</h2>
      <div className="outcome-bars">
        {outcomes.map((o) => (
          <div
            key={o.key}
            className={`outcome${prediction.predictedOutcome === o.key ? " predicted" : ""}`}
          >
            <div className="outcome-row">
              <span className="outcome-label">
                {o.label}
                {prediction.predictedOutcome === o.key && (
                  <span className="badge badge-predicted">predicted</span>
                )}
              </span>
              <span className="outcome-pct">{Math.round(o.value)}%</span>
            </div>
            <div
              className="bar-track"
              role="img"
              aria-label={`${o.label}: ${Math.round(o.value)} percent`}
            >
              <div className="bar-fill" style={{ width: `${clamp(o.value)}%` }} />
            </div>
          </div>
        ))}
      </div>

      {confPct !== null && (
        <div className="confidence">
          <div className="conf-row">
            <span>Model confidence</span>
            <span>
              <strong>{conf.label || "—"}</strong>
            </span>
          </div>
          <div
            className="conf-meter"
            role="img"
            aria-label={`Confidence ${conf.label || ""}: ${Math.round(confPct)} percent`}
          >
            <div className="conf-fill" style={{ width: `${confPct}%` }} />
          </div>
        </div>
      )}

      {Array.isArray(prediction.factors) && prediction.factors.length > 0 && (
        <div className="factors-block">
          <h3>Why this prediction</h3>
          <ul className="factors">
            {prediction.factors.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="disclaimer">{DISCLAIMER}</p>
    </section>
  );
}

export { DISCLAIMER };
