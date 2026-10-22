'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./db');
const { AppError } = require('./errors');
const { createRoutes } = require('./routes');
const auth = require('./auth');

const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

/**
 * Build the Node HTTP server (plain `http`, no framework, no native modules).
 * The API itself lives in src/routes.js; this file only adapts Node's req/res to it
 * and serves the static front end.
 *
 * options:
 *   dbFile      path to the SQLite file (or ':memory:' for tests)
 *   configDir   folder holding credentials.json
 *   publicDir   static assets
 *   credentials optional { username, passwordHash } (otherwise loaded from env/config)
 *   secureCookies  set the cookie Secure flag (true when served over HTTPS)
 *   trustProxy  use X-Forwarded-For for login throttling
 *   log         logger with info/warn/error
 */
function createApp(options = {}) {
  const log = options.log || console;
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const configDir = options.configDir || path.join(__dirname, '..', 'config');
  const store = new Store(options.dbFile || path.join(__dirname, '..', 'data', 'ro-workflow.sqlite'));
  const limiter = new auth.LoginLimiter();
  const trustProxy = Boolean(options.trustProxy);

  let credentials = options.credentials || auth.loadCredentials({ configDir, env: options.env || process.env, log });
  if (credentials) log.info(`[auth] Shop login loaded from ${credentials.source || 'options'} (user "${credentials.username}").`);
  else log.warn('[auth] No shop login configured yet. Run: npm run setup   (the portal will show setup instructions until then)');

  const api = createRoutes({
    store,
    getCredentials: () => credentials,
    limiter,
    secureCookies: Boolean(options.secureCookies),
    log,
  });

  // ---- static files ----------------------------------------------------------

  const staticCache = new Map();
  function readStatic(rel) {
    const abs = path.join(publicDir, rel);
    if (!abs.startsWith(publicDir)) return null;
    if (options.cacheStatic && staticCache.has(abs)) return staticCache.get(abs);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      const body = fs.readFileSync(abs);
      const entry = { body, type: MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' };
      if (options.cacheStatic) staticCache.set(abs, entry);
      return entry;
    } catch (_) {
      return null;
    }
  }

  // ---- request adapter ---------------------------------------------------------

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { reject(new AppError(413, 'too_large', 'Request body too large.')); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new AppError(400, 'bad_json', 'Body must be valid JSON.')); }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, body, cookies) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS };
    if (cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const cookies = [];
      const ctx = {
        method: req.method,
        url,
        params: {},
        session: await api.sessionFromCookie(req.headers.cookie),
        header: (name) => req.headers[name.toLowerCase()] || '',
        json: () => readJson(req),
        clientKey: () => {
          const fwd = trustProxy && req.headers['x-forwarded-for'];
          return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
        },
        setCookie: (value) => cookies.push(value),
      };
      const { status, body } = await api.dispatch(ctx);
      return sendJson(res, status, body, cookies);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Method not allowed');
    }

    // Static front-end. The app shell is public; all data sits behind /api and the session.
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    rel = path.normalize(rel);
    const file = readStatic(rel) || (path.extname(rel) ? null : readStatic('index.html'));
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Security-Policy': CSP,
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  });

  server.store = store;
  server.setCredentials = (c) => { credentials = c; };
  return server;
}

module.exports = { createApp };
