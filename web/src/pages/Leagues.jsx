import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getLeagues } from "../api.js";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";
import SampleBadge from "../components/SampleBadge.jsx";

export default function Leagues() {
  const [leagues, setLeagues] = useState([]);
  const [sampleData, setSampleData] = useState(false);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  const load = async () => {
    setState("loading");
    setError(null);
    try {
      const r = await getLeagues();
      setLeagues(r.leagues || []);
      setSampleData(Boolean(r.sampleData));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="container page">
      <h1>Leagues</h1>
      {sampleData && <SampleBadge />}

      {state === "loading" && <Loading label="Loading leagues…" />}
      {state === "error" && <ErrorState error={error} onRetry={load} />}
      {state === "ready" && leagues.length === 0 && (
        <p className="card muted">No leagues available right now.</p>
      )}
      {state === "ready" && leagues.length > 0 && (
        <div className="league-grid">
          {leagues.map((l) => (
            <Link
              key={l.id}
              to={`/upcoming?league=${encodeURIComponent(l.id)}`}
              className="card league-card"
              aria-label={`${l.name}${l.country ? `, ${l.country}` : ""} — view fixtures`}
            >
              <span className="league-icon" aria-hidden="true">
                {l.logo ? (
                  <img src={l.logo} alt="" width="40" height="40" />
                ) : (
                  "🏆"
                )}
              </span>
              <strong className="league-name">{l.name}</strong>
              <span className="muted">
                {[l.country, l.season].filter(Boolean).join(" · ")}
              </span>
              <span className="league-cta">View fixtures →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
