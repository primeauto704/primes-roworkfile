'use strict';

/**
 * The API, independent of how HTTP arrives. Both entry points use this:
 *   - src/app.js      Node's http module + SQLite file   (shop PC, Docker, Railway)
 *   - worker/index.js Cloudflare Worker + D1             (Cloudflare)
 *
 * A transport builds a `ctx` per request:
 *   ctx.method, ctx.url (URL), ctx.params, ctx.session (session token hash or null)
 *   ctx.header(name)      → request header value or ''
 *   ctx.json()            → Promise<object> parsed body (throws AppError 400 on bad JSON)
 *   ctx.clientKey()       → string used for login throttling
 *   ctx.setCookie(value)  → queue a Set-Cookie header
 * Store methods may be sync (SQLite) or async (D1); everything is awaited.
 */

const { AppError } = require('./errors');
const { PHASES } = require('./phases');
const auth = require('./auth');

const SESSION_COOKIE = 'ro_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

function sessionCookie(value, maxAgeSec, secure) {
  const attrs = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function parseCookies(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Mutating requests must come from our own script: JSON body + custom header, on top of the SameSite cookie. */
function requireJsonRequest(ctx) {
  const ct = String(ctx.header('content-type') || '');
  if (!ct.startsWith('application/json') || ctx.header('x-requested-with') !== 'ro-workflow') {
    throw new AppError(400, 'bad_request', 'Expected a JSON request from the portal.');
  }
}

/**
 * Build the route table.
 *   store        data access (Store or D1Store)
 *   credentials  { username, passwordHash } | { username, password } | null
 *   limiter      LoginLimiter
 *   secureCookies  set the cookie Secure flag
 *   log          { info, warn, error }
 */
function createRoutes({ store, getCredentials, limiter, secureCookies, log }) {
  const routes = [];
  function route(method, pattern, handler, { auth: needsAuth = true } = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, needsAuth });
  }

  route('GET', '/api/session', (ctx) => {
    const credentials = getCredentials();
    return { authenticated: Boolean(ctx.session), setupRequired: !credentials, username: ctx.session ? credentials.username : null, phases: PHASES };
  }, { auth: false });

  route('POST', '/api/login', async (ctx) => {
    requireJsonRequest(ctx);
    const credentials = getCredentials();
    if (!credentials) throw new AppError(503, 'setup_required', 'The shop login has not been set up yet. Run `npm run setup` on the server (or set SHOP_USERNAME and SHOP_PASSWORD).');
    const key = ctx.clientKey();
    const gate = limiter.check(key);
    if (!gate.allowed) throw new AppError(429, 'locked_out', `Too many failed logins. Try again in ${gate.retryAfterSec} seconds.`);
    const body = await ctx.json();
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const userOk = auth.constantTimeEqualStrings(username.toLowerCase(), credentials.username.toLowerCase());
    const passOk = credentials.passwordHash
      ? auth.verifyPassword(password, credentials.passwordHash)
      : auth.constantTimeEqualStrings(password, credentials.password);
    if (!(userOk && passOk)) {
      limiter.fail(key);
      throw new AppError(401, 'bad_credentials', 'Wrong username or password.');
    }
    limiter.succeed(key);
    const token = auth.newSessionToken();
    await store.createSession(auth.hashToken(token), SESSION_TTL_MS);
    await store.purgeExpiredSessions();
    ctx.setCookie(sessionCookie(token, SESSION_TTL_MS / 1000, secureCookies));
    return { ok: true, username: credentials.username };
  }, { auth: false });

  route('POST', '/api/logout', async (ctx) => {
    if (ctx.session) await store.deleteSession(ctx.session);
    ctx.setCookie(sessionCookie('', 0, secureCookies));
    return { ok: true };
  }, { auth: false });

  route('GET', '/api/board', async () => {
    const ros = await store.listActive();
    return { phases: PHASES, ros, counts: await store.counts(), serverTime: new Date().toISOString() };
  });

  route('GET', '/api/ros/:id', async (ctx) => {
    const ro = await store.getRo(Number(ctx.params.id));
    if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
    return { ro, history: await store.history(ro.id) };
  });

  route('POST', '/api/ros', async (ctx) => {
    requireJsonRequest(ctx);
    const body = await ctx.json();
    const ro = await store.createRo({ roNumber: body.roNumber, vehicle: body.vehicle, allowArchivedDuplicate: body.allowArchivedDuplicate === true });
    log.info(`[ro] created ${ro.roNumber} (#${ro.id})`);
    return { ro, history: await store.history(ro.id) };
  });

  route('POST', '/api/ros/:id/move', async (ctx) => {
    requireJsonRequest(ctx);
    const body = await ctx.json();
    const ro = await store.moveRo(Number(ctx.params.id), body.phase);
    log.info(`[ro] ${ro.roNumber} → ${ro.phase}`);
    return { ro, history: await store.history(ro.id) };
  });

  route('POST', '/api/ros/:id/complete', async (ctx) => {
    requireJsonRequest(ctx);
    const ro = await store.completeRo(Number(ctx.params.id));
    log.info(`[ro] ${ro.roNumber} completed → archive`);
    return { ro, history: await store.history(ro.id) };
  });

  route('POST', '/api/ros/:id/restore', async (ctx) => {
    requireJsonRequest(ctx);
    const ro = await store.restoreRo(Number(ctx.params.id));
    log.info(`[ro] ${ro.roNumber} restored → ${ro.phase}`);
    return { ro, history: await store.history(ro.id) };
  });

  route('PATCH', '/api/ros/:id', async (ctx) => {
    requireJsonRequest(ctx);
    const body = await ctx.json();
    const ro = await store.editRo(Number(ctx.params.id), { roNumber: body.roNumber, vehicle: body.vehicle });
    return { ro, history: await store.history(ro.id) };
  });

  route('GET', '/api/search', async (ctx) => {
    const q = ctx.url.searchParams.get('q') || '';
    return { query: q, results: await store.search(q, 50) };
  });

  route('GET', '/api/archive', async (ctx) => {
    const q = ctx.url.searchParams.get('q') || '';
    return { query: q, results: await store.listArchived(q, 300), counts: await store.counts() };
  });

  /** Resolve the session from the Cookie header (sliding expiry). */
  async function sessionFromCookie(cookieHeader) {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!token) return null;
    const hash = auth.hashToken(token);
    return (await store.touchSession(hash, SESSION_TTL_MS)) ? hash : null;
  }

  /** Dispatch one API request. Returns { status, body } (body is a plain object). */
  async function dispatch(ctx) {
    try {
      for (const r of routes) {
        const m = r.method === ctx.method && ctx.url.pathname.match(r.re);
        if (!m) continue;
        if (r.needsAuth && !ctx.session) throw new AppError(401, 'unauthenticated', 'Please log in.');
        ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = await r.handler(ctx);
        return { status: 200, body };
      }
      throw new AppError(404, 'not_found', `No route for ${ctx.method} ${ctx.url.pathname}.`);
    } catch (err) {
      if (err instanceof AppError) return { status: err.status, body: { error: err.code, message: err.message, ...(err.extra || {}) } };
      log.error('[api] unexpected error:', err);
      return { status: 500, body: { error: 'internal', message: 'Something went wrong on the server.' } };
    }
  }

  return { dispatch, sessionFromCookie };
}

module.exports = { createRoutes, SESSION_COOKIE, SESSION_TTL_MS, parseCookies };
