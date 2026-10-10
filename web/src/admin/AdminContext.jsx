import { createContext, useContext, useState, useEffect, useCallback } from "react";

const AdminContext = createContext(null);

const API = import.meta.env.VITE_API_URL || "";

async function adminFetch(path, opts = {}) {
  const res = await fetch(`${API}/api/admin${path}`, {
    ...opts,
    credentials: "include", // send httpOnly cookie
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  // Bearer fallback: if we have a token (cookie failed, e.g. WebView),
  // retry with Authorization header.
  if (res.status === 401 && AdminContext._token && !opts._retried) {
    return fetch(`${API}/api/admin${path}`, {
      ...opts,
      _retried: true,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
        Authorization: `Bearer ${AdminContext._token}`,
      },
    });
  }
  return res;
}

export function AdminProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [setupNeeded, setSetupNeeded] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const res = await adminFetch("/me");
      if (res.ok) {
        const data = await res.json();
        setAdmin({ username: data.username, userId: data.userId });
      } else {
        setAdmin(null);
      }
    } catch {
      setAdmin(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const checkSetup = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/setup-status`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setSetupNeeded(!!data.setupNeeded);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    checkSession();
    checkSetup();
  }, [checkSession, checkSetup]);

  const login = async (username, password) => {
    const res = await adminFetch("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      // Store token for Bearer fallback (memory only, never localStorage).
      if (data.token) AdminContext._token = data.token;
      setAdmin({ username: data.username });
      return { ok: true };
    }
    return { ok: false, error: data.message || data.error || "Login failed" };
  };

  const logout = async () => {
    try {
      await adminFetch("/logout", { method: "POST" });
    } catch { /* ignore */ }
    AdminContext._token = null;
    setAdmin(null);
  };

  const setup = async (setupToken, username, password) => {
    const res = await adminFetch("/setup", {
      method: "POST",
      body: JSON.stringify({ setupToken, username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (data.token) AdminContext._token = data.token;
      setAdmin({ username: data.username });
      setSetupNeeded(false);
      return { ok: true };
    }
    return { ok: false, error: data.message || data.error || "Setup failed" };
  };

  return (
    <AdminContext.Provider
      value={{ admin, loading, setupNeeded, login, logout, setup, checkSession, adminFetch }}
    >
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin must be used within AdminProvider");
  return ctx;
}

export { adminFetch };
