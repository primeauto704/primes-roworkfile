'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// scrypt parameters (N, r, p). N=2^15 is a comfortable interactive-login cost.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const HASH_PREFIX = 'scrypt';

/** Produce a self-describing hash string: scrypt$N$r$p$<salt b64>$<hash b64> */
function hashPassword(password, params = SCRYPT) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('Password must be a non-empty string.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2,
  });
  return [HASH_PREFIX, params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
    });
  } catch (_) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function constantTimeEqualStrings(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) {
    // Still burn comparable time so username length isn't trivially observable.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Credentials come from (highest priority first):
 *   1. SHOP_USERNAME + SHOP_PASSWORD_HASH environment variables (hash from `npm run setup -- --hash-only`)
 *   2. SHOP_USERNAME + SHOP_PASSWORD environment variables (plain; hashed in memory at startup —
 *      convenient for Docker, but prefer the hash)
 *   3. config/credentials.json written by `npm run setup`
 * Nothing is hardcoded. If none is configured the app starts in "setup required" mode.
 */
function loadCredentials({ configDir, env = process.env, log = console }) {
  const user = env.SHOP_USERNAME && env.SHOP_USERNAME.trim();
  if (user && env.SHOP_PASSWORD_HASH) {
    return { username: user, passwordHash: env.SHOP_PASSWORD_HASH.trim(), source: 'environment (hash)' };
  }
  if (user && env.SHOP_PASSWORD) {
    log.warn('[auth] SHOP_PASSWORD is set as plain text. Prefer SHOP_PASSWORD_HASH (run: npm run setup -- --hash-only).');
    return { username: user, passwordHash: hashPassword(env.SHOP_PASSWORD), source: 'environment (plain password)' };
  }
  const file = path.join(configDir, 'credentials.json');
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data.username === 'string' && typeof data.passwordHash === 'string' && data.username.trim()) {
        return { username: data.username.trim(), passwordHash: data.passwordHash.trim(), source: file };
      }
      log.error(`[auth] ${file} is missing "username" or "passwordHash".`);
    } catch (err) {
      log.error(`[auth] Could not read ${file}: ${err.message}`);
    }
  }
  return null;
}

function writeCredentialsFile(configDir, username, password) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'credentials.json');
  const payload = {
    username: username.trim(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    note: 'Shared shop login for the RO Workflow portal. Re-run `npm run setup` to change it. Keep this file private.',
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows */ }
  return file;
}

// ---- Login throttling ------------------------------------------------------
// Small in-memory limiter: after MAX_FAILS failed attempts from one address,
// further attempts are refused for LOCK_MS. Good enough for a shop portal.
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

class LoginLimiter {
  constructor() { this.attempts = new Map(); }
  check(key) {
    const rec = this.attempts.get(key);
    if (!rec) return { allowed: true };
    const nowMs = Date.now();
    if (rec.lockedUntil && rec.lockedUntil > nowMs) {
      return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - nowMs) / 1000) };
    }
    if (nowMs - rec.first > WINDOW_MS) this.attempts.delete(key);
    return { allowed: true };
  }
  fail(key) {
    const nowMs = Date.now();
    const rec = this.attempts.get(key) || { count: 0, first: nowMs, lockedUntil: 0 };
    if (nowMs - rec.first > WINDOW_MS) { rec.count = 0; rec.first = nowMs; rec.lockedUntil = 0; }
    rec.count += 1;
    if (rec.count >= MAX_FAILS) { rec.lockedUntil = nowMs + LOCK_MS; rec.count = 0; rec.first = nowMs; }
    this.attempts.set(key, rec);
  }
  succeed(key) { this.attempts.delete(key); }
}

// ---- Session tokens ----------------------------------------------------------

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  constantTimeEqualStrings,
  loadCredentials,
  writeCredentialsFile,
  LoginLimiter,
  newSessionToken,
  hashToken,
};
