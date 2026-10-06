import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getAllFixtures, getLeagues } from "../api.js";
import MatchCard from "../components/MatchCard.jsx";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";


export default function Upcoming() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [fixtures, setFixtures] = useState([]);
  const [leagues, setLeagues] = useState([]);
  const [season, setSeason] = useState("");
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  const [date, setDate] = useState(searchParams.get("date") || "");
  const [league, setLeague] = useState(searchParams.get("league") || "");
  const [team, setTeam] = useState(searchParams.get("team") || "");

  const load = useCallback(
    async (filters) => {
      setState("loading");
      setError(null);
      try {
        const [fx, lg] = await Promise.all([
          getAllFixtures(filters),
          getLeagues(),
        ]);
        setFixtures(fx.fixtures || []);
        setLeagues(lg.leagues || []);
        setSeason(fx.season || "");
        setState("ready");
      } catch (e) {
        setError(e);
        setState("error");
      }
    },
    []
  );

  // Initial load from URL params (deep links from Leagues/Home).
  useEffect(() => {
    load({
      date: searchParams.get("date") || "",
      league: searchParams.get("league") || "",
      team: searchParams.get("team") || "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = (ev) => {
    ev.preventDefault();
    const filters = { date, league, team: team.trim() };
    const params = new URLSearchParams();
    if (filters.date) params.set("date", filters.date);
    if (filters.league) params.set("league", filters.league);
    if (filters.team) params.set("team", filters.team);
    setSearchParams(params, { replace: true });
    load(filters);
  };

  const clearFilters = () => {
    setDate("");
    setLeague("");
    setTeam("");
    setSearchParams({}, { replace: true });
    load({});
  };

  return (
    <div className="container page">
      <h1>Fixtures</h1>
      {season && <p className="muted">Real {season} season data — browse by date, league or team.</p>}

      <form className="card filters" onSubmit={applyFilters} aria-label="Fixture filters">
        <div className="field">
          <label htmlFor="up-date">Date</label>
          <input
            id="up-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="up-league">League</label>
          <select
            id="up-league"
            value={league}
            onChange={(e) => setLeague(e.target.value)}
          >
            <option value="">All leagues</option>
            {leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.country ? ` (${l.country})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="up-team">Team</label>
          <input
            id="up-team"
            type="search"
            placeholder="Team name"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          />
        </div>
        <div className="filter-actions">
          <button className="btn btn-primary" type="submit">
            Apply
          </button>
          <button className="btn btn-ghost" type="button" onClick={clearFilters}>
            Clear
          </button>
        </div>
      </form>

      {state === "loading" && <Loading label="Loading fixtures…" />}
      {state === "error" && <ErrorState error={error} onRetry={() => load({ date, league, team: team.trim() })} />}
      {state === "ready" && fixtures.length === 0 && (
        <div className="card empty-state">
          <p>
            <strong>No fixtures found.</strong>
          </p>
          <p className="muted">
            Try a different date, league or team — or clear the filters.
          </p>
        </div>
      )}
      {state === "ready" && fixtures.length > 0 && (
        <div className="fixture-grid">
          {fixtures.map((f) => (
            <MatchCard key={f.id} fixture={f} />
          ))}
        </div>
      )}
    </div>
  );
}
