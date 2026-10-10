// OBULU Admin Control Center — authentication routes.
// All other admin routes (settings, jobs, etc.) require a valid session
// via requireAdminSession.

import { Router } from "express";
import { db } from "../db/database.js";
import { hashPassword, verifyPassword } from "../admin/password.js";
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  pruneSessions,
} from "../admin/sessions.js";
import {
  loginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "../admin/rateLimit.js";
import {
  ADMIN_COOKIE,
  requireAdminSession,
  getTokenFromRequest,
  auditLog,
  clientIp,
} from "../admin/middleware.js";

const router = Router();

function cookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd, // Secure in production (HTTPS on Render)
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000, // 12h, matches session TTL
  };
}

function setSessionCookie(res, token) {
  const opts = cookieOptions();
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.floor(opts.maxAge / 1000)}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const opts = cookieOptions();
  const parts = [
    `${ADMIN_COOKIE}=`,
    `Path=${opts.path}`,
    `Max-Age=0`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function setupCompleted() {
  try {
    return !!db.prepare("SELECT id FROM admin_setup WHERE id = 1").get();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/setup-status — is first-admin setup needed?
// ---------------------------------------------------------------------------
router.get("/setup-status", (req, res) => {
  const adminCount = (() => {
    try {
      return db.prepare("SELECT COUNT(*) AS c FROM admin_users").get().c;
    } catch {
      return 0;
    }
  })();
  res.json({
    setupNeeded: !setupCompleted() && adminCount === 0,
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/setup — create the first admin (single-use setup token).
// Body: { setupToken, username, password }
// ---------------------------------------------------------------------------
router.post("/setup", (req, res) => {
  const ip = clientIp(req);
  const { setupToken, username, password } = req.body || {};

  if (setupCompleted()) {
    auditLog({ action: "admin.setup", outcome: "rejected: already completed", ip });
    return res.status(403).json({ error: "FORBIDDEN", message: "Setup already completed." });
  }

  const expected = process.env.ADMIN_SETUP_TOKEN;
  if (!expected || setupToken !== expected) {
    auditLog({ action: "admin.setup", outcome: "rejected: bad token", ip });
    recordLoginFailure(ip);
    return res.status(403).json({ error: "FORBIDDEN", message: "Invalid setup token." });
  }

  const name = String(username || "").trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(name)) {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message: "Username must be 3–32 characters (letters, numbers, . _ -).",
    });
  }

  let passwordHash;
  try {
    passwordHash = hashPassword(password);
  } catch (e) {
    return res.status(400).json({ error: "BAD_REQUEST", message: e.message });
  }

  try {
    const now = new Date().toISOString();
    const info = db
      .prepare("INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(name, passwordHash, now);
    db.prepare("INSERT INTO admin_setup (id, completed_at) VALUES (1, ?)").run(now);
    auditLog({
      userId: Number(info.lastInsertRowid),
      username: name,
      action: "admin.setup",
      outcome: "success",
      ip,
    });
    // Auto-login after setup.
    const session = createSession(Number(info.lastInsertRowid), {
      ip,
      userAgent: req.headers["user-agent"],
    });
    setSessionCookie(res, session.token);
    res.json({ ok: true, username: name, token: session.token });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "CONFLICT", message: "Username already taken." });
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/login — Body: { username, password }
// ---------------------------------------------------------------------------
router.post("/login", (req, res) => {
  const ip = clientIp(req);

  const gate = loginAllowed(ip);
  if (!gate.allowed) {
    auditLog({ action: "admin.login", outcome: "rejected: rate limited", ip });
    return res.status(429).json({
      error: "RATE_LIMITED",
      message: "Too many failed attempts. Try again later.",
      retryAfterMs: gate.retryAfterMs,
    });
  }

  const { username, password } = req.body || {};
  const name = String(username || "").trim();

  const user = (() => {
    try {
      return db.prepare("SELECT * FROM admin_users WHERE username = ?").get(name);
    } catch {
      return null;
    }
  })();

  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(ip);
    auditLog({ username: name, action: "admin.login", outcome: "failed: bad credentials", ip });
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid username or password.",
    });
  }

  recordLoginSuccess(ip);
  db.prepare("UPDATE admin_users SET last_login_at = ? WHERE id = ?")
    .run(new Date().toISOString(), user.id);
  const session = createSession(user.id, { ip, userAgent: req.headers["user-agent"] });
  setSessionCookie(res, session.token);
  auditLog({
    userId: user.id,
    username: user.username,
    action: "admin.login",
    outcome: "success",
    ip,
  });
  pruneSessions();
  res.json({ ok: true, username: user.username, token: session.token });
});

// ---------------------------------------------------------------------------
// POST /api/admin/logout
// ---------------------------------------------------------------------------
router.post("/logout", (req, res) => {
  const token = getTokenFromRequest(req);
  const session = validateSession(token);
  if (token) revokeSession(token);
  clearSessionCookie(res);
  auditLog({
    userId: session?.userId || null,
    username: session?.username || null,
    action: "admin.logout",
    outcome: "success",
    ip: clientIp(req),
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/admin/me — session check
// ---------------------------------------------------------------------------
router.get("/me", requireAdminSession, (req, res) => {
  res.json({ ok: true, username: req.admin.username, userId: req.admin.userId });
});

// ---------------------------------------------------------------------------
// POST /api/admin/change-password — Body: { currentPassword, newPassword }
// ---------------------------------------------------------------------------
router.post("/change-password", requireAdminSession, (req, res) => {
  const ip = clientIp(req);
  const { currentPassword, newPassword } = req.body || {};

  const user = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.admin.userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    auditLog({
      userId: req.admin.userId,
      username: req.admin.username,
      action: "admin.change-password",
      outcome: "failed: wrong current password",
      ip,
    });
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Current password is incorrect.",
    });
  }

  let newHash;
  try {
    newHash = hashPassword(newPassword);
  } catch (e) {
    return res.status(400).json({ error: "BAD_REQUEST", message: e.message });
  }

  db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").run(newHash, user.id);
  // Invalidate all other sessions (password change = possible compromise).
  const currentToken = getTokenFromRequest(req);
  revokeAllUserSessions(user.id, currentToken);

  auditLog({
    userId: user.id,
    username: user.username,
    action: "admin.change-password",
    outcome: "success",
    ip,
  });
  res.json({ ok: true, message: "Password changed. Other sessions were signed out." });
});

export default router;
