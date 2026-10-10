// OBULU Admin — auth middleware and audit logging.

import { db } from "../db/database.js";
import { validateSession } from "./sessions.js";

export const ADMIN_COOKIE = "obulu_admin";

export function getTokenFromRequest(req) {
  // 1. httpOnly cookie (primary).
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)obulu_admin=([^;]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  // 2. Authorization: Bearer fallback (for clients where cross-origin
  // cookies are unreliable, e.g. some Android WebViews).
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

export function requireAdminSession(req, res, next) {
  const token = getTokenFromRequest(req);
  const session = validateSession(token);
  if (!session) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Admin session required. Please log in.",
    });
  }
  req.admin = session;
  next();
}

export function auditLog({ userId = null, username = null, action, target = null, detail = null, outcome, ip = null }) {
  try {
    db.prepare(
      `INSERT INTO admin_audit_log (user_id, username, action, target, detail, outcome, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      username,
      action,
      target,
      detail ? String(detail).slice(0, 2000) : null,
      outcome,
      ip,
      new Date().toISOString()
    );
  } catch (e) {
    console.error("[admin] audit log failed:", e.message);
  }
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}
