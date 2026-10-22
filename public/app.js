/* Primes Auto — RO Workflow portal (client)
   Plain JavaScript, no build step. Talks to /api on the same origin. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    phases: [],
    ros: [],           // active ROs
    counts: { active: 0, archived: 0 },
    drawerRoId: null,
    pollTimer: null,
    lastSync: null,
  };

  const els = {
    viewLogin: $('#view-login'),
    viewBoard: $('#view-board'),
    loginForm: $('#login-form'),
    loginError: $('#login-error'),
    setupRequired: $('#setup-required'),
    addForm: $('#add-form'),
    addRo: $('#add-ro'),
    addVehicle: $('#add-vehicle'),
    search: $('#search-input'),
    searchResults: $('#search-results'),
    board: $('#board'),
    activeCount: $('#active-count'),
    archiveCount: $('#archive-count'),
    syncStatus: $('#sync-status'),
    drawer: $('#drawer'),
    drawerBackdrop: $('#drawer-backdrop'),
    archive: $('#archive'),
    archiveBackdrop: $('#archive-backdrop'),
    archiveRows: $('#archive-rows'),
    archiveEmpty: $('#archive-empty'),
    archiveSearch: $('#archive-search'),
    archiveSubtitle: $('#archive-subtitle'),
    toasts: $('#toasts'),
    tplCard: $('#tpl-card'),
  };

  // ---------------------------------------------------------------- API

  async function api(method, path, body) {
    const opts = { method, headers: { 'X-Requested-With': 'ro-workflow' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); }
    catch (_) { throw Object.assign(new Error('Can\'t reach the server. Is the portal running?'), { code: 'network' }); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login' && path !== '/api/session') { showLogin(); }
    if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { code: data.error, status: res.status, data });
    return data;
  }

  // ---------------------------------------------------------------- auth / views

  async function boot() {
    try {
      const s = await api('GET', '/api/session');
      state.phases = s.phases || [];
      if (s.setupRequired) { showLogin(true); return; }
      if (s.authenticated) await showBoard(); else showLogin();
    } catch (err) {
      showLogin();
      toast(err.message, 'error');
    }
  }

  function showLogin(setupRequired = false) {
    stopPolling();
    closeDrawer(); closeArchive();
    els.viewBoard.hidden = true;
    els.viewLogin.hidden = false;
    els.loginForm.hidden = setupRequired;
    els.setupRequired.hidden = !setupRequired;
    els.loginError.hidden = true;
    if (!setupRequired) setTimeout(() => $('#login-username').focus(), 0);
  }

  async function showBoard() {
    els.viewLogin.hidden = true;
    els.viewBoard.hidden = false;
    if (isPhone()) els.search.placeholder = 'Search RO #';
    await refreshBoard();
    startPolling();
    setTimeout(() => els.addRo.focus(), 0);
  }

  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    btn.disabled = true; els.loginError.hidden = true;
    try {
      await api('POST', '/api/login', { username: $('#login-username').value, password: $('#login-password').value });
      $('#login-password').value = '';
      await showBoard();
    } catch (err) {
      els.loginError.textContent = err.message;
      els.loginError.hidden = false;
      $('#login-password').select();
    } finally { btn.disabled = false; }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout', {}); } catch (_) { /* ignore */ }
    showLogin();
  });

  // ---------------------------------------------------------------- board data

  async function refreshBoard({ quiet = false } = {}) {
    try {
      const data = await api('GET', '/api/board');
      state.phases = data.phases;
      state.ros = data.ros;
      state.counts = data.counts;
      state.lastSync = new Date();
      renderBoard();
      els.syncStatus.textContent = `Synced ${fmtTime(state.lastSync)}`;
      els.syncStatus.classList.remove('offline');
    } catch (err) {
      if (err.status === 401) return;
      els.syncStatus.textContent = 'Offline — retrying';
      els.syncStatus.classList.add('offline');
      if (!quiet) toast(err.message, 'error');
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => { if (!document.hidden) refreshBoard({ quiet: true }); }, 15000);
  }
  function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !els.viewBoard.hidden) refreshBoard({ quiet: true }); });
  window.addEventListener('focus', () => { if (!els.viewBoard.hidden) refreshBoard({ quiet: true }); });

  /** Replace one RO in local state and re-render (used after every mutation so the board is instant). */
  function upsertLocal(ro) {
    const i = state.ros.findIndex((r) => r.id === ro.id);
    if (ro.status === 'active') {
      if (i >= 0) state.ros[i] = ro;
      else { state.ros.push(ro); state.counts.active += 1; }
    } else if (i >= 0) {
      state.ros.splice(i, 1);
      state.counts.active = Math.max(0, state.counts.active - 1);
      state.counts.archived += 1;
    }
    renderBoard();
  }

  // ---------------------------------------------------------------- rendering

  function renderBoard() {
    const byPhase = new Map(state.phases.map((p) => [p, []]));
    for (const ro of state.ros) (byPhase.get(ro.phase) || byPhase.get(state.phases[0])).push(ro);
    for (const list of byPhase.values()) list.sort((a, b) => a.phaseSince.localeCompare(b.phaseSince) || a.id - b.id);

    // Build (or reuse) a column per phase so scroll position survives re-renders.
    const existing = new Map($$('.column', els.board).map((c) => [c.dataset.phase, c]));
    state.phases.forEach((phase, idx) => {
      let col = existing.get(phase);
      if (!col) { col = buildColumn(phase, idx); els.board.appendChild(col); }
      const list = byPhase.get(phase);
      const count = $('.column-count', col);
      count.textContent = String(list.length);
      count.classList.toggle('is-zero', list.length === 0);
      const body = $('.column-body', col);
      body.replaceChildren(...(list.length ? list.map(buildCard) : [emptyNode()]));
    });

    els.activeCount.textContent = `${state.counts.active} active`;
    els.archiveCount.textContent = String(state.counts.archived);
    renderPhaseTabs(byPhase);
  }

  // Phone layout: a tab strip that scrolls the board to one phase at a time.
  function renderPhaseTabs(byPhase) {
    const strip = $('#phase-tabs');
    if (!strip) return;
    const existing = new Map($$('.phase-tab', strip).map((t) => [t.dataset.phase, t]));
    state.phases.forEach((phase, idx) => {
      let tab = existing.get(phase);
      if (!tab) {
        tab = document.createElement('button');
        tab.type = 'button'; tab.className = 'phase-tab'; tab.dataset.phase = phase;
        tab.innerHTML = `<span class="n">${String(idx + 1).padStart(2, '0')}</span><span class="name"></span><span class="badge">0</span>`;
        $('.name', tab).textContent = phase;
        tab.addEventListener('click', () => scrollToPhase(phase));
        strip.appendChild(tab);
      }
      $('.badge', tab).textContent = String((byPhase.get(phase) || []).length);
    });
    if (!strip.dataset.bound) {
      strip.dataset.bound = '1';
      let t = null;
      els.board.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(markCurrentPhaseTab, 80); }, { passive: true });
      markCurrentPhaseTab();
    }
  }

  function scrollToPhase(phase) {
    const col = $(`.column[data-phase="${CSS.escape(phase)}"]`, els.board);
    if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }

  function markCurrentPhaseTab() {
    const strip = $('#phase-tabs');
    if (!strip || !strip.offsetParent) return;
    // The current phase is the column whose left edge sits closest to the board's left edge.
    const boardLeft = els.board.getBoundingClientRect().left;
    let current = null; let best = Infinity;
    for (const col of $$('.column', els.board)) {
      const d = Math.abs(col.getBoundingClientRect().left - boardLeft);
      if (d < best) { best = d; current = col.dataset.phase; }
    }
    for (const tab of $$('.phase-tab', strip)) {
      const on = tab.dataset.phase === current;
      tab.setAttribute('aria-current', String(on));
      if (on) tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }

  function emptyNode() {
    const d = document.createElement('div');
    d.className = 'column-empty';
    d.textContent = 'Drop here';
    return d;
  }

  function buildColumn(phase, idx) {
    const col = document.createElement('section');
    col.className = 'column' + (phase === 'QC' ? ' column--qc' : '');
    col.dataset.phase = phase;
    col.setAttribute('aria-label', `${phase} column`);
    col.innerHTML = `
      <div class="column-head">
        <div class="column-title"><span class="column-index">${String(idx + 1).padStart(2, '0')}</span><span class="column-name"></span></div>
        <span class="badge column-count">0</span>
      </div>
      <div class="column-body"></div>`;
    $('.column-name', col).textContent = phase;

    // Drag targets
    col.addEventListener('dragover', (e) => { if (dragRoId !== null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('column--over'); } });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('column--over'); });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('column--over');
      const id = dragRoId !== null ? dragRoId : Number(e.dataTransfer.getData('text/plain'));
      dragRoId = null;
      if (id) await moveRo(id, phase);
    });
    return col;
  }

  let dragRoId = null;

  function buildCard(ro) {
    const node = els.tplCard.content.firstElementChild.cloneNode(true);
    node.dataset.id = ro.id;
    node.setAttribute('aria-label', `${roLabel(ro.roNumber)}, ${ro.phase}`);
    $('.card-ro', node).textContent = ro.roNumber;
    $('.card-vehicle', node).textContent = ro.vehicle || '';
    const age = $('.card-age', node);
    age.textContent = fmtAge(ro.phaseSince);
    age.title = `In ${ro.phase} since ${fmtDateTime(ro.phaseSince)}`;
    if (Date.now() - Date.parse(ro.phaseSince) > 3 * 86400000) age.classList.add('old');

    const select = $('.select--move', node);
    select.replaceChildren(
      opt('', 'Move to…', true),
      ...state.phases.map((p, i) => opt(p, `${i + 1}. ${p}`, false, p === ro.phase)),
    );
    select.value = '';
    select.addEventListener('change', async () => {
      const to = select.value; select.value = '';
      if (to && to !== ro.phase) await moveRo(ro.id, to);
    });
    // Don't let interacting with the select start a drag or open the drawer.
    select.addEventListener('mousedown', (e) => e.stopPropagation());
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('keydown', (e) => e.stopPropagation());

    const complete = $('.btn--complete', node);
    if (ro.phase === 'QC') {
      complete.hidden = false;
      complete.addEventListener('click', (e) => { e.stopPropagation(); completeRo(ro.id); });
    }

    node.addEventListener('click', () => openDrawer(ro.id));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(ro.id); }
    });
    node.addEventListener('dragstart', (e) => {
      dragRoId = ro.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(ro.id));
      node.classList.add('card--dragging');
    });
    node.addEventListener('dragend', () => {
      node.classList.remove('card--dragging');
      dragRoId = null;
      $$('.column--over').forEach((c) => c.classList.remove('column--over'));
    });
    return node;
  }

  function opt(value, label, disabled = false, selected = false) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label; o.disabled = disabled;
    if (selected) { o.textContent = `${label} (current)`; o.disabled = true; }
    return o;
  }

  // ---------------------------------------------------------------- actions

  els.addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const roNumber = els.addRo.value.trim();
    const vehicle = els.addVehicle.value.trim();
    if (!roNumber) { els.addRo.focus(); return; }
    els.addRo.value = ''; els.addVehicle.value = '';
    await createRo({ roNumber, vehicle });
  });

  async function createRo({ roNumber, vehicle, allowArchivedDuplicate = false }) {
    // Not debounced on purpose: a scan or fast typist can fire the next RO before this one lands.
    try {
      const { ro } = await api('POST', '/api/ros', { roNumber, vehicle, allowArchivedDuplicate });
      upsertLocal(ro);
      els.addRo.focus();
      toast(`${roLabel(ro.roNumber)} added to Inspection.`, 'ok');
      flashCard(ro.id, { scroll: true });
    } catch (err) {
      if (err.code === 'duplicate_active' && err.data.existing) {
        const ex = err.data.existing;
        upsertLocal(ex);
        toast(`${roLabel(ex.roNumber)} is already on the board in ${ex.phase}.`, 'error', { label: 'Open', onClick: () => openDrawer(ex.id) });
        flashCard(ex.id, { scroll: true });
        openDrawer(ex.id);
        if (!els.addRo.value) { els.addRo.value = roNumber; els.addVehicle.value = vehicle || ''; }
      } else if (err.code === 'exists_in_archive' && err.data.archived) {
        const ar = err.data.archived;
        toast(`${roLabel(ar.roNumber)} is in the archive (completed ${fmtDateTime(ar.completedAt)}). Restore it, or start a new RO with that number.`, 'error', [
          { label: 'Restore', onClick: () => restoreRo(ar.id) },
          { label: 'New RO', onClick: () => createRo({ roNumber, vehicle, allowArchivedDuplicate: true }) },
        ], 12000);
      } else {
        toast(err.message, 'error');
        if (!els.addRo.value) { els.addRo.value = roNumber; els.addVehicle.value = vehicle || ''; }
      }
    }
  }

  async function moveRo(id, phase) {
    try {
      const { ro, history } = await api('POST', `/api/ros/${id}/move`, { phase });
      upsertLocal(ro);
      if (state.drawerRoId === id) renderDrawer(ro, history);
      flashCard(ro.id, { scroll: isPhone() });
    } catch (err) { toast(err.message, 'error'); refreshBoard({ quiet: true }); }
  }

  async function completeRo(id) {
    try {
      const { ro, history } = await api('POST', `/api/ros/${id}/complete`, {});
      upsertLocal(ro);
      if (state.drawerRoId === id) renderDrawer(ro, history);
      toast(`${roLabel(ro.roNumber)} marked complete and archived.`, 'ok', { label: 'Undo', onClick: () => restoreRo(ro.id) });
    } catch (err) { toast(err.message, 'error'); }
  }

  async function restoreRo(id) {
    try {
      const { ro, history } = await api('POST', `/api/ros/${id}/restore`, {});
      upsertLocal(ro);
      state.counts.archived = Math.max(0, state.counts.archived - 1);
      renderBoard();
      if (state.drawerRoId === id) renderDrawer(ro, history);
      if (!els.archive.hidden) loadArchive();
      toast(`${roLabel(ro.roNumber)} restored to Inspection.`, 'ok');
      flashCard(ro.id, { scroll: true });
    } catch (err) {
      if (err.code === 'duplicate_active' && err.data.existing) {
        toast(err.message, 'error', { label: 'Open', onClick: () => openDrawer(err.data.existing.id) });
      } else toast(err.message, 'error');
    }
  }

  function flashCard(id, { scroll = false } = {}) {
    const card = $(`.card[data-id="${id}"]`, els.board);
    if (!card) return;
    if (scroll) card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    card.classList.remove('card--flash'); void card.offsetWidth; card.classList.add('card--flash');
  }

  // ---------------------------------------------------------------- drawer

  async function openDrawer(id) {
    state.drawerRoId = id;
    els.drawer.hidden = false; els.drawerBackdrop.hidden = false;
    try {
      const { ro, history } = await api('GET', `/api/ros/${id}`);
      renderDrawer(ro, history);
      setTimeout(() => $('#drawer-close').focus(), 0);
    } catch (err) { toast(err.message, 'error'); closeDrawer(); }
  }

  function closeDrawer() {
    state.drawerRoId = null;
    els.drawer.hidden = true; els.drawerBackdrop.hidden = true;
  }
  $('#drawer-close').addEventListener('click', closeDrawer);
  els.drawerBackdrop.addEventListener('click', closeDrawer);

  function renderDrawer(ro, history) {
    const archived = ro.status === 'archived';
    const status = $('#drawer-status');
    status.textContent = archived ? 'Archived · completed' : `Active · ${ro.phase}`;
    status.classList.toggle('archived', archived);
    $('#drawer-title').textContent = `${roLabel(ro.roNumber)}`;
    $('#drawer-vehicle').textContent = ro.vehicle || 'No vehicle noted';
    $('#drawer-phase-current').textContent = archived ? '(archived — restore to move)' : '';

    const grid = $('#drawer-phase-grid');
    grid.replaceChildren(...state.phases.map((p, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'phase-btn';
      b.innerHTML = `<span class="n">${String(i + 1).padStart(2, '0')}</span><span></span>`;
      b.lastElementChild.textContent = p;
      b.setAttribute('aria-pressed', String(p === ro.phase));
      b.disabled = archived;
      if (p !== ro.phase && !archived) b.addEventListener('click', () => moveRo(ro.id, p));
      return b;
    }));

    const actions = $('#drawer-actions');
    actions.replaceChildren();
    if (archived) {
      actions.append(btn('Restore to board', 'btn--ok', () => restoreRo(ro.id)));
      actions.append(note('Restoring puts this RO back in Inspection and keeps its full history.'));
    } else if (ro.phase === 'QC') {
      actions.append(btn('Mark complete', 'btn--ok', () => completeRo(ro.id)));
      actions.append(note('Completing removes the RO from the board and files it in the archive.'));
    } else {
      actions.append(note('Move the RO to QC to mark it complete.'));
    }

    $('#edit-ro').value = ro.roNumber;
    $('#edit-vehicle').value = ro.vehicle || '';
    $('#drawer-created').textContent = fmtDateTime(ro.createdAt);
    $('#drawer-since').textContent = `${fmtDateTime(ro.phaseSince)} (${fmtAge(ro.phaseSince)})`;
    $('#drawer-since-row').hidden = archived;
    $('#drawer-completed-row').hidden = !archived;
    $('#drawer-completed').textContent = archived ? fmtDateTime(ro.completedAt) : '';

    const list = $('#drawer-history');
    list.replaceChildren(...history.slice().reverse().map((h) => {
      const li = document.createElement('li');
      li.className = h.event;
      const what = document.createElement('div'); what.className = 'history-what';
      what.innerHTML = historyLabel(h);
      const when = document.createElement('div'); when.className = 'history-when';
      when.textContent = fmtDateTime(h.at);
      li.append(what, when);
      if (h.detail) { const d = document.createElement('div'); d.className = 'history-detail'; d.textContent = h.detail; li.append(d); }
      return li;
    }));
  }

  function historyLabel(h) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    switch (h.event) {
      case 'created': return `Created in <b>${esc(h.toPhase)}</b>`;
      case 'phase_change': return `${esc(h.fromPhase)}<span class="arrow">→</span><b>${esc(h.toPhase)}</b>`;
      case 'completed': return `Marked <b>complete</b> from ${esc(h.fromPhase)} · archived`;
      case 'restored': return `<b>Restored</b> to ${esc(h.toPhase)}`;
      case 'edited': return 'Details edited';
      default: return esc(h.event);
    }
  }

  function btn(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn ${cls || ''}`.trim(); b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function note(text) { const p = document.createElement('p'); p.className = 'action-note'; p.textContent = text; return p; }

  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.drawerRoId === null) return;
    try {
      const { ro, history } = await api('PATCH', `/api/ros/${state.drawerRoId}`, { roNumber: $('#edit-ro').value, vehicle: $('#edit-vehicle').value });
      upsertLocal(ro);
      renderDrawer(ro, history);
      toast('Saved.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });

  // ---------------------------------------------------------------- search

  let searchTimer = null;
  let searchSel = -1;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = els.search.value.trim();
    if (!q) { hideSearch(); return; }
    searchTimer = setTimeout(() => runSearch(q), 120);
  });
  els.search.addEventListener('focus', () => { if (els.search.value.trim()) runSearch(els.search.value.trim()); });
  els.search.addEventListener('keydown', (e) => {
    const items = $$('.search-item', els.searchResults);
    if (e.key === 'Escape') { hideSearch(); els.search.blur(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); searchSel = Math.min(items.length - 1, searchSel + 1); markSel(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); searchSel = Math.max(0, searchSel - 1); markSel(items); }
    else if (e.key === 'Enter') { e.preventDefault(); (items[searchSel] || items[0]).click(); }
  });
  document.addEventListener('click', (e) => { if (!$('#search').contains(e.target)) hideSearch(); });

  function markSel(items) { items.forEach((it, i) => it.setAttribute('aria-selected', String(i === searchSel))); }
  function hideSearch() { els.searchResults.hidden = true; els.search.setAttribute('aria-expanded', 'false'); searchSel = -1; }

  async function runSearch(q) {
    try {
      const { results } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      const frag = document.createDocumentFragment();
      const active = results.filter((r) => r.status === 'active');
      const archived = results.filter((r) => r.status === 'archived');
      const group = (title, rows) => {
        if (!rows.length) return;
        const g = document.createElement('div'); g.className = 'search-group'; g.textContent = `${title} (${rows.length})`;
        frag.append(g);
        for (const r of rows) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'search-item'; b.setAttribute('role', 'option');
          b.innerHTML = `<span class="ro"></span><span class="veh"></span><span class="where"></span>`;
          $('.ro', b).textContent = r.roNumber;
          $('.veh', b).textContent = r.vehicle || '';
          const w = $('.where', b);
          w.textContent = r.status === 'active' ? r.phase : `Archived ${fmtDate(r.completedAt)}`;
          w.classList.toggle('archived', r.status !== 'active');
          b.addEventListener('click', () => {
            hideSearch();
            if (r.status === 'active') { flashCard(r.id, { scroll: true }); }
            openDrawer(r.id);
          });
          frag.append(b);
        }
      };
      group('On the board', active);
      group('Archive', archived);
      if (!results.length) { const d = document.createElement('div'); d.className = 'search-empty'; d.textContent = `No RO matching "${q}".`; frag.append(d); }
      els.searchResults.replaceChildren(frag);
      els.searchResults.hidden = false;
      els.search.setAttribute('aria-expanded', 'true');
      searchSel = -1;
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------------------------------------------------------------- archive

  $('#btn-archive').addEventListener('click', openArchive);
  $('#archive-close').addEventListener('click', closeArchive);
  els.archiveBackdrop.addEventListener('click', closeArchive);
  let archiveTimer = null;
  els.archiveSearch.addEventListener('input', () => { clearTimeout(archiveTimer); archiveTimer = setTimeout(loadArchive, 120); });

  function openArchive() {
    els.archive.hidden = false; els.archiveBackdrop.hidden = false;
    loadArchive();
    setTimeout(() => els.archiveSearch.focus(), 0);
  }
  function closeArchive() { els.archive.hidden = true; els.archiveBackdrop.hidden = true; }

  async function loadArchive() {
    try {
      const q = els.archiveSearch.value.trim();
      const { results, counts } = await api('GET', `/api/archive?q=${encodeURIComponent(q)}`);
      state.counts = counts; els.archiveCount.textContent = String(counts.archived);
      els.archiveSubtitle.textContent = q ? `${results.length} match${results.length === 1 ? '' : 'es'} for "${q}"` : `${counts.archived} completed`;
      els.archiveRows.replaceChildren(...results.map((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="ro"></td><td class="veh"></td><td class="when"></td><td class="actions"></td>`;
        $('.ro', tr).textContent = r.roNumber;
        $('.veh', tr).textContent = r.vehicle || '—';
        $('.when', tr).textContent = fmtDateTime(r.completedAt);
        $('.actions', tr).append(
          btn('History', 'btn--small', () => openDrawer(r.id)),
          btn('Restore', 'btn--small btn--ok', () => restoreRo(r.id)),
        );
        return tr;
      }));
      els.archiveEmpty.hidden = results.length > 0;
      els.archiveEmpty.textContent = q ? `No archived RO matching "${q}".` : 'Nothing in the archive yet.';
      $('#archive-table').hidden = results.length === 0;
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------------------------------------------------------------- keyboard shortcuts

  document.addEventListener('keydown', (e) => {
    if (els.viewBoard.hidden) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (!els.drawer.hidden) closeDrawer();
      else if (!els.archive.hidden) closeArchive();
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); els.search.focus(); els.search.select(); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault(); els.addRo.focus(); }
  });

  // ---------------------------------------------------------------- toasts

  function toast(message, kind = 'info', actions = null, ttl = 6000) {
    const t = document.createElement('div');
    t.className = `toast toast--${kind}`;
    const msg = document.createElement('span'); msg.className = 'toast-msg'; msg.textContent = message;
    t.append(msg);
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    for (const a of list) t.append(btn(a.label, 'btn--small', () => { a.onClick(); t.remove(); }));
    els.toasts.append(t);
    while (els.toasts.children.length > (isPhone() ? 2 : 4)) els.toasts.firstElementChild.remove();
    setTimeout(() => t.remove(), ttl);
  }

  function isPhone() { return window.matchMedia('(max-width: 900px)').matches; }

  // ---------------------------------------------------------------- formatting

  /** "RO 1234" for plain numbers; don't double up when the shop already writes "RO-1234". */
  function roLabel(number) { return /^RO\b/i.test(number) ? number : `RO ${number}`; }

  function fmtAge(iso) {
    const ms = Math.max(0, Date.now() - Date.parse(iso));
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return d < 14 ? `${d}d ${h % 24}h` : `${d}d`;
  }
  const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const tf = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  function fmtDateTime(iso) { return iso ? dtf.format(new Date(iso)) : '—'; }
  function fmtDate(iso) { return iso ? df.format(new Date(iso)) : '—'; }
  function fmtTime(d) { return tf.format(d); }

  // Keep "time in phase" fresh without a full refresh.
  setInterval(() => {
    if (els.viewBoard.hidden) return;
    for (const card of $$('.card', els.board)) {
      const ro = state.ros.find((r) => r.id === Number(card.dataset.id));
      if (ro) $('.card-age', card).textContent = fmtAge(ro.phaseSince);
    }
  }, 60000);

  boot();
})();
