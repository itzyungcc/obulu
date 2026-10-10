import { Link } from "react-router-dom";

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

export default function PredictionCard({
  prediction,
  homeName,
  awayName,
  calendarDate,
}) {
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

      {prediction.markets && (
        <div className="markets-block">
          <h3>Goals markets</h3>
          {prediction.recommendedMarket && (
            <p className="muted">
              Recommended: <strong>{prediction.recommendedMarket.label}</strong> (
              {Math.round(prediction.recommendedMarket.probability)}%)
            </p>
          )}
          <div className="outcome-bars">
            {[
              ["Over 1.5", prediction.markets.over15],
              ["Over 2.5", prediction.markets.over25],
              ["Over 3.5", prediction.markets.over35],
              ["Under 2.5", prediction.markets.under25],
              ["BTTS", prediction.markets.bttsYes],
              ["Home or Over 2.5", prediction.markets.homeOrOver25],
              ["Away or Over 2.5", prediction.markets.awayOrOver25],
            ]
              .filter(([, v]) => Number.isFinite(v))
              .map(([label, value]) => {
                const isRec =
                  prediction.recommendedMarket &&
                  prediction.recommendedMarket.label === label;
                return (
                  <div key={label} className={`outcome${isRec ? " predicted" : ""}`}>
                    <div className="outcome-row">
                      <span className="outcome-label">
                        {label}
                        {isRec && <span className="badge badge-predicted">pick</span>}
                      </span>
                      <span className="outcome-pct">{Math.round(value)}%</span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${clamp(value)}%` }} />
                    </div>
                  </div>
                );
              })}
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

      {calendarDate && (
        <p className="calendar-note">
          Recorded in the{" "}
          <Link to={`/calendar?date=${calendarDate}`}>Prediction Calendar</Link>
        </p>
      )}
    </section>
  );
}

export { DISCLAIMER, toPct, clamp };
