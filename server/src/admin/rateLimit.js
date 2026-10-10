// OBULU Admin — login rate limiting (in-memory sliding window).
// Single-instance assumption holds on Render free tier.

const attempts = new Map(); // ip -> { count, firstAt, lockedUntil }

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCK_MS = 15 * 60 * 1000; // lock for 15 minutes after max attempts

export function loginAllowed(ip) {
  const key = ip || "unknown";
  const rec = attempts.get(key);
  if (!rec) return { allowed: true };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - Date.now() };
  }
  // Window expired — reset.
  if (Date.now() - rec.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return { allowed: true };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip) {
  const key = ip || "unknown";
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    rec = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
  }
  attempts.set(key, rec);
  return rec;
}

export function recordLoginSuccess(ip) {
  attempts.delete(ip || "unknown");
}

// Periodic cleanup to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.firstAt > WINDOW_MS && (!rec.lockedUntil || now > rec.lockedUntil)) {
      attempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref?.();
