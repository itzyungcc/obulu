import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getMatch, getAnalysis, getPrediction } from "../api.js";
import PredictionCard from "../components/PredictionCard.jsx";
import FormChips from "../components/FormChips.jsx";
import StatBar from "../components/StatBar.jsx";
import Donut from "../components/Donut.jsx";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";
import SampleBadge from "../components/SampleBadge.jsx";
import { formatKickoff } from "../components/MatchCard.jsx";

const DISCLAIMER_VERBATIM =
  "Predictions are statistical estimates based on available data and are not guarantees of match results.";

function TeamName({ team }) {
  return (
    <span className="team-badge team-badge-lg">
      {team?.logo ? (
        <img src={team.logo} alt={`${team.name} logo`} width="44" height="44" />
      ) : null}
      <span className="team-name">{team?.name || "—"}</span>
    </span>
  );
}

function KeyValue({ k, v }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

export default function MatchAnalysis() {
  const { id } = useParams();
  const [match, setMatch] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [sampleData, setSampleData] = useState(false);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  const load = async () => {
    setState("loading");
    setError(null);
    try {
      const [m, a, p] = await Promise.all([
        getMatch(id),
        getAnalysis(id),
        getPrediction(id),
      ]);
      setMatch(m.match || null);
      setAnalysis(a || null);
      setPrediction(p?.prediction || null);
      setSampleData(Boolean(m.sampleData || a.sampleData || p.sampleData));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (state === "loading") {
    return (
      <div className="container page">
        <Loading label="Loading match analysis…" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="container page">
        <ErrorState error={error} onRetry={load} />
      </div>
    );
  }

  const home = match?.home || {};
  const away = match?.away || {};
  const league = match?.league || {};
  const kickoff = formatKickoff(match?.kickoff);
  const rf = analysis?.recentForm || {};
  const ha = analysis?.homeAway || {};
  const h2h = analysis?.headToHead || {};
  const standings = analysis?.standings || {};
  const injuries = analysis?.injuries || {};
  const streaks = analysis?.streaks || null;

  return (
    <div className="container page">
      {sampleData && <SampleBadge />}

      {/* Match header */}
      <header className="card match-header">
        <p className="match-league">
          {league?.name}
          {league?.country ? ` · ${league.country}` : ""}
          {league?.season ? ` · ${league.season}` : ""}
        </p>
        <div className="match-header-teams">
          <TeamName team={home} />
          <span className="match-vs match-vs-lg">vs</span>
          <TeamName team={away} />
        </div>
        <p className="match-kickoff">
          {kickoff.date}
          {kickoff.time ? (
            <>
              {" · kickoff "}
              <time dateTime={match?.kickoff}>{kickoff.time}</time>
            </>
          ) : null}
          {match?.venue ? ` · ${match.venue}` : ""}
          {match?.status ? ` · ${match.status}` : ""}
        </p>
      </header>

      <PredictionCard prediction={prediction} homeName={home.name} awayName={away.name} />

      <div className="two-col">
        {/* Recent form */}
        <section className="card" aria-labelledby="form-heading">
          <h2 id="form-heading">Recent form</h2>
          {["home", "away"].map((side) => {
            const f = rf[side] || {};
            const name = side === "home" ? home.name : away.name;
            return (
              <div key={side} className="form-side">
                <h3>{name || (side === "home" ? "Home" : "Away")}</h3>
                <FormChips results={f.results} />
                <div className="kv-list">
                  <KeyValue k="Played" v={f.played ?? "—"} />
                  <KeyValue k="Goals for" v={f.goalsFor ?? "—"} />
                  <KeyValue k="Goals against" v={f.goalsAgainst ?? "—"} />
                </div>
              </div>
            );
          })}
        </section>

        {/* Home vs away record */}
        <section className="card" aria-labelledby="record-heading">
          <h2 id="record-heading">Home vs away record</h2>
          {["home", "away"].map((side) => {
            const r = ha[side] || {};
            const name = side === "home" ? `${home.name} (home)` : `${away.name} (away)`;
            return (
              <div key={side} className="form-side">
                <h3>{name}</h3>
                <div className="kv-list">
                  <KeyValue k="Played" v={r.played ?? "—"} />
                  <KeyValue
                    k="W / D / L"
                    v={
                      r.wins != null
                        ? `${r.wins} / ${r.draws ?? 0} / ${r.losses ?? 0}`
                        : "—"
                    }
                  />
                  <KeyValue k="Goals for" v={r.goalsFor ?? "—"} />
                  <KeyValue k="Goals against" v={r.goalsAgainst ?? "—"} />
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {/* Goals */}
      <section className="card" aria-labelledby="goals-heading">
        <h2 id="goals-heading">Goals</h2>
        <StatBar
          label="Goals scored"
          homeValue={rf.home?.goalsFor}
          awayValue={rf.away?.goalsFor}
          homeLabel={home.name}
          awayLabel={away.name}
        />
        <StatBar
          label="Goals conceded"
          homeValue={rf.home?.goalsAgainst}
          awayValue={rf.away?.goalsAgainst}
          homeLabel={home.name}
          awayLabel={away.name}
        />
        <div className="goals-grid">
          {["home", "away"].map((side) => {
            const f = rf[side] || {};
            return (
              <div key={side} className="donut-wrap">
                <Donut scored={f.goalsFor} conceded={f.goalsAgainst} />
                <p className="muted">{side === "home" ? home.name : away.name}</p>
                <div className="kv-list">
                  <KeyValue k="Avg scored" v={f.avgFor ?? "—"} />
                  <KeyValue k="Avg conceded" v={f.avgAgainst ?? "—"} />
                  <KeyValue k="Clean sheets" v={f.cleanSheets ?? "—"} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Head-to-head */}
      <section className="card" aria-labelledby="h2h-heading">
        <h2 id="h2h-heading">Head-to-head</h2>
        <p>
          <strong>{h2h.played ?? 0}</strong> meetings · {home.name || "Home"} wins{" "}
          <strong>{h2h.homeWins ?? 0}</strong> · draws{" "}
          <strong>{h2h.draws ?? 0}</strong> · {away.name || "Away"} wins{" "}
          <strong>{h2h.awayWins ?? 0}</strong>
        </p>
        {Array.isArray(h2h.lastMeetings) && h2h.lastMeetings.length > 0 ? (
          <ul className="meetings">
            {h2h.lastMeetings.map((m2, i) => (
              <li key={i}>
                <span className="muted">{m2.date}</span>{" "}
                <span>
                  {m2.home} {m2.scoreH ?? "–"}–{m2.scoreA ?? "–"} {m2.away}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No previous meetings on record.</p>
        )}
      </section>

      <div className="two-col">
        {/* League position */}
        <section className="card" aria-labelledby="pos-heading">
          <h2 id="pos-heading">League position</h2>
          {["home", "away"].map((side) => {
            const s = standings[side] || {};
            return (
              <div key={side} className="form-side">
                <h3>{side === "home" ? home.name : away.name}</h3>
                <div className="kv-list">
                  <KeyValue k="Position" v={s.position ?? "—"} />
                  <KeyValue k="Played" v={s.played ?? "—"} />
                  <KeyValue k="Points" v={s.points ?? "—"} />
                </div>
              </div>
            );
          })}
        </section>

        {/* Streaks, if present */}
        {streaks && (streaks.home?.length || streaks.away?.length) ? (
          <section className="card" aria-labelledby="streaks-heading">
            <h2 id="streaks-heading">Streaks</h2>
            {["home", "away"].map((side) => (
              <div key={side} className="form-side">
                <h3>{side === "home" ? home.name : away.name}</h3>
                <ul className="factors">
                  {(streaks[side] || []).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      {/* Injuries, if present */}
      {((injuries.home || []).length > 0 || (injuries.away || []).length > 0) && (
        <section className="card" aria-labelledby="injuries-heading">
          <h2 id="injuries-heading">Unavailable players</h2>
          {["home", "away"].map((side) => (
            <div key={side} className="form-side">
              <h3>{side === "home" ? home.name : away.name}</h3>
              {(injuries[side] || []).length > 0 ? (
                <ul className="factors">
                  {(injuries[side] || []).map((p, i) => (
                    <li key={i}>{typeof p === "string" ? p : p.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None reported.</p>
              )}
            </div>
          ))}
        </section>
      )}

      <p className="disclaimer disclaimer-block">{DISCLAIMER_VERBATIM}</p>
    </div>
  );
}
