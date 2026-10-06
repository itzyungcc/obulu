import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getCalendar,
  getPredictionHistory,
  getPredictionSnapshot,
  getPredictionStats,
  OFFLINE_MODE,
} from "../api.js";
import { toPct } from "../components/PredictionCard.jsx";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";
import { formatKickoff } from "../components/MatchCard.jsx";

const PAGE_LIMIT = 20;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "CORRECT", label: "Correct" },
  { value: "INCORRECT", label: "Incorrect" },
  { value: "PENDING", label: "Pending" },
];
const OUTCOME_OPTIONS = [
  { value: "", label: "All" },
  { value: "HOME", label: "Home" },
  { value: "DRAW", label: "Draw" },
  { value: "AWAY", label: "Away" },
];

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function monthBounds(mk) {
  const [y, m] = mk.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  return { from: dayKey(first), to: dayKey(last) };
}
function monthLabel(mk) {
  const [y, m] = mk.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(new Date(y, m - 1, 1));
}
function dayAriaLabel(dateStr, info) {
  const d = new Date(`${dateStr}T12:00:00`);
  const short = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(d);
  return `${short}: ${info.correct} correct of ${info.total} predictions`;
}
function shiftMonth(mk, delta) {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

function StatusChip({ status }) {
  const s = (status || "PENDING").toUpperCase();
  const cls =
    s === "CORRECT"
      ? "chip-status chip-correct"
      : s === "INCORRECT"
      ? "chip-status chip-incorrect"
      : s === "VOID"
      ? "chip-status chip-void"
      : "chip-status chip-pending";
  return (
    <span className={cls} aria-label={`Prediction status: ${s.toLowerCase()}`}>
      {s}
    </span>
  );
}

function OutcomeTag({ outcome, homeName, awayName }) {
  const name =
    outcome === "HOME" ? homeName : outcome === "AWAY" ? awayName : "Draw";
  return (
    <span className="pick-tag">
      OBULU pick: <strong>{name || outcome}</strong>
    </span>
  );
}

function SnapshotCard({ item, onOpen }) {
  const conf = item.confidence_score;
  return (
    <article className="card snap-card">
      <button
        type="button"
        className="snap-open"
        onClick={() => onOpen(item.id)}
        aria-label={`Open prediction details: ${item.home_team} vs ${item.away_team}`}
      >
        <p className="match-league">{item.league}</p>
        <p className="snap-teams">
          {item.home_team} <span className="match-vs">vs</span> {item.away_team}
        </p>
        <OutcomeTag
          outcome={item.predicted_outcome}
          homeName={item.home_team}
          awayName={item.away_team}
        />
        <div className="snap-probs">
          {[
            { k: "home_win", l: "Home" },
            { k: "draw", l: "Draw" },
            { k: "away_win", l: "Away" },
          ].map((o) => (
            <span key={o.k} className="snap-prob">
              <span className="snap-prob-l">{o.l}</span>
              <strong>{Math.round(toPct(item[o.k]))}%</strong>
            </span>
          ))}
        </div>
        <div className="snap-foot">
          <span className="muted">
            Model confidence:{" "}
            <strong>{item.confidence_label || "—"}</strong>
            {conf != null ? ` (${Math.round(toPct(conf))})` : ""}
          </span>
          <StatusChip status={item.status} />
        </div>
      </button>
    </article>
  );
}

function SnapshotModal({ id, onClose }) {
  const [snap, setSnap] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setError(null);
    getPredictionSnapshot(id)
      .then((s) => {
        if (alive) {
          setSnap(s);
          setState("ready");
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e);
          setState("error");
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status = (snap?.status || "PENDING").toUpperCase();
  const resolved = status === "CORRECT" || status === "INCORRECT";
  const kickoff = snap ? formatKickoff(snap.kickoff) : null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Prediction details: ${snap?.home_team || ""} vs ${
          snap?.away_team || ""
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close prediction details"
        >
          ✕
        </button>
        {state === "loading" && <Loading label="Loading prediction…" />}
        {state === "error" && <ErrorState error={error} onRetry={onClose} />}
        {state === "ready" && snap && (
          <>
            <h2>
              {snap.home_team} <span className="match-vs">vs</span>{" "}
              {snap.away_team}
            </h2>
            <p className="muted">
              {snap.league}
              {snap.country ? ` · ${snap.country}` : ""}
              {kickoff ? ` · ${kickoff.date}` : ""}
            </p>
            <StatusChip status={status} />
            <div className="kv-list modal-kv">
              <div className="kv">
                <span className="kv-k">OBULU pick</span>
                <span className="kv-v">
                  {snap.predicted_outcome === "HOME"
                    ? snap.home_team
                    : snap.predicted_outcome === "AWAY"
                    ? snap.away_team
                    : "Draw"}
                </span>
              </div>
              <div className="kv">
                <span className="kv-k">Home win</span>
                <span className="kv-v">{Math.round(toPct(snap.home_win))}%</span>
              </div>
              <div className="kv">
                <span className="kv-k">Draw</span>
                <span className="kv-v">{Math.round(toPct(snap.draw))}%</span>
              </div>
              <div className="kv">
                <span className="kv-k">Away win</span>
                <span className="kv-v">{Math.round(toPct(snap.away_win))}%</span>
              </div>
              <div className="kv">
                <span className="kv-k">Model confidence</span>
                <span className="kv-v">
                  {snap.confidence_label || "—"}
                  {snap.confidence_score != null
                    ? ` (${Math.round(toPct(snap.confidence_score))})`
                    : ""}
                </span>
              </div>
              <div className="kv">
                <span className="kv-k">Expected goals (xG)</span>
                <span className="kv-v">
                  {snap.expected_home_goals ?? "—"} –{" "}
                  {snap.expected_away_goals ?? "—"}
                </span>
              </div>
              <div className="kv">
                <span className="kv-k">Model version</span>
                <span className="kv-v">{snap.model_version || "—"}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Blended with odds</span>
                <span className="kv-v">
                  {snap.blended_with_odds ? "Yes" : "No"}
                </span>
              </div>
            </div>

            {Array.isArray(snap.factors) && snap.factors.length > 0 && (
              <div className="factors-block">
                <h3>Why this prediction</h3>
                <ul className="factors">
                  {snap.factors.map((f, i) => (
                    <li key={i}>{typeof f === "string" ? f : f.text || JSON.stringify(f)}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="result-section">
              <h3>Result</h3>
              {resolved ? (
                <p>
                  Final score:{" "}
                  <strong>
                    {snap.actual_home_score ?? "–"} – {snap.actual_away_score ?? "–"}
                  </strong>{" "}
                  <StatusChip status={status} />
                </p>
              ) : (
                <p>
                  <StatusChip status={status} />{" "}
                  <span className="muted">
                    — result not recorded yet.
                  </span>
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Calendar() {
  const [searchParams] = useSearchParams();
  const initialDate = searchParams.get("date");
  const [month, setMonth] = useState(() => {
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate))
      return initialDate.slice(0, 7);
    return monthKey(new Date());
  });
  const [selectedDay, setSelectedDay] = useState(() =>
    initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : ""
  );

  const [days, setDays] = useState({});
  const [calState, setCalState] = useState("loading");

  const [stats, setStats] = useState(null);
  const [statsState, setStatsState] = useState("loading");

  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [histState, setHistState] = useState("loading");
  const [histError, setHistError] = useState(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [leagueFilter, setLeagueFilter] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [leagueOptions, setLeagueOptions] = useState([]);
  const [detailId, setDetailId] = useState(null);

  const bounds = useMemo(() => monthBounds(month), [month]);
  const from = fromInput || bounds.from;
  const to = toInput || bounds.to;

  const loadCalendar = useCallback(async (mk) => {
    setCalState("loading");
    try {
      const data = await getCalendar(mk);
      setDays(data?.days || {});
      setCalState("ready");
    } catch {
      setDays({});
      setCalState("error");
    }
  }, []);

  const loadStats = useCallback(async (params) => {
    setStatsState("loading");
    try {
      const data = await getPredictionStats(params);
      setStats(data);
      setStatsState("ready");
    } catch {
      setStatsState("error");
    }
  }, []);

  const loadHistory = useCallback(
    async ({ pageNum, append }) => {
      setHistState("loading");
      setHistError(null);
      try {
        const params = {
          status: statusFilter || undefined,
          outcome: outcomeFilter || undefined,
          league: leagueFilter || undefined,
          page: pageNum,
          limit: PAGE_LIMIT,
        };
        if (selectedDay) params.date = selectedDay;
        else {
          params.from = from;
          params.to = to;
        }
        const data = await getPredictionHistory(params);
        const newItems = data?.items || [];
        setItems((prev) => (append ? [...prev, ...newItems] : newItems));
        setPage(data?.page || pageNum);
        setTotal(data?.total ?? 0);
        setLeagueOptions((prev) => {
          const names = new Set(prev);
          for (const it of newItems) if (it.league) names.add(it.league);
          return [...names].sort();
        });
        setHistState("ready");
      } catch (e) {
        setHistError(e);
        setHistState("error");
      }
    },
    [statusFilter, outcomeFilter, leagueFilter, selectedDay, from, to]
  );

  // Initial + offline handling
  useEffect(() => {
    if (OFFLINE_MODE) {
      setCalState("offline");
      setStatsState("offline");
      setHistState("offline");
      return;
    }
    loadCalendar(month);
    loadStats({ from: bounds.from, to: bounds.to });
    loadHistory({ pageNum: 1, append: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeMonth = (delta) => {
    const mk = shiftMonth(month, delta);
    setMonth(mk);
    setSelectedDay("");
    setItems([]);
    setLeagueOptions([]);
    loadCalendar(mk);
    const b = monthBounds(mk);
    loadStats({ from: b.from, to: b.to, league: leagueFilter || undefined, outcome: outcomeFilter || undefined });
    setPage(1);
    loadHistoryReset(mk, "", b);
  };

  const loadHistoryReset = (mk, day, b) => {
    // helper to reload history page 1 after month/day change
    setHistState("loading");
    setHistError(null);
    const params = {
      status: statusFilter || undefined,
      outcome: outcomeFilter || undefined,
      league: leagueFilter || undefined,
      page: 1,
      limit: PAGE_LIMIT,
    };
    if (day) params.date = day;
    else {
      params.from = fromInput || b.from;
      params.to = toInput || b.to;
    }
    getPredictionHistory(params)
      .then((data) => {
        const newItems = data?.items || [];
        setItems(newItems);
        setPage(data?.page || 1);
        setTotal(data?.total ?? 0);
        setLeagueOptions((prev) => {
          const names = new Set(prev);
          for (const it of newItems) if (it.league) names.add(it.league);
          return [...names].sort();
        });
        setHistState("ready");
      })
      .catch((e) => {
        setHistError(e);
        setHistState("error");
      });
  };

  const selectDay = (dateStr) => {
    setSelectedDay(dateStr);
    setItems([]);
    loadHistoryReset(month, dateStr, bounds);
  };

  const clearDay = () => {
    setSelectedDay("");
    setItems([]);
    loadHistoryReset(month, "", bounds);
  };

  const applyFilters = (ev) => {
    ev?.preventDefault();
    loadStats({
      from,
      to,
      league: leagueFilter || undefined,
      outcome: outcomeFilter || undefined,
    });
    loadHistoryReset(month, selectedDay, bounds);
  };

  const clearFilters = () => {
    setStatusFilter("");
    setOutcomeFilter("");
    setLeagueFilter("");
    setFromInput("");
    setToInput("");
  };

  // Re-run when filters change (except date-range text inputs, applied on submit).
  useEffect(() => {
    if (OFFLINE_MODE || calState === "loading") return;
    loadStats({ from, to, league: leagueFilter || undefined, outcome: outcomeFilter || undefined });
    loadHistory({ pageNum: 1, append: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, outcomeFilter, leagueFilter]);

  // Grid cells for the month.
  const cells = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const firstDow = new Date(y, m - 1, 1).getDay(); // 0=Sun
    const lead = (firstDow + 6) % 7; // Monday-first offset
    const dim = new Date(y, m, 0).getDate();
    const arr = [];
    for (let i = 0; i < lead; i++) arr.push(null);
    for (let d = 1; d <= dim; d++) {
      const dk = `${month}-${String(d).padStart(2, "0")}`;
      arr.push({ day: d, key: dk, info: days[dk] || null });
    }
    return arr;
  }, [month, days]);

  const accuracyPct = stats?.accuracy != null ? toPct(stats.accuracy) : null;
  const byOutcome = stats?.byOutcome || {};

  return (
    <div className="container page">
      <h1>Prediction Calendar</h1>

      {(calState === "offline" || statsState === "offline" || histState === "offline") && (
        <div className="card empty-state">
          <p>
            <strong>
              The prediction calendar is available in the online version of
              OBULU.
            </strong>
          </p>
          <p className="muted">
            Connect to the internet and use the web version to see the track
            record.
          </p>
        </div>
      )}

      {!OFFLINE_MODE && (
        <>
          {/* ---- Track record stats ---- */}
          <section className="card" aria-labelledby="track-heading">
            <h2 id="track-heading">OBULU Track Record</h2>
            {statsState === "loading" && <Loading label="Loading track record…" />}
            {statsState === "error" && (
              <p className="muted">Track record stats are unavailable right now.</p>
            )}
            {statsState === "ready" && stats && (
              <>
                <div className="stats-row">
                  <div className="stat-box">
                    <span className="stat-num">{stats.total ?? 0}</span>
                    <span className="stat-cap">predictions</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-num stat-good">{stats.correct ?? 0}</span>
                    <span className="stat-cap">correct</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-num stat-bad">{stats.incorrect ?? 0}</span>
                    <span className="stat-cap">incorrect</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-num">
                      {accuracyPct != null ? `${Math.round(accuracyPct)}%` : "—"}
                    </span>
                    <span className="stat-cap">accuracy</span>
                  </div>
                </div>
                {accuracyPct == null && (
                  <p className="muted" role="note">
                    Not enough resolved predictions yet.
                  </p>
                )}
                <div className="outcome-splits">
                  {["HOME", "DRAW", "AWAY"].map((o) => {
                    const s = byOutcome[o] || { total: 0, correct: 0 };
                    const acc = s.total > 0 ? (s.correct / s.total) * 100 : null;
                    return (
                      <div key={o} className="kv">
                        <span className="kv-k">
                          {o === "HOME" ? "Home" : o === "DRAW" ? "Draw" : "Away"}
                        </span>
                        <span className="kv-v">
                          {acc != null
                            ? `${s.correct}/${s.total} · ${Math.round(acc)}%`
                            : `${s.correct}/${s.total}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          {/* ---- Month grid ---- */}
          <section className="card" aria-labelledby="cal-heading">
            <div className="cal-head">
              <button
                type="button"
                className="btn btn-ghost cal-nav"
                onClick={() => changeMonth(-1)}
                aria-label="Previous month"
              >
                ‹
              </button>
              <h2 id="cal-heading">{monthLabel(month)}</h2>
              <button
                type="button"
                className="btn btn-ghost cal-nav"
                onClick={() => changeMonth(1)}
                aria-label="Next month"
              >
                ›
              </button>
            </div>
            {calState === "loading" && <Loading label="Loading calendar…" />}
            {calState === "error" && (
              <p className="muted">Calendar data is unavailable right now.</p>
            )}
            {calState === "ready" && (
              <div className="cal-grid" role="grid" aria-label={monthLabel(month)}>
                {WEEKDAYS.map((w) => (
                  <span key={w} className="cal-dow" role="columnheader">
                    {w}
                  </span>
                ))}
                {cells.map((c, i) =>
                  c === null ? (
                    <span key={`pad-${i}`} className="cal-day cal-pad" />
                  ) : c.info ? (
                    <button
                      key={c.key}
                      type="button"
                      className={`cal-day${
                        selectedDay === c.key ? " selected" : ""
                      } ${c.info.incorrect > 0 ? "day-mixed" : c.info.correct > 0 ? "day-ok" : "day-pending"}`}
                      aria-pressed={selectedDay === c.key}
                      aria-label={dayAriaLabel(c.key, c.info)}
                      onClick={() => selectDay(c.key)}
                    >
                      <span className="cal-num">{c.day}</span>
                      <span className="cal-count" aria-hidden="true">
                        <span className="cal-dot" />
                        {c.info.correct}/{c.info.total}
                      </span>
                    </button>
                  ) : (
                    <span key={c.key} className="cal-day cal-empty" aria-hidden="true">
                      <span className="cal-num">{c.day}</span>
                    </span>
                  )
                )}
              </div>
            )}
          </section>

          {/* ---- Filters ---- */}
          <form className="card filters" onSubmit={applyFilters} aria-label="Prediction filters">
            <div className="field">
              <span className="field-label" id="status-chip-label">Status</span>
              <div className="chip-row" role="group" aria-labelledby="status-chip-label">
                {STATUS_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`btn btn-ghost chip-btn${statusFilter === o.value ? " selected" : ""}`}
                    aria-pressed={statusFilter === o.value}
                    onClick={() => setStatusFilter(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label" id="outcome-chip-label">OBULU pick</span>
              <div className="chip-row" role="group" aria-labelledby="outcome-chip-label">
                {OUTCOME_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`btn btn-ghost chip-btn${outcomeFilter === o.value ? " selected" : ""}`}
                    aria-pressed={outcomeFilter === o.value}
                    onClick={() => setOutcomeFilter(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="cal-league">League</label>
              <select
                id="cal-league"
                value={leagueFilter}
                onChange={(e) => setLeagueFilter(e.target.value)}
              >
                <option value="">All leagues</option>
                {leagueOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cal-from">From</label>
              <input
                id="cal-from"
                type="date"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="cal-to">To</label>
              <input
                id="cal-to"
                type="date"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
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

          {/* ---- Day's predictions ---- */}
          <section aria-labelledby="day-list-heading">
            <div className="section-head">
              <h2 id="day-list-heading">
                {selectedDay
                  ? `Predictions on ${new Intl.DateTimeFormat("en", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    }).format(new Date(`${selectedDay}T12:00:00`))}`
                  : `Predictions — ${monthLabel(month)}`}
              </h2>
              {selectedDay && (
                <button type="button" className="link-btn" onClick={clearDay}>
                  Show whole month
                </button>
              )}
            </div>

            {histState === "loading" && items.length === 0 && (
              <Loading label="Loading predictions…" />
            )}
            {histState === "error" && (
              <ErrorState
                error={histError}
                onRetry={() => loadHistory({ pageNum: 1, append: false })}
              />
            )}
            {histState === "ready" && items.length === 0 && (
              <div className="card empty-state">
                <p>
                  <strong>No predictions recorded for this selection.</strong>
                </p>
                <p className="muted">
                  Pick another day or adjust the filters.
                </p>
              </div>
            )}
            {items.length > 0 && (
              <>
                <div className="fixture-grid">
                  {items.map((it) => (
                    <SnapshotCard key={it.id} item={it} onOpen={setDetailId} />
                  ))}
                </div>
                {histState === "loading" && <Loading label="Loading more…" />}
                {items.length < total && histState === "ready" && (
                  <div className="load-more">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => loadHistory({ pageNum: page + 1, append: true })}
                    >
                      Load more ({total - items.length} remaining)
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}

      {detailId && (
        <SnapshotModal id={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}
