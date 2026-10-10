// OBULU Admin — password hashing with node:crypto scrypt (no new deps).
// Format: scrypt$N$r$p$saltHex$hashHex

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const N = 16384; // CPU/memory cost (~50ms on free tier — fine for login)
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;

export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (password.length > 128) {
    throw new Error("Password too long");
  }
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const Np = parseInt(parts[1], 10);
    const Rp = parseInt(parts[2], 10);
    const Pp = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (!Number.isFinite(Np) || !Number.isFinite(Rp) || !Number.isFinite(Pp)) return false;
    if (salt.length !== SALT_LEN || expected.length !== KEYLEN) return false;
    const hash = scryptSync(password, salt, KEYLEN, { N: Np, r: Rp, p: Pp });
    return timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}
