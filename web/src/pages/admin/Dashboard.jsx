import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAdmin, adminFetch } from "../../admin/AdminContext.jsx";
import "./admin.css";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "confidence", label: "Confidence" },
  { id: "automation", label: "Automation" },
  { id: "assistant", label: "Assistant" },
  { id: "features", label: "Features" },
  { id: "health", label: "Health" },
  { id: "audit", label: "Audit" },
  { id: "security", label: "Security" },
];

function Toggle({ checked, onChange, label }) {
  return (
    <label className="admin-toggle">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

function ConfirmModal({ title, message, onConfirm, onCancel, danger }) {
  return (
    <div className="admin-modal-overlay" onClick={onCancel}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="admin-modal-actions">
          <button onClick={onCancel} className="admin-btn">Cancel</button>
          <button
            onClick={onConfirm}
            className={danger ? "admin-btn-danger" : "admin-btn-primary"}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { admin, logout, adminFetch: fetch } = useAdmin();
  const navigate = useNavigate();
  const [tab, setTab] = useState("overview");
  const [settings, setSettings] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [system, setSystem] = useState(null);
  const [audit, setAudit] = useState([]);
  const [assistantDiag, setAssistantDiag] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, jRes, sysRes, aRes] = await Promise.all([
        fetch("/settings"),
        fetch("/jobs"),
        fetch("/system"),
        fetch("/audit?limit=50"),
      ]);
      if (sRes.ok) {
        const data = await sRes.json();
        setSettings(data.settings);
      }
      if (jRes.ok) setJobs((await jRes.json()).jobs);
      if (sysRes.ok) setSystem(await sysRes.json());
      if (aRes.ok) setAudit((await aRes.json()).entries);
      // Assistant diagnostics (public endpoint).
      try {
        const dRes = await fetch(
          `${import.meta.env.VITE_API_URL || ""}/api/assistant/diagnostics`,
          { credentials: "include" }
        );
        if (dRes.ok) setAssistantDiag(await dRes.json());
      } catch { /* ignore */ }
    } catch (e) {
      setMessage({ type: "error", text: "Failed to load dashboard data." });
    } finally {
      setLoading(false);
    }
  }, [fetch]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const updateSetting = async (key, value) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSettings(data.settings);
        setMessage({ type: "success", text: `${key} updated.` });
      } else {
        setMessage({ type: "error", text: data.errors?.join("; ") || "Update failed." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  };

  const jobAction = async (name, action) => {
    setSaving(true);
    try {
      const res = await fetch(`/jobs/${name}/${action}`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setJobs(data.jobs);
        setMessage({ type: "success", text: `${name} ${action}ed.` });
      } else {
        setMessage({ type: "error", text: data.message || "Job action failed." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setSaving(true);
    try {
      const res = await adminFetch("/automation/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (data.skipped) {
        setMessage({ type: "error", text: `Run skipped: ${data.reason}` });
      } else {
        setMessage({ type: "success", text: "Automation run started. Check status for progress." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  };

  const refreshPredictions = () => {
    setConfirm({
      title: "Refresh predictions?",
      message: "This clears all cached predictions. They will be recomputed on next view (slower first load).",
      onConfirm: async () => {
        setConfirm(null);
        setSaving(true);
        try {
          const res = await fetch("/predictions/refresh", { method: "POST" });
          const data = await res.json();
          setMessage({
            type: res.ok ? "success" : "error",
            text: res.ok ? `Cleared ${data.cleared} cached predictions.` : "Refresh failed.",
          });
        } catch {
          setMessage({ type: "error", text: "Network error." });
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const emergencyPause = () => {
    setConfirm({
      title: "Emergency pause?",
      message: "This stops ALL background jobs (automation, live scores, sync). The website itself keeps working.",
      danger: true,
      onConfirm: async () => {
        setConfirm(null);
        setSaving(true);
        try {
          const res = await fetch("/emergency-pause", { method: "POST" });
          const data = await res.json();
          if (res.ok) {
            setJobs(data.jobs);
            setMessage({ type: "success", text: `Paused: ${data.stopped.join(", ")}` });
          }
        } catch {
          setMessage({ type: "error", text: "Network error." });
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const handleLogout = async () => {
    await logout();
    navigate("/admin/login", { replace: true });
  };

  if (loading) {
    return (
      <div className="admin-wrap">
        <p>Loading control center…</p>
      </div>
    );
  }

  return (
    <div className="admin-wrap">
      <header className="admin-header">
        <div>
          <h1>OBULU Control Center</h1>
          <p className="muted">Signed in as {admin?.username}</p>
        </div>
        <button onClick={handleLogout} className="admin-btn">
          Sign out
        </button>
      </header>

      {message && (
        <div className={`admin-message ${message.type}`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="admin-message-close">×</button>
        </div>
      )}

      <nav className="admin-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="admin-main">
        {tab === "overview" && (
          <OverviewTab system={system} jobs={jobs} settings={settings} />
        )}
        {tab === "confidence" && (
          <ConfidenceTab settings={settings} updateSetting={updateSetting} saving={saving} onRefresh={refreshPredictions} />
        )}
        {tab === "automation" && (
          <AutomationTab
            settings={settings}
            jobs={jobs}
            updateSetting={updateSetting}
            jobAction={jobAction}
            runNow={runNow}
            onPause={emergencyPause}
            saving={saving}
          />
        )}
        {tab === "assistant" && (
          <AssistantTab settings={settings} updateSetting={updateSetting} diag={assistantDiag} saving={saving} />
        )}
        {tab === "features" && (
          <FeaturesTab settings={settings} updateSetting={updateSetting} saving={saving} />
        )}
        {tab === "health" && (
          <HealthTab system={system} diag={assistantDiag} onReload={loadAll} />
        )}
        {tab === "audit" && <AuditTab entries={audit} />}
        {tab === "security" && <SecurityTab fetch={fetch} setMessage={setMessage} />}
      </main>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// --- Tab components ---

function OverviewTab({ system, jobs, settings }) {
  return (
    <div>
      <h2>Overview</h2>
      <div className="admin-cards">
        <div className="admin-card">
          <h3>System</h3>
          <p>Database: <strong>{system?.database || "—"}</strong></p>
          <p>Uptime: <strong>{system ? Math.floor(system.uptimeSec / 3600) : "—"}h</strong></p>
          <p>Maintenance: <strong>{settings?.maintenanceMode ? "ON" : "Off"}</strong></p>
        </div>
        <div className="admin-card">
          <h3>Background jobs</h3>
          {jobs ? (
            Object.entries(jobs).map(([name, running]) => (
              <p key={name}>
                {name}: <strong className={running ? "ok" : "bad"}>{running ? "Running" : "Stopped"}</strong>
              </p>
            ))
          ) : (
            <p>—</p>
          )}
        </div>
        <div className="admin-card">
          <h3>Recent runs</h3>
          {system?.recentRuns?.length ? (
            system.recentRuns.slice(0, 3).map((r) => (
              <p key={r.id}>
                {r.id}: <strong>{r.status}</strong> ({r.qualified_count ?? "?"} qualified)
              </p>
            ))
          ) : (
            <p>No recent runs.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfidenceTab({ settings, updateSetting, saving, onRefresh }) {
  const [value, setValue] = useState(settings?.minConfidence ?? 30);
  useEffect(() => {
    setValue(settings?.minConfidence ?? 30);
  }, [settings?.minConfidence]);

  const markets = [
    ["over25", "Over 2.5"],
    ["under25", "Under 2.5"],
    ["over15", "Over 1.5"],
    ["over35", "Over 3.5"],
    ["bttsYes", "BTTS"],
    ["homeOrOver25", "Home or Over 2.5"],
    ["awayOrOver25", "Away or Over 2.5"],
  ];

  const enabledMarkets = settings?.enabledMarkets;
  const toggleMarket = (key) => {
    const current = Array.isArray(enabledMarkets) ? enabledMarkets : markets.map(([k]) => k);
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    updateSetting("enabledMarkets", next);
  };

  return (
    <div>
      <h2>Prediction confidence</h2>
      <p className="muted">
        Predictions below the threshold are hidden from the site (not deleted).
        Changing the threshold filters what publishes — it does not change model accuracy.
      </p>

      <div className="admin-card">
        <h3>Global minimum confidence: {value}%</h3>
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="admin-slider"
        />
        <button
          onClick={() => updateSetting("minConfidence", value)}
          disabled={saving}
          className="admin-btn-primary"
        >
          Save threshold
        </button>
      </div>

      <div className="admin-card">
        <h3>Prediction markets</h3>
        <p className="muted">Toggle which goals markets appear on predictions.</p>
        {markets.map(([key, label]) => {
          const enabled = !Array.isArray(enabledMarkets) || enabledMarkets.includes(key);
          return (
            <Toggle
              key={key}
              label={label}
              checked={enabled}
              onChange={() => toggleMarket(key)}
            />
          );
        })}
      </div>

      <div className="admin-card">
        <h3>Publishing</h3>
        <Toggle
          label="Prediction generation"
          checked={settings?.predictionGenerationEnabled}
          onChange={(v) => updateSetting("predictionGenerationEnabled", v)}
        />
        <Toggle
          label="Prediction publishing (visible on site)"
          checked={settings?.predictionPublishEnabled}
          onChange={(v) => updateSetting("predictionPublishEnabled", v)}
        />
        <button onClick={onRefresh} disabled={saving} className="admin-btn">
          Manual refresh (clear cache)
        </button>
      </div>
    </div>
  );
}

function AutomationTab({ settings, jobs, updateSetting, jobAction, runNow, onPause, saving }) {
  const jobList = [
    ["scheduler", "Automation scheduler"],
    ["resolver", "Calendar resolver"],
    ["live", "Live engine"],
    ["subscriberPoller", "Telegram poller"],
    ["openfootball", "History sync"],
  ];
  return (
    <div>
      <h2>Automation</h2>
      <div className="admin-card">
        <h3>Master switches</h3>
        <Toggle
          label="Automation enabled"
          checked={settings?.automationEnabled}
          onChange={(v) => updateSetting("automationEnabled", v)}
        />
        <p className="muted">
          Interval: {settings?.automationIntervalMinutes ?? 60} min
        </p>
        <input
          type="number"
          min={5}
          max={1440}
          defaultValue={settings?.automationIntervalMinutes ?? 60}
          id="interval-input"
          className="admin-input"
        />
        <button
          onClick={() => {
            const v = Number(document.getElementById("interval-input").value);
            updateSetting("automationIntervalMinutes", v);
          }}
          disabled={saving}
          className="admin-btn"
        >
          Save interval
        </button>
      </div>

      <div className="admin-card">
        <h3>Background jobs</h3>
        {jobList.map(([name, label]) => (
          <div key={name} className="admin-job-row">
            <span>
              {label}:{" "}
              <strong className={jobs?.[name] ? "ok" : "bad"}>
                {jobs?.[name] ? "Running" : "Stopped"}
              </strong>
            </span>
            <div>
              <button
                onClick={() => jobAction(name, "start")}
                disabled={saving || jobs?.[name]}
                className="admin-btn small"
              >
                Start
              </button>
              <button
                onClick={() => jobAction(name, "stop")}
                disabled={saving || !jobs?.[name]}
                className="admin-btn small"
              >
                Stop
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="admin-card">
        <h3>Manual run</h3>
        <button onClick={runNow} disabled={saving} className="admin-btn-primary">
          Run automation now
        </button>
        <button onClick={onPause} disabled={saving} className="admin-btn-danger">
          Emergency pause all
        </button>
      </div>
    </div>
  );
}

function AssistantTab({ settings, updateSetting, diag, saving }) {
  const [timeout, setTimeoutVal] = useState(settings?.assistantTimeoutMs ?? 40000);
  useEffect(() => {
    setTimeoutVal(settings?.assistantTimeoutMs ?? 40000);
  }, [settings?.assistantTimeoutMs]);

  const attempts = diag?.recentAttempts || [];
  const errors = attempts.filter((a) => a.outcome !== "success").length;

  return (
    <div>
      <h2>AI assistant</h2>
      <div className="admin-card">
        <Toggle
          label="Assistant enabled"
          checked={settings?.assistantEnabled}
          onChange={(v) => updateSetting("assistantEnabled", v)}
        />
        <label>
          Maintenance message
          <textarea
            defaultValue={settings?.assistantMaintenanceMessage}
            id="asst-maint"
            className="admin-input"
            rows={2}
          />
        </label>
        <label>
          Fallback message (provider failure)
          <textarea
            defaultValue={settings?.assistantFallbackMessage}
            id="asst-fallback"
            className="admin-input"
            rows={2}
          />
        </label>
        <button
          onClick={() => {
            updateSetting("assistantMaintenanceMessage", document.getElementById("asst-maint").value);
            updateSetting("assistantFallbackMessage", document.getElementById("asst-fallback").value);
          }}
          disabled={saving}
          className="admin-btn"
        >
          Save messages
        </button>
      </div>

      <div className="admin-card">
        <h3>Provider timeout: {Math.round(timeout / 1000)}s</h3>
        <input
          type="range"
          min={5000}
          max={120000}
          step={5000}
          value={timeout}
          onChange={(e) => setTimeoutVal(Number(e.target.value))}
          className="admin-slider"
        />
        <button
          onClick={() => updateSetting("assistantTimeoutMs", timeout)}
          disabled={saving}
          className="admin-btn"
        >
          Save timeout
        </button>
      </div>

      <div className="admin-card">
        <h3>Provider health</h3>
        {diag ? (
          <>
            <p>Models: <strong>{(diag.models || []).join(", ") || "—"}</strong></p>
            <p>Recent attempts: <strong>{attempts.length}</strong> ({errors} errors)</p>
            {attempts.slice(0, 5).map((a, i) => (
              <p key={i} className="muted small">
                {a.model}: {a.outcome} ({a.firstTokenMs ? `${Math.round(a.firstTokenMs / 1000)}s` : "—"})
              </p>
            ))}
          </>
        ) : (
          <p className="muted">No diagnostics yet (cleared on restart).</p>
        )}
      </div>
    </div>
  );
}

function FeaturesTab({ settings, updateSetting }) {
  const features = [
    ["featureLive", "Live scores"],
    ["featureCalendar", "Calendar"],
    ["featureJackpot", "Jackpot analyzer"],
    ["featureAssistant", "AI assistant"],
    ["featureAutomation", "Automation"],
  ];
  return (
    <div>
      <h2>Feature management</h2>
      <div className="admin-card">
        <h3>Maintenance mode</h3>
        <Toggle
          label="Maintenance mode"
          checked={settings?.maintenanceMode}
          onChange={(v) => updateSetting("maintenanceMode", v)}
        />
        <label>
          Maintenance message
          <textarea
            defaultValue={settings?.maintenanceMessage}
            id="maint-msg"
            className="admin-input"
            rows={2}
          />
        </label>
        <button
          onClick={() =>
            updateSetting("maintenanceMessage", document.getElementById("maint-msg").value)
          }
          className="admin-btn"
        >
          Save message
        </button>
      </div>
      <div className="admin-card">
        <h3>Modules</h3>
        {features.map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            checked={settings?.[key]}
            onChange={(v) => updateSetting(key, v)}
          />
        ))}
      </div>
    </div>
  );
}

function HealthTab({ system, diag, onReload }) {
  return (
    <div>
      <h2>System health</h2>
      <button onClick={onReload} className="admin-btn">Reload</button>
      <div className="admin-cards">
        <div className="admin-card">
          <h3>Backend</h3>
          <p>Database: <strong className={system?.database === "ok" ? "ok" : "bad"}>{system?.database || "—"}</strong></p>
          <p>Uptime: <strong>{system ? `${Math.floor(system.uptimeSec / 3600)}h ${Math.floor((system.uptimeSec % 3600) / 60)}m` : "—"}</strong></p>
          <p>Node: <strong>{system?.nodeVersion || "—"}</strong></p>
        </div>
        <div className="admin-card">
          <h3>Assistant provider</h3>
          {diag ? (
            <>
              <p>Attempts (in-memory): <strong>{(diag.recentAttempts || []).length}</strong></p>
              <p>Last success: <strong>{diag.lastSuccessAt || "—"}</strong></p>
            </>
          ) : (
            <p className="muted">No data yet.</p>
          )}
        </div>
      </div>
      <h3>Recent automation runs</h3>
      <div className="admin-card">
        {system?.recentRuns?.length ? (
          system.recentRuns.map((r) => (
            <p key={r.id} className="small">
              {r.id} — <strong>{r.status}</strong> · {r.qualified_count ?? "?"} qualified ·{" "}
              {r.alerted_count ?? "?"} alerted · {r.error_count ?? "?"} errors
            </p>
          ))
        ) : (
          <p className="muted">No runs recorded.</p>
        )}
      </div>
    </div>
  );
}

function AuditTab({ entries }) {
  return (
    <div>
      <h2>Audit history</h2>
      <div className="admin-card">
        {entries.length ? (
          entries.map((e) => (
            <div key={e.id} className="admin-audit-row">
              <span className="muted small">{e.created_at?.slice(0, 16).replace("T", " ")}</span>
              <strong>{e.username || "—"}</strong>
              <span>{e.action}</span>
              {e.target && <span className="muted">({e.target})</span>}
              <span className={e.outcome?.startsWith("success") ? "ok" : "bad"}>{e.outcome}</span>
            </div>
          ))
        ) : (
          <p className="muted">No audit entries yet.</p>
        )}
      </div>
    </div>
  );
}

function SecurityTab({ fetch, setMessage }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const changePassword = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Password changed." });
        setCurrent("");
        setNext("");
      } else {
        setMessage({ type: "error", text: data.message || "Change failed." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Account & security</h2>
      <div className="admin-card">
        <h3>Change password</h3>
        <form onSubmit={changePassword}>
          <label>
            Current password
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
              className="admin-input"
            />
          </label>
          <label>
            New password (min 8 characters)
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="admin-input"
            />
          </label>
          <button type="submit" disabled={busy} className="admin-btn-primary">
            {busy ? "Working…" : "Change password"}
          </button>
        </form>
        <p className="muted small">
          Changing your password signs out all other sessions.
        </p>
      </div>
    </div>
  );
}
