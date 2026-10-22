'use strict';

/**
 * End-to-end check of the key shop workflow against a live server on a random port,
 * using an in-memory database and throw-away credentials:
 *   log in → add an RO → move forward / backward / skip → block an active duplicate →
 *   view history → complete from QC → find it in the archive → restore it.
 *
 * Run with:  npm test
 *
 * To run the same checks against a running Worker (wrangler dev / a deployment) with an EMPTY
 * database and the login shop / test-password-123:
 *   TEST_BASE_URL=http://127.0.0.1:8787 npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { PHASES } = require('../src/phases');

const USER = 'shop';
const PASS = 'test-password-123';
const quiet = { info() {}, warn() {}, error: console.error };

let server; let base; let cookie = '';

before(async () => {
  if (process.env.TEST_BASE_URL) { base = process.env.TEST_BASE_URL.replace(/\/$/, ''); return; }
  server = createApp({ dbFile: ':memory:', credentials: { username: USER, passwordHash: hashPassword(PASS) }, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && new Promise((r) => server.close(() => { server.store.close(); r(); })));

async function call(method, path, body, { auth = true } = {}) {
  const headers = { 'X-Requested-With': 'ro-workflow' };
  if (auth && cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('phase list is fixed and in the shop order', () => {
  assert.deepEqual(PHASES, ['Inspection', 'Estimate', 'Parts', 'Mechanical', 'Wheel', 'Repair', 'PDR', 'Paint Correction', 'Spot Repair', 'Interior', 'Detail', 'QC']);
});

test('board is protected until login', async () => {
  const r = await call('GET', '/api/board', undefined, { auth: false });
  assert.equal(r.status, 401);
});

test('login rejects wrong password and accepts the shop login', async () => {
  const bad = await call('POST', '/api/login', { username: USER, password: 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/login', { username: 'SHOP', password: PASS }); // username is case-insensitive
  assert.equal(ok.status, 200);
  assert.match(cookie, /^ro_session=/);
  const me = await call('GET', '/api/session');
  assert.equal(me.data.authenticated, true);
});

let roId;

test('add an RO → it starts in Inspection with a created history entry', async () => {
  const r = await call('POST', '/api/ros', { roNumber: '  ro-24117 ', vehicle: '2021 F-150' });
  assert.equal(r.status, 200);
  roId = r.data.ro.id;
  assert.equal(r.data.ro.roNumber, 'RO-24117'); // normalized
  assert.equal(r.data.ro.phase, 'Inspection');
  assert.equal(r.data.history.length, 1);
  assert.equal(r.data.history[0].event, 'created');
  const board = await call('GET', '/api/board');
  assert.equal(board.data.ros.length, 1);
  assert.equal(board.data.counts.active, 1);
});

test('RO number is the only required field', async () => {
  const r = await call('POST', '/api/ros', { roNumber: '' });
  assert.equal(r.status, 400);
  const ok = await call('POST', '/api/ros', { roNumber: 'RO-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ro.vehicle, '');
});

test('move forward, skip ahead, move backward — any phase to any phase', async () => {
  let r = await call('POST', `/api/ros/${roId}/move`, { phase: 'Estimate' });
  assert.equal(r.data.ro.phase, 'Estimate');
  r = await call('POST', `/api/ros/${roId}/move`, { phase: 'Paint Correction' }); // skip 5 phases
  assert.equal(r.data.ro.phase, 'Paint Correction');
  r = await call('POST', `/api/ros/${roId}/move`, { phase: 'Parts' }); // backward
  assert.equal(r.data.ro.phase, 'Parts');
  r = await call('POST', `/api/ros/${roId}/move`, { phase: 'Nowhere' });
  assert.equal(r.status, 400);
  r = await call('POST', `/api/ros/${roId}/move`, { phase: 'Parts' }); // same phase: no-op, no history
  assert.equal(r.data.history.filter((h) => h.event === 'phase_change').length, 3);
});

test('an active duplicate RO number is blocked and the existing card is returned', async () => {
  const r = await call('POST', '/api/ros', { roNumber: 'ro-24117' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'duplicate_active');
  assert.equal(r.data.existing.id, roId);
  assert.equal(r.data.existing.phase, 'Parts');
  assert.match(r.data.message, /already on the board in Parts/);
});

test('history records previous and new phases with timestamps', async () => {
  const r = await call('GET', `/api/ros/${roId}`);
  const events = r.data.history.map((h) => [h.event, h.fromPhase, h.toPhase]);
  assert.deepEqual(events, [
    ['created', null, 'Inspection'],
    ['phase_change', 'Inspection', 'Estimate'],
    ['phase_change', 'Estimate', 'Paint Correction'],
    ['phase_change', 'Paint Correction', 'Parts'],
  ]);
  for (const h of r.data.history) assert.ok(!Number.isNaN(Date.parse(h.at)));
});

test('search finds active ROs by number (partial, case-insensitive)', async () => {
  const r = await call('GET', '/api/search?q=241');
  assert.equal(r.data.results.length, 1);
  assert.equal(r.data.results[0].status, 'active');
});

test('completing requires QC; completing from QC archives the RO', async () => {
  let r = await call('POST', `/api/ros/${roId}/complete`, {});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'not_in_qc');
  await call('POST', `/api/ros/${roId}/move`, { phase: 'QC' });
  const board = await call('GET', '/api/board');
  assert.ok(board.data.ros.some((x) => x.id === roId && x.phase === 'QC'), 'stays visible in QC until marked complete');
  r = await call('POST', `/api/ros/${roId}/complete`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ro.status, 'archived');
  assert.ok(r.data.ro.completedAt);
  const after = await call('GET', '/api/board');
  assert.ok(!after.data.ros.some((x) => x.id === roId), 'removed from the active board');
  assert.equal(after.data.counts.archived, 1);
});

test('archive is searchable and the number can be reused only deliberately', async () => {
  let r = await call('GET', '/api/archive?q=24117');
  assert.equal(r.data.results.length, 1);
  assert.equal(r.data.results[0].id, roId);
  r = await call('GET', '/api/search?q=24117');
  assert.equal(r.data.results[0].status, 'archived');
  r = await call('POST', '/api/ros', { roNumber: 'RO-24117' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'exists_in_archive');
  r = await call('POST', `/api/ros/${roId}/move`, { phase: 'Detail' });
  assert.equal(r.status, 409, 'archived ROs cannot be moved');
});

test('restore puts the archived RO back on the board in Inspection with history', async () => {
  const r = await call('POST', `/api/ros/${roId}/restore`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ro.status, 'active');
  assert.equal(r.data.ro.phase, 'Inspection');
  const last = r.data.history.at(-1);
  assert.equal(last.event, 'restored');
  assert.equal(last.toPhase, 'Inspection');
  assert.equal(r.data.history.at(-2).event, 'completed');
  const board = await call('GET', '/api/board');
  assert.ok(board.data.ros.some((x) => x.id === roId && x.phase === 'Inspection'));
  const arch = await call('GET', '/api/archive');
  assert.equal(arch.data.results.length, 0);
  const again = await call('POST', `/api/ros/${roId}/restore`, {});
  assert.equal(again.status, 409);
});

test('restore is blocked when the number is active again', async () => {
  await call('POST', `/api/ros/${roId}/move`, { phase: 'QC' });
  await call('POST', `/api/ros/${roId}/complete`, {});
  const fresh = await call('POST', '/api/ros', { roNumber: 'RO-24117', allowArchivedDuplicate: true });
  assert.equal(fresh.status, 200);
  const r = await call('POST', `/api/ros/${roId}/restore`, {});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'duplicate_active');
  assert.equal(r.data.existing.id, fresh.data.ro.id);
});

test('editing an RO number is checked against the active board', async () => {
  const other = await call('POST', '/api/ros', { roNumber: 'RO-5' });
  const clash = await call('PATCH', `/api/ros/${other.data.ro.id}`, { roNumber: 'RO-24117' });
  assert.equal(clash.status, 409);
  const ok = await call('PATCH', `/api/ros/${other.data.ro.id}`, { roNumber: 'RO-55', vehicle: 'Silverado' });
  assert.equal(ok.data.ro.roNumber, 'RO-55');
  assert.equal(ok.data.history.at(-1).event, 'edited');
});

test('mutations require the portal headers (CSRF guard) and logout kills the session', async () => {
  const res = await fetch(base + `/api/ros`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 400);
  const out = await call('POST', '/api/logout', {});
  assert.equal(out.status, 200);
  const r = await fetch(base + '/api/board', { headers: { Cookie: 'ro_session=stale' } });
  assert.equal(r.status, 401);
});
