import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getAllFixtures, getLeagues } from "../api.js";
import MatchCard from "../components/MatchCard.jsx";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";
import SampleBadge from "../components/SampleBadge.jsx";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function Home() {
  const [fixtures, setFixtures] = useState([]);
  const [leagues, setLeagues] = useState([]);
  const [sampleData, setSampleData] = useState(false);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  const [q, setQ] = useState("");
  const [date, setDate] = useState("");
  const [league, setLeague] = useState("");
  const navigate = useNavigate();

  const load = async () => {
    setState("loading");
    setError(null);
    try {
      const [fx, lg] = await Promise.all([getAllFixtures(), getLeagues()]);
      setFixtures(fx.fixtures || []);
      setLeagues(lg.leagues || []);
      setSampleData(Boolean(fx.sampleData || lg.sampleData));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const goSearch = (ev) => {
    ev.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  const goUpcoming = (ev) => {
    ev.preventDefault();
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (league) params.set("league", league);
    navigate(`/upcoming${params.toString() ? `?${params.toString()}` : ""}`);
  };

  return (
    <div className="container page">
      {sampleData && <SampleBadge />}

      <section className="hero card">
        <p className="hero-mark" aria-hidden="true">
          🌹
        </p>
        <h1>OBULU</h1>
        <p className="hero-sub">Football Comparison &amp; Prediction</p>
        <p className="hero-tag">
          Compare teams, explore recent form, head-to-head records and league
          positions, and view statistical match predictions — informational
          only, never betting.
        </p>

        <form className="hero-search" onSubmit={goSearch} role="search">
          <label className="visually-hidden" htmlFor="home-search">
            Search teams or matches
          </label>
          <input
            id="home-search"
            type="search"
            placeholder="Search a team — e.g. Arsenal"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Search
          </button>
        </form>

        <form className="hero-filters" onSubmit={goUpcoming}>
          <div className="field">
            <label htmlFor="home-date">Match date</label>
            <input
              id="home-date"
              type="date"
              value={date}
              min={todayISO()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="home-league">League</label>
            <select
              id="home-league"
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
          <button className="btn btn-secondary" type="submit">
            View fixtures
          </button>
        </form>
      </section>

      <section aria-labelledby="featured-heading">
        <div className="section-head">
          <h2 id="featured-heading">Featured fixtures</h2>
          <Link to="/upcoming" className="btn btn-ghost">
            See all
          </Link>
        </div>
        {state === "loading" && <Loading label="Loading fixtures…" />}
        {state === "error" && <ErrorState error={error} onRetry={load} />}
        {state === "ready" && fixtures.length === 0 && (
          <p className="card muted">No fixtures available right now.</p>
        )}
        {state === "ready" && fixtures.length > 0 && (
          <div className="fixture-grid">
            {fixtures.slice(0, 4).map((f) => (
              <MatchCard key={f.id} fixture={f} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="quick-heading">
        <h2 id="quick-heading">Explore OBULU</h2>
        <div className="quick-grid">
          <Link to="/upcoming" className="card quick-card">
            <span className="quick-icon" aria-hidden="true">
              📅
            </span>
            <strong>Fixtures</strong>
            <span>Browse fixtures by date, league or team.</span>
          </Link>
          <Link to="/search" className="card quick-card">
            <span className="quick-icon" aria-hidden="true">
              ⚖️
            </span>
            <strong>Compare teams</strong>
            <span>Pick two sides and compare them head to head.</span>
          </Link>
          <Link to="/leagues" className="card quick-card">
            <span className="quick-icon" aria-hidden="true">
              🏆
            </span>
            <strong>Leagues</strong>
            <span>Pick a competition and see its fixtures.</span>
          </Link>
          <Link to="/about" className="card quick-card">
            <span className="quick-icon" aria-hidden="true">
              ℹ️
            </span>
            <strong>About OBULU</strong>
            <span>How the statistical model works.</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
