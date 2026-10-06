import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.js";
import Loading from "../components/Loading.jsx";
import ErrorState from "../components/ErrorState.jsx";

const TABS = [
  { id: "qualified", label: "Qualified" },
  { id: "notifications", label: "Notifications" },
  { id: "history", label: "History" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
];

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function OutcomeBadge({ outcome }) {
  const o = String(outcome || "").toLowerCase();
  const label = o === "home" ? "HOME" : o === "away" ? "AWAY" : "DRAW";
  return <span className={`outcome-badge outcome-${o}`}>{label}</span>;
}

function QualifiedCard({ q }) {
  return (
    <article className="auto-card">
      <div className="auto-card-head">
        <div>
          <div className="auto-match">
            {q.home_team} <span className="vs">vs</span> {q.away_team}
          </div>
          <div className="auto-meta">
            {q.league} · {fmtDateTime(q.kickoff)}
          </div>
        </div>
        <OutcomeBadge outcome={q.predicted_outcome} />
      </div>
      <div className="auto-probs">
        <span>H {Number(q.home_probability).toFixed(0)}%</span>
        <span>D {Number(q.draw_probability).toFixed(0)}%</span>
        <span>A {Number(q.away_probability).toFixed(0)}%</span>
      </div>
      <div className="auto-stats">
        <span title="Model confidence (signal strength, not win probability)">
          Confidence {Number(q.confidence).toFixed(0)}%
        </span>
        <span>Data {Number(q.data_completeness).toFixed(0)}%</span>
        {q.alerts_sent > 0 && <span className="auto-alerted">🔔 alerted</span>}
      </div>
    </article>
  );
}

function NotificationCard({ n, onRead }) {
  return (
    <article className={`auto-card${n.read_at ? "" : " unread"}`}>
      <div className="auto-card-head">
        <div>
          <div className="auto-match">
            {n.home_team} <span className="vs">vs</span> {n.away_team}
          </div>
          <div className="auto-meta">
            {n.league} · {fmtDateTime(n.kickoff)} · alerted {fmtDateTime(n.sent_at)}
          </div>
        </div>
        <OutcomeBadge outcome={n.predicted_outcome} />
      </div>
      <div className="auto-probs">
        <span>H {Number(n.home_probability).toFixed(0)}%</span>
        <span>D {Number(n.draw_probability).toFixed(0)}%</span>
        <span>A {Number(n.away_probability).toFixed(0)}%</span>
      </div>
      <div className="auto-stats">
        <span>Confidence {Number(n.confidence).toFixed(0)}%</span>
        <span>Data {Number(n.data_completeness).toFixed(0)}%</span>
      </div>
      {!n.read_at && (
        <button type="button" className="btn-small" onClick={() => onRead(n.id)}>
          Mark read
        </button>
      )}
    </article>
  );
}

export default function Automation() {
  const [tab, setTab] = useState("qualified");
  const [status, setStatus] = useState(null);
  const [qualified, setQualified] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [history, setHistory] = useState([]);
  const [runs, setRuns] = useState([]);
  const [config, setConfig] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const [st, q, cfg] = await Promise.all([
        apiFetch("/automation/status"),
        apiFetch("/automation/qualified", { limit: 50 }),
        apiFetch("/automation/config"),
      ]);
      setStatus(st);
      setQualified(q.qualified || []);
      setConfig(cfg.config || null);
      setState("ready");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 0)) {
        // Offline APK build or old backend: automation endpoints absent.
        setOffline(true);
        setState("ready");
      } else {
        setError(e.message);
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadTab = useCallback(
    async (t) => {
      setTab(t);
      try {
        if (t === "notifications") {
          const r = await apiFetch("/automation/notifications", { limit: 50 });
          setNotifications(r.notifications || []);
        } else if (t === "history") {
          const r = await apiFetch("/automation/history", { limit: 50 });
          setHistory(r.history || []);
        } else if (t === "runs") {
          const r = await apiFetch("/automation/runs", { limit: 20 });
          setRuns(r.runs || []);
        }
      } catch (e) {
        setError(e.message);
      }
    },
    []
  );

  const API_ROOT = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

  const markRead = async (id) => {
    try {
      await fetch(`${API_ROOT}/api/automation/notifications/${id}/read`, { method: "POST" });
    } catch {
      /* ignore */
    }
    setNotifications((ns) =>
      ns.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setStatus((s) =>
      s ? { ...s, unreadNotifications: Math.max(0, (s.unreadNotifications || 1) - 1) } : s
    );
  };

  const markAllRead = async () => {
    try {
      await fetch(`${API_ROOT}/api/automation/notifications/read-all`, {
        method: "POST",
      });
      setNotifications((ns) => ns.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
      setStatus((s) => (s ? { ...s, unreadNotifications: 0 } : s));
    } catch {
      /* ignore */
    }
  };

  if (state === "loading") return <Loading />;
  if (state === "error") return <ErrorState message={error} onRetry={load} />;
  if (offline) {
    return (
      <div className="container page">
        <h1>Automation</h1>
        <p className="muted">
          The automation agent runs on the OBULU server and isn't available in
          the offline build. Open <strong>obulu.onrender.com</strong> in your
          browser to use it.
        </p>
      </div>
    );
  }

  return (
    <div className="container page">
      <h1>Automation Agent</h1>

      <section className="auto-status">
        <div className={`status-pill ${status?.enabled ? "on" : "off"}`}>
          {status?.enabled ? "● ON" : "○ OFF"}
        </div>
        {status?.dryRun && <span className="dryrun-pill">DRY-RUN</span>}
        <div className="auto-status-meta">
          <span>
            Last run: {status?.lastRun ? fmtDateTime(status.lastRun.started_at) : "never"}
            {status?.lastRun && ` (${status.lastRun.status})`}
          </span>
          {status?.unreadNotifications > 0 && (
            <span className="unread-count">🔔 {status.unreadNotifications} unread</span>
          )}
        </div>
      </section>

      <nav className="auto-tabs" aria-label="Automation sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`auto-tab${tab === t.id ? " active" : ""}`}
            onClick={() => loadTab(t.id)}
          >
            {t.label}
            {t.id === "notifications" && status?.unreadNotifications > 0 && (
              <span className="tab-badge">{status.unreadNotifications}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "qualified" && (
        <section>
          {qualified.length === 0 ? (
            <p className="muted">
              No qualified matches yet. The agent alerts you when a prediction
              passes all configured thresholds.
            </p>
          ) : (
            qualified.map((q) => <QualifiedCard key={q.prediction_id} q={q} />)
          )}
        </section>
      )}

      {tab === "notifications" && (
        <section>
          {notifications.length > 0 && (
            <button type="button" className="btn-small" onClick={markAllRead}>
              Mark all read
            </button>
          )}
          {notifications.length === 0 ? (
            <p className="muted">No notifications yet.</p>
          ) : (
            notifications.map((n) => (
              <NotificationCard key={n.id} n={n} onRead={markRead} />
            ))
          )}
        </section>
      )}

      {tab === "history" && (
        <section>
          {history.length === 0 ? (
            <p className="muted">No prediction history yet.</p>
          ) : (
            <div className="auto-table-wrap">
              <table className="auto-table">
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Prediction</th>
                    <th>Conf.</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.prediction_id}>
                      <td>
                        {h.home_team} vs {h.away_team}
                        <div className="auto-meta">{fmtDateTime(h.kickoff)}</div>
                      </td>
                      <td>
                        <OutcomeBadge outcome={h.predicted_outcome} />
                      </td>
                      <td>{Number(h.confidence).toFixed(0)}%</td>
                      <td>
                        {h.actual_outcome
                          ? h.prediction_correct
                            ? "✅ correct"
                            : "❌ wrong"
                          : "⏳ pending"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "runs" && (
        <section>
          {runs.length === 0 ? (
            <p className="muted">No automation runs yet.</p>
          ) : (
            <div className="auto-table-wrap">
              <table className="auto-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Found</th>
                    <th>Qualified</th>
                    <th>Alerted</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.id}
                        <div className="auto-meta">{fmtDateTime(r.started_at)}</div>
                      </td>
                      <td>{r.status}</td>
                      <td>{r.discovered_count}</td>
                      <td>{r.qualified_count}</td>
                      <td>{r.alerted_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "settings" && config && (
        <section className="auto-settings">
          <dl>
            <div><dt>Status</dt><dd>{config.enabled ? "Enabled" : "Disabled"}</dd></div>
            <div><dt>Dry-run mode</dt><dd>{config.dryRun ? "Yes (no notifications sent)" : "No (live alerts)"}</dd></div>
            <div><dt>Scan interval</dt><dd>Every {config.intervalMinutes} minutes</dd></div>
            <div><dt>Min. confidence</dt><dd>{config.minConfidence}%</dd></div>
            <div><dt>Min. data completeness</dt><dd>{config.minDataCompleteness}%</dd></div>
            <div><dt>Min. probability</dt><dd>{config.minProbability}%</dd></div>
            <div><dt>Min. outcome margin</dt><dd>{config.minOutcomeMargin} pts</dd></div>
            <div><dt>Max alerts / run</dt><dd>{config.maxAlertsPerRun}</dd></div>
            <div><dt>Max alerts / day</dt><dd>{config.maxAlertsPerDay}</dd></div>
            <div><dt>Kickoff window</dt><dd>{config.minHoursBeforeKickoff}h – {config.maxHoursBeforeKickoff}h before kickoff</dd></div>
            <div><dt>Allowed outcomes</dt><dd>{(config.allowedOutcomes || []).join(", ")}</dd></div>
            <div><dt>Telegram</dt><dd>{config.telegramConfigured ? "Connected" : "Not configured"}</dd></div>
          </dl>
          <p className="muted">
            Thresholds are managed server-side via environment variables or the
            admin API.
          </p>
        </section>
      )}
    </div>
  );
}
