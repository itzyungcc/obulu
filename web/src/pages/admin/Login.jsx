import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAdmin } from "../../admin/AdminContext.jsx";
import "./admin.css";

export default function AdminLogin() {
  const { login, setup, setupNeeded } = useAdmin();
  const navigate = useNavigate();
  const [mode, setMode] = useState(setupNeeded ? "setup" : "login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // If setup is needed, force setup mode.
  const showSetup = setupNeeded || mode === "setup";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = showSetup
        ? await setup(setupToken, username, password)
        : await login(username, password);
      if (result.ok) {
        navigate("/admin", { replace: true });
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-login-wrap">
      <div className="admin-login-card">
        <h1>OBULU Admin</h1>
        <p className="muted">
          {showSetup ? "Create the administrator account" : "Sign in to the control center"}
        </p>
        <form onSubmit={handleSubmit}>
          {showSetup && (
            <label>
              Setup token
              <input
                type="password"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="From ADMIN_SETUP_TOKEN"
                autoComplete="off"
                required
              />
            </label>
          )}
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={showSetup ? "new-password" : "current-password"}
              required
              minLength={8}
            />
          </label>
          {error && <p className="admin-error">{error}</p>}
          <button type="submit" disabled={busy} className="admin-btn-primary">
            {busy ? "Working…" : showSetup ? "Create admin" : "Sign in"}
          </button>
        </form>
        <p className="muted small">
          <Link to="/">← Back to OBULU</Link>
        </p>
      </div>
    </div>
  );
}
