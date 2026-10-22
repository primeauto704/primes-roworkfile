/**
 * Cloudflare Worker entry point.
 *
 * Same API as the Node server (src/routes.js), backed by D1 instead of a SQLite file,
 * with the front end in public/ served as static assets. Nothing else changes.
 *
 * Bindings / variables (see wrangler.toml and .dev.vars.example):
 *   DB             D1 database
 *   ASSETS         static assets (public/)
 *   SHOP_USERNAME  shop login username
 *   SHOP_PASSWORD  shop login password (secret)        — recommended on Cloudflare
 *   SHOP_PASSWORD_HASH  scrypt hash from `npm run setup -- --hash-only` — alternative; scrypt costs
 *                  ~100 ms of CPU per login, which only fits the Workers Paid plan (free = 10 ms)
 */
import { createRoutes } from '../src/routes.js';
import { D1Store } from '../src/d1-store.js';
import { LoginLimiter } from '../src/auth.js';
import { AppError } from '../src/errors.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const MAX_BODY_BYTES = 64 * 1024;

// Per-isolate state. The limiter is best-effort on Workers (each isolate keeps its own counts).
const limiter = new LoginLimiter();
const log = { info: () => {}, warn: console.warn, error: console.error };

function credentialsFrom(env) {
  const username = (env.SHOP_USERNAME || '').trim();
  if (!username) return null;
  if (env.SHOP_PASSWORD_HASH) return { username, passwordHash: String(env.SHOP_PASSWORD_HASH).trim() };
  if (env.SHOP_PASSWORD) return { username, password: String(env.SHOP_PASSWORD) };
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (!env.DB) return json(500, { error: 'no_database', message: 'No D1 database is bound to this Worker (binding "DB").' });
      const store = new D1Store(env.DB);
      await store.ensureSchema();
      const api = createRoutes({ store, getCredentials: () => credentialsFrom(env), limiter, secureCookies: true, log });

      const cookies = [];
      const ctx = {
        method: request.method,
        url,
        params: {},
        session: await api.sessionFromCookie(request.headers.get('cookie') || ''),
        header: (name) => request.headers.get(name) || '',
        json: async () => {
          const len = Number(request.headers.get('content-length') || 0);
          if (len > MAX_BODY_BYTES) throw new AppError(413, 'too_large', 'Request body too large.');
          const text = await request.text();
          if (!text) return {};
          try { return JSON.parse(text); } catch (_) { throw new AppError(400, 'bad_json', 'Body must be valid JSON.'); }
        },
        clientKey: () => request.headers.get('cf-connecting-ip') || 'unknown',
        setCookie: (value) => cookies.push(value),
      };
      const { status, body } = await api.dispatch(ctx);
      return json(status, body, cookies);
    }

    // Everything else is the front end. With not_found_handling = "single-page-application",
    // unknown paths get index.html so deep links and reloads work.
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    if ((headers.get('content-type') || '').startsWith('text/html')) {
      headers.set('Content-Security-Policy', CSP);
      headers.set('Cache-Control', 'no-cache');
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};

function json(status, body, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}
