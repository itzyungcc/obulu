import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { searchTeams, getAllFixtures } from "../api.js";
import MatchCard from "../components/MatchCard.jsx";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";
import SampleBadge from "../components/SampleBadge.jsx";

/**
 * Team search + head-to-head comparison.
 *
 * Flow: search for teams -> assign as Team A / Team B (or type "X vs Y") ->
 * if both have an upcoming fixture against each other, link to its analysis;
 * otherwise show each team's next fixture.
 */

export default function Search() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState("idle");
  const [searchError, setSearchError] = useState(null);
  const [sampleData, setSampleData] = useState(false);

  const [teamA, setTeamA] = useState(null);
  const [teamB, setTeamB] = useState(null);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState("");

  const [compareState, setCompareState] = useState("idle");
  const [compareError, setCompareError] = useState(null);
  const [compareResult, setCompareResult] = useState(null);

  const runSearch = async (term) => {
    const t = (term || "").trim();
    if (!t) return;
    setSearchState("loading");
    setSearchError(null);
    try {
      const r = await searchTeams(t);
      setResults(r.teams || []);
      setSampleData((s) => s || Boolean(r.sampleData));
      setSearchState("ready");
    } catch (e) {
      setSearchError(e);
      setSearchState("error");
    }
  };

  useEffect(() => {
    const initial = params.get("q");
    if (initial) runSearch(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitSearch = (ev) => {
    ev.preventDefault();
    const t = q.trim();
    if (!t) return;
    setParams({ q: t }, { replace: true });
    runSearch(t);
  };

  const pickTeam = (team, slot) => {
    if (slot === "A") setTeamA(team);
    else setTeamB(team);
    setCompareResult(null);
    setCompareState("idle");
  };

  const swapTeams = () => {
    setTeamA(teamB);
    setTeamB(teamA);
    setCompareResult(null);
    setCompareState("idle");
  };

  // Resolve each side of a "Team X vs Team Y" string against the API.
  const resolveManual = async (ev) => {
    ev.preventDefault();
    setManualError("");
    const parts = manual.split(/\s+vs\.?\s+|\s+v\s+/i).map((s) => s.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setManualError('Type two team names separated by "vs" — e.g. "Arsenal vs Chelsea".');
      return;
    }
    setCompareState("loading");
    setCompareError(null);
    try {
      const [ra, rb] = await Promise.all([searchTeams(parts[0]), searchTeams(parts[1])]);
      setSampleData((s) => s || Boolean(ra.sampleData || rb.sampleData));
      const a = bestMatch(ra.teams || [], parts[0]);
      const b = bestMatch(rb.teams || [], parts[1]);
      if (!a || !b) {
        setCompareState("idle");
        setManualError(
          `Couldn't resolve ${!a ? `"${parts[0]}"` : ""}${!a && !b ? " and " : ""}${!b ? `"${parts[1]}"` : ""} — try the pickers above instead.`
        );
        return;
      }
      setTeamA(a);
      setTeamB(b);
      await compare(a, b);
    } catch (e) {
      setCompareError(e);
      setCompareState("error");
    }
  };

  function bestMatch(teams, query) {
    if (!teams.length) return null;
    const norm = (s) => s.toLowerCase().trim();
    return teams.find((t) => norm(t.name) === norm(query)) || teams[0];
  }

  const compare = async (a = teamA, b = teamB) => {
    if (!a || !b) return;
    setCompareState("loading");
    setCompareError(null);
    try {
      const [fa, fb] = await Promise.all([
        getAllFixtures({ team: a.id }),
        getAllFixtures({ team: b.id }),
      ]);
      setSampleData((s) => s || Boolean(fa.sampleData || fb.sampleData));
      const direct = [...(fa.fixtures || []), ...(fb.fixtures || [])].find(
        (f) =>
          (f.home.id === a.id && f.away.id === b.id) ||
          (f.home.id === b.id && f.away.id === a.id)
      );
      if (direct) {
        setCompareResult({ type: "headToHead", fixture: direct });
      } else {
        setCompareResult({
          type: "separate",
          aNext: (fa.fixtures || [])[0] || null,
          bNext: (fb.fixtures || [])[0] || null,
        });
      }
      setCompareState("ready");
    } catch (e) {
      setCompareError(e);
      setCompareState("error");
    }
  };

  return (
    <div className="container page">
      <h1>Search &amp; compare</h1>
      {sampleData && <SampleBadge />}

      <form className="card search-form" onSubmit={submitSearch} role="search">
        <label htmlFor="team-search">Search teams</label>
        <div className="search-row">
          <input
            id="team-search"
            type="search"
            placeholder="e.g. Arsenal"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Search
          </button>
        </div>
      </form>

      {searchState === "loading" && <Loading label="Searching teams…" />}
      {searchState === "error" && (
        <ErrorState error={searchError} onRetry={() => runSearch(q)} />
      )}
      {searchState === "ready" && results.length === 0 && (
        <p className="card muted">No teams found — try a different name.</p>
      )}
      {searchState === "ready" && results.length > 0 && (
        <ul className="team-results" aria-label="Team search results">
          {results.map((t) => (
            <li key={t.id} className="card team-result">
              <span className="team-badge">
                {t.logo ? (
                  <img src={t.logo} alt={`${t.name} logo`} width="24" height="24" />
                ) : null}
                <span className="team-name">{t.name}</span>
                {t.country ? <span className="muted"> · {t.country}</span> : null}
              </span>
              <span className="pick-buttons">
                <button
                  type="button"
                  className={`btn btn-ghost${teamA?.id === t.id ? " selected" : ""}`}
                  onClick={() => pickTeam(t, "A")}
                  aria-pressed={teamA?.id === t.id}
                >
                  Team A
                </button>
                <button
                  type="button"
                  className={`btn btn-ghost${teamB?.id === t.id ? " selected" : ""}`}
                  onClick={() => pickTeam(t, "B")}
                  aria-pressed={teamB?.id === t.id}
                >
                  Team B
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <section className="card compare-box" aria-labelledby="compare-heading">
        <h2 id="compare-heading">Compare two teams</h2>
        <div className="compare-pickers">
          <div className="compare-slot">
            <span className="compare-label">Team A</span>
            <strong>{teamA ? teamA.name : "—"}</strong>
            {teamA && (
              <button type="button" className="link-btn" onClick={() => pickTeam(null, "A")}>
                Clear
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={swapTeams}
            disabled={!teamA && !teamB}
            aria-label="Swap teams"
          >
            ⇄
          </button>
          <div className="compare-slot">
            <span className="compare-label">Team B</span>
            <strong>{teamB ? teamB.name : "—"}</strong>
            {teamB && (
              <button type="button" className="link-btn" onClick={() => pickTeam(null, "B")}>
                Clear
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!teamA || !teamB || compareState === "loading"}
          onClick={() => compare()}
        >
          Compare
        </button>

        <div className="manual-compare">
          <p className="muted">Or type it directly:</p>
          <form onSubmit={resolveManual} className="search-row">
            <label className="visually-hidden" htmlFor="manual-vs">
              Two team names separated by "vs"
            </label>
            <input
              id="manual-vs"
              type="text"
              placeholder="Arsenal vs Chelsea"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button className="btn btn-primary" type="submit">
              Resolve
            </button>
          </form>
          {manualError && (
            <p className="form-error" role="alert">
              {manualError}
            </p>
          )}
        </div>

        {compareState === "loading" && <Loading label="Comparing teams…" />}
        {compareState === "error" && (
          <ErrorState error={compareError} onRetry={() => compare()} />
        )}
        {compareState === "ready" && compareResult?.type === "headToHead" && (
          <div className="compare-direct">
            <p>
              <strong>{teamA.name}</strong> and <strong>{teamB.name}</strong> meet
              soon — view the full statistical analysis:
            </p>
            <MatchCard fixture={compareResult.fixture} />
          </div>
        )}
        {compareState === "ready" && compareResult?.type === "separate" && (
          <div className="compare-separate">
            <p className="muted">
              These teams don't play each other in the upcoming fixtures we have.
              Here is each team's next fixture:
            </p>
            <div className="fixture-grid">
              {compareResult.aNext ? (
                <MatchCard fixture={compareResult.aNext} />
              ) : (
                <p className="card muted">No upcoming fixture for {teamA.name}.</p>
              )}
              {compareResult.bNext ? (
                <MatchCard fixture={compareResult.bNext} />
              ) : (
                <p className="card muted">No upcoming fixture for {teamB.name}.</p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
