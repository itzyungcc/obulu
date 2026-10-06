import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getLive, OFFLINE_MODE } from "../api.js";
import LiveProbBars from "../components/LiveProbBars.jsx";
import Loading from "../components/Loading.jsx";
import { formatKickoff } from "../components/MatchCard.jsx";

const POLL_MS = 60000;

function LiveBadge() {
  return (
    <span className="live-badge" role="status" aria-label="Live now">
      <span className="live-dot" aria-hidden="true" />
      LIVE
    </span>
  );
}

function LiveCard({ item }) {
  const fixture = item.fixture || {};
  const home = fixture.home || {};
  const away = fixture.away || {};
  const score = item.score || {};
  const estimated = item.minuteSource === "estimated";
  const { time } = formatKickoff(fixture.kickoff);

  return (
    <article className="card live-card">
      <div className="live-card-head">
        <LiveBadge />
        <p className="match-league">
          {fixture.league?.name}
          {time ? ` · kickoff ${time}` : ""}
        </p>
      </div>
      <div className="live-score-row">
        <span className="team-badge">
          {home.logo ? (
            <img src={home.logo} alt={`${home.name} logo`} width="34" height="34" />
          ) : null}
          <span className="team-name">{home.name}</span>
        </span>
        <span
          className="live-score"
          aria-label={`Score ${score.home ?? 0} to ${score.away ?? 0}`}
        >
          {score.home ?? "–"} – {score.away ?? "–"}
        </span>
        <span className="team-badge">
          {away.logo ? (
            <img src={away.logo} alt={`${away.name} logo`} width="34" height="34" />
          ) : null}
          <span className="team-name">{away.name}</span>
        </span>
      </div>
      <p className="live-minute">
        <strong>{item.minute ?? "–"}'</strong>
        {estimated && <span className="est-tag"> (est.)</span>}
      </p>
      <LiveProbBars
        live={item.live}
        preMatch={item.preMatch}
        homeName={home.name}
        awayName={away.name}
      />
      <Link className="btn btn-primary live-link" to={`/match/${fixture.id}`}>
        Full analysis
      </Link>
    </article>
  );
}

export default function Live() {
  const [matches, setMatches] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getLive();
      setMatches(Array.isArray(data) ? data : data?.matches || []);
      setState("ready");
      setError(null);
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (OFFLINE_MODE) {
      setState("offline");
      return;
    }
    load();
    let timer = setInterval(load, POLL_MS);
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(timer);
        timer = null;
      } else {
        load();
        if (!timer) timer = setInterval(load, POLL_MS);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return (
    <div className="container page">
      <h1>Live matches</h1>
      <p className="muted">
        Probabilities refresh every minute while a match is in play.
      </p>

      {state === "offline" && (
        <div className="card empty-state">
          <p>
            <strong>Live tracking is available in the online version of OBULU.</strong>
          </p>
          <p className="muted">
            Connect to the internet and use the web version to follow matches live.
          </p>
        </div>
      )}
      {state === "loading" && <Loading label="Checking for live matches…" />}
      {state === "error" && (
        <div className="card error-card" role="alert">
          <h2>Live data temporarily unavailable.</h2>
          <p className="muted">
            {error?.message || "Something went wrong while loading live matches."}
          </p>
          <button className="btn btn-secondary" type="button" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {state === "ready" && matches.length === 0 && (
        <div className="card empty-state">
          <p>
            <strong>No live matches right now — check back during match hours.</strong>
          </p>
          <p className="muted">
            OBULU tracks matches from kickoff to full time with live probabilities.
          </p>
        </div>
      )}
      {state === "ready" && matches.length > 0 && (
        <div className="fixture-grid">
          {matches.map((m) => (
            <LiveCard key={m.fixture?.id ?? m.id ?? `${m.minute}`} item={m} />
          ))}
        </div>
      )}
    </div>
  );
}
