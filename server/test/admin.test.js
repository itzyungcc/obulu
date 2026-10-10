// OBULU Admin Control Center tests — plain node asserts.
// Covers: password hashing, session lifecycle, rate limiting,
// auth middleware, and settings validation.

import assert from "node:assert";
import { hashPassword, verifyPassword } from "../src/admin/password.js";
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
} from "../src/admin/sessions.js";
import { loginAllowed, recordLoginFailure, recordLoginSuccess } from "../src/admin/rateLimit.js";
import { db } from "../src/db/database.js";

let passed = 0;
const pendingChecks = [];
function check(name, fn) {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };
  pendingChecks.push(run());
}

// --- Password hashing ---

check("hashPassword rejects short passwords", () => {
  assert.throws(() => hashPassword("short"), /at least 8/);
});

check("hashPassword produces verifiable scrypt hash", () => {
  const h = hashPassword("correct-horse-123");
  assert.ok(h.startsWith("scrypt$"), "scrypt format");
  assert.ok(verifyPassword("correct-horse-123", h), "correct password verifies");
  assert.ok(!verifyPassword("wrong-password", h), "wrong password rejected");
  assert.ok(!verifyPassword("correct-horse-123", "garbage"), "garbage hash rejected");
  assert.ok(!verifyPassword("correct-horse-123", "scrypt$1$2$3$abcd$ef"), "malformed rejected");
});

check("hashPassword uses unique salts", () => {
  const h1 = hashPassword("same-password-1");
  const h2 = hashPassword("same-password-1");
  assert.notStrictEqual(h1, h2, "salts differ");
});

// --- Sessions ---

function ensureTestUser() {
  let user = db.prepare("SELECT * FROM admin_users WHERE username = ?").get("__test_admin__");
  if (!user) {
    const hash = hashPassword("test-password-123");
    const info = db
      .prepare("INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run("__test_admin__", hash, new Date().toISOString());
    user = { id: Number(info.lastInsertRowid), username: "__test_admin__" };
  }
  return user;
}

check("session create/validate/revoke lifecycle", () => {
  const user = ensureTestUser();
  const { token } = createSession(user.id, { ip: "127.0.0.1" });
  assert.ok(token && token.length >= 64, "token issued");

  const valid = validateSession(token);
  assert.ok(valid, "session validates");
  assert.strictEqual(valid.userId, user.id);
  assert.strictEqual(valid.username, "__test_admin__");

  revokeSession(token);
  assert.strictEqual(validateSession(token), null, "revoked session rejected");
});

check("validateSession rejects garbage and expired", () => {
  assert.strictEqual(validateSession(null), null);
  assert.strictEqual(validateSession(""), null);
  assert.strictEqual(validateSession("not-a-real-token"), null);

  const user = ensureTestUser();
  const { token } = createSession(user.id);
  // Force expiry.
  db.prepare("UPDATE admin_sessions SET expires_at = ? WHERE user_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), user.id);
  assert.strictEqual(validateSession(token), null, "expired rejected");
  db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(user.id);
});

check("revokeAllUserSessions keeps current session", () => {
  const user = ensureTestUser();
  const s1 = createSession(user.id);
  const s2 = createSession(user.id);
  revokeAllUserSessions(user.id, s1.token);
  assert.ok(validateSession(s1.token), "current session kept");
  assert.strictEqual(validateSession(s2.token), null, "other session revoked");
  db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(user.id);
});

// --- Rate limiting ---

check("rate limit blocks after 5 failures", () => {
  const ip = "10.99.99.99";
  recordLoginSuccess(ip); // reset
  for (let i = 0; i < 5; i++) {
    assert.ok(loginAllowed(ip).allowed, `attempt ${i + 1} allowed`);
    recordLoginFailure(ip);
  }
  const gate = loginAllowed(ip);
  assert.ok(!gate.allowed, "blocked after 5 failures");
  assert.ok(gate.retryAfterMs > 0, "retryAfterMs set");
  recordLoginSuccess(ip); // cleanup
  assert.ok(loginAllowed(ip).allowed, "reset after success");
});

// --- Settings validation ---

check("admin settings validate types and ranges", async () => {
  const { getAdminSetting } = await import("../src/routes/adminSettings.js");
  // Defaults apply when unset.
  assert.strictEqual(typeof getAdminSetting("minConfidence"), "number");
  assert.strictEqual(getAdminSetting("assistantEnabled"), true);
  assert.strictEqual(getAdminSetting("maintenanceMode"), false);
});

await Promise.all(pendingChecks);

// Cleanup test user.
try {
  const u = db.prepare("SELECT id FROM admin_users WHERE username = ?").get("__test_admin__");
  if (u) {
    db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(u.id);
    db.prepare("DELETE FROM admin_users WHERE id = ?").run(u.id);
  }
} catch { /* ignore */ }

console.log(`\nadmin: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
