#!/usr/bin/env node
'use strict';

/**
 * Primes Auto — RO Workflow Portal
 * Entry point. Reads a few environment variables (see .env.example / README), opens the
 * SQLite database, and serves the board on PORT (default 8090).
 */

const path = require('node:path');
const { createApp } = require('./src/app');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname, 'data', 'ro-workflow.sqlite');
const CONFIG_DIR = process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(__dirname, 'config');

// Hosted platforms (Railway, Render, Fly.io) terminate HTTPS at their proxy, so default to
// Secure cookies + trusting X-Forwarded-For there unless the variables say otherwise.
const ON_PAAS = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);
const flag = (name, dflt) => (process.env[name] === undefined || process.env[name] === '' ? dflt : /^(1|true|yes)$/i.test(process.env[name]));

const server = createApp({
  dbFile: DB_FILE,
  configDir: CONFIG_DIR,
  secureCookies: flag('COOKIE_SECURE', ON_PAAS),
  trustProxy: flag('TRUST_PROXY', ON_PAAS),
  cacheStatic: process.env.NODE_ENV === 'production',
});

server.listen(PORT, HOST, () => {
  console.log(`RO Workflow portal listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => { server.store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/** Minimal .env loader (KEY=value lines, # comments). Existing env vars win. */
function loadDotEnv(file) {
  let text;
  try { text = require('node:fs').readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
