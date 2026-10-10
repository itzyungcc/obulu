// OBULU Admin — server-side session management.
// Only SHA-256 hashes of tokens are stored; the raw token only exists in
// the httpOnly cookie (or the Authorization header fallback).

import { randomBytes, createHash } from "node:crypto";
import { db } from "../db/database.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const TOKEN_BYTES = 32;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(userId, { ip = null, userAgent = null } = {}) {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    `INSERT INTO admin_sessions (user_id, token_hash, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    hashToken(token),
    now.toISOString(),
    expiresAt.toISOString(),
    ip,
    userAgent ? String(userAgent).slice(0, 255) : null
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export function validateSession(token) {
  if (!token || typeof token !== "string") return null;
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.username
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return { sessionId: row.id, userId: row.user_id, username: row.username };
}

export function revokeSession(token) {
  if (!token) return;
  db.prepare(
    `UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?`
  ).run(new Date().toISOString(), hashToken(token));
}

export function revokeAllUserSessions(userId, exceptToken = null) {
  const params = [new Date().toISOString(), userId];
  let sql = `UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`;
  if (exceptToken) {
    sql += ` AND token_hash != ?`;
    params.push(hashToken(exceptToken));
  }
  db.prepare(sql).run(...params);
}

// Housekeeping: delete expired/revoked sessions older than 7 days.
export function pruneSessions() {
  try {
    db.prepare(
      `DELETE FROM admin_sessions
       WHERE (expires_at < ? OR revoked_at IS NOT NULL)
         AND created_at < ?`
    ).run(
      new Date().toISOString(),
      new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    );
  } catch { /* best effort */ }
}
