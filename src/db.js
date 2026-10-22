'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PHASES, FIRST_PHASE, FINAL_PHASE, isPhase } = require('./phases');
const { AppError } = require('./errors');
const { SCHEMA_STATEMENTS, now, normalizeRoNumber, roLabel, normalizeText, escapeLike, rowToRo, rowToHistory } = require('./model');

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  return db;
}

/**
 * All data access lives here. Every mutating method is wrapped in a transaction
 * so an RO row and its history entry are always written together.
 */
class Store {
  constructor(file) {
    this.db = openDatabase(file);
    const d = this.db;
    this.stmts = {
      insertRo: d.prepare(`INSERT INTO repair_orders
        (ro_number, vehicle, phase, status, created_at, updated_at, phase_since)
        VALUES (?, ?, ?, 'active', ?, ?, ?)`),
      insertHistory: d.prepare(`INSERT INTO ro_history (ro_id, event, from_phase, to_phase, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      getById: d.prepare(`SELECT * FROM repair_orders WHERE id = ?`),
      getActiveByNumber: d.prepare(`SELECT * FROM repair_orders WHERE ro_number = ? AND status = 'active'`),
      latestArchivedByNumber: d.prepare(`SELECT * FROM repair_orders
        WHERE ro_number = ? AND status = 'archived' ORDER BY completed_at DESC LIMIT 1`),
      listActive: d.prepare(`SELECT * FROM repair_orders WHERE status = 'active' ORDER BY phase_since ASC, id ASC`),
      listArchived: d.prepare(`SELECT * FROM repair_orders WHERE status = 'archived'
        AND (? = '' OR ro_number LIKE ? ESCAPE '\\') ORDER BY completed_at DESC LIMIT ?`),
      search: d.prepare(`SELECT * FROM repair_orders WHERE ro_number LIKE ? ESCAPE '\\'
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, ro_number ASC, completed_at DESC LIMIT ?`),
      history: d.prepare(`SELECT * FROM ro_history WHERE ro_id = ? ORDER BY id ASC`),
      setPhase: d.prepare(`UPDATE repair_orders SET phase = ?, phase_since = ?, updated_at = ? WHERE id = ?`),
      complete: d.prepare(`UPDATE repair_orders SET status = 'archived', completed_at = ?, updated_at = ? WHERE id = ?`),
      restore: d.prepare(`UPDATE repair_orders SET status = 'active', phase = ?, phase_since = ?, completed_at = NULL, updated_at = ? WHERE id = ?`),
      edit: d.prepare(`UPDATE repair_orders SET ro_number = ?, vehicle = ?, updated_at = ? WHERE id = ?`),
      counts: d.prepare(`SELECT status, COUNT(*) AS n FROM repair_orders GROUP BY status`),
      // sessions
      insertSession: d.prepare(`INSERT INTO sessions (token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)`),
      getSession: d.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?`),
      touchSession: d.prepare(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?`),
      deleteSession: d.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
      purgeSessions: d.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),
    };
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    }
  }

  // ---- Repair orders -------------------------------------------------------

  getRo(id) {
    return rowToRo(this.stmts.getById.get(id));
  }

  getActiveByNumber(roNumber) {
    return rowToRo(this.stmts.getActiveByNumber.get(normalizeRoNumber(roNumber)));
  }

  listActive() {
    return this.stmts.listActive.all().map(rowToRo);
  }

  listArchived(query = '', limit = 200) {
    const q = normalizeRoNumber(query);
    const like = q ? `%${escapeLike(q)}%` : '%';
    return this.stmts.listArchived.all(q, like, limit).map(rowToRo);
  }

  search(query, limit = 50) {
    const q = normalizeRoNumber(query);
    if (!q) return [];
    return this.stmts.search.all(`%${escapeLike(q)}%`, limit).map(rowToRo);
  }

  history(id) {
    return this.stmts.history.all(id).map(rowToHistory);
  }

  counts() {
    const out = { active: 0, archived: 0 };
    for (const row of this.stmts.counts.all()) out[row.status] = row.n;
    return out;
  }

  /**
   * Create an RO in Inspection. Refuses to duplicate an ACTIVE RO number (409 with the
   * existing card). If the number only exists in the archive, the caller may either
   * restore that one or pass { allowArchivedDuplicate: true } to start a fresh RO.
   */
  createRo({ roNumber, vehicle = '', allowArchivedDuplicate = false }) {
    const number = normalizeRoNumber(roNumber);
    if (!number) throw new AppError(400, 'ro_number_required', 'RO number is required.');
    if (number.length > 40) throw new AppError(400, 'ro_number_too_long', 'RO number is too long (40 characters max).');
    const veh = normalizeText(vehicle, 120);

    return this.transaction(() => {
      const existing = rowToRo(this.stmts.getActiveByNumber.get(number));
      if (existing) {
        throw new AppError(409, 'duplicate_active', `${roLabel(number)} is already on the board in ${existing.phase}.`, { existing });
      }
      const archived = rowToRo(this.stmts.latestArchivedByNumber.get(number));
      if (archived && !allowArchivedDuplicate) {
        throw new AppError(409, 'exists_in_archive', `${roLabel(number)} was completed on ${archived.completedAt}. Restore it, or start a new RO with the same number.`, { archived });
      }
      const ts = now();
      const { lastInsertRowid } = this.stmts.insertRo.run(number, veh, FIRST_PHASE, ts, ts, ts);
      this.stmts.insertHistory.run(lastInsertRowid, 'created', null, FIRST_PHASE, veh ? `Vehicle: ${veh}` : null, ts);
      return rowToRo(this.stmts.getById.get(lastInsertRowid));
    });
  }

  /** Move an active RO directly to any phase — forward, backward, or skipping phases. */
  moveRo(id, toPhase) {
    if (!isPhase(toPhase)) throw new AppError(400, 'invalid_phase', `Unknown phase "${toPhase}".`);
    return this.transaction(() => {
      const ro = rowToRo(this.stmts.getById.get(id));
      if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
      if (ro.status !== 'active') throw new AppError(409, 'not_active', `${roLabel(ro.roNumber)} is archived. Restore it first.`);
      if (ro.phase === toPhase) return ro; // no-op, no history noise
      const ts = now();
      this.stmts.setPhase.run(toPhase, ts, ts, id);
      this.stmts.insertHistory.run(id, 'phase_change', ro.phase, toPhase, null, ts);
      return rowToRo(this.stmts.getById.get(id));
    });
  }

  /** Mark complete from QC: leaves the active board and goes to the searchable archive. */
  completeRo(id) {
    return this.transaction(() => {
      const ro = rowToRo(this.stmts.getById.get(id));
      if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
      if (ro.status !== 'active') throw new AppError(409, 'not_active', `${roLabel(ro.roNumber)} is already archived.`);
      if (ro.phase !== FINAL_PHASE) {
        throw new AppError(409, 'not_in_qc', `${roLabel(ro.roNumber)} must be in ${FINAL_PHASE} before it can be marked complete (currently ${ro.phase}).`);
      }
      const ts = now();
      this.stmts.complete.run(ts, ts, id);
      this.stmts.insertHistory.run(id, 'completed', FINAL_PHASE, null, null, ts);
      return rowToRo(this.stmts.getById.get(id));
    });
  }

  /** Put an archived RO back on the active board, starting over in Inspection. */
  restoreRo(id) {
    return this.transaction(() => {
      const ro = rowToRo(this.stmts.getById.get(id));
      if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
      if (ro.status !== 'archived') throw new AppError(409, 'not_archived', `${roLabel(ro.roNumber)} is already on the board.`);
      const clash = rowToRo(this.stmts.getActiveByNumber.get(ro.roNumber));
      if (clash) {
        throw new AppError(409, 'duplicate_active', `${roLabel(ro.roNumber)} is already on the board in ${clash.phase}.`, { existing: clash });
      }
      const ts = now();
      this.stmts.restore.run(FIRST_PHASE, ts, ts, id);
      this.stmts.insertHistory.run(id, 'restored', null, FIRST_PHASE, null, ts);
      return rowToRo(this.stmts.getById.get(id));
    });
  }

  /** Fix a typo in the RO number or update the vehicle note. */
  editRo(id, { roNumber, vehicle }) {
    return this.transaction(() => {
      const ro = rowToRo(this.stmts.getById.get(id));
      if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
      const number = roNumber === undefined ? ro.roNumber : normalizeRoNumber(roNumber);
      const veh = vehicle === undefined ? ro.vehicle : normalizeText(vehicle, 120);
      if (!number) throw new AppError(400, 'ro_number_required', 'RO number is required.');
      if (number.length > 40) throw new AppError(400, 'ro_number_too_long', 'RO number is too long (40 characters max).');
      if (number === ro.roNumber && veh === ro.vehicle) return ro;
      if (number !== ro.roNumber && ro.status === 'active') {
        const clash = rowToRo(this.stmts.getActiveByNumber.get(number));
        if (clash) throw new AppError(409, 'duplicate_active', `${roLabel(number)} is already on the board in ${clash.phase}.`, { existing: clash });
      }
      const ts = now();
      this.stmts.edit.run(number, veh, ts, id);
      const changes = [];
      if (number !== ro.roNumber) changes.push(`RO number ${ro.roNumber} → ${number}`);
      if (veh !== ro.vehicle) changes.push(`Vehicle: ${veh || '(cleared)'}`);
      this.stmts.insertHistory.run(id, 'edited', null, null, changes.join('; '), ts);
      return rowToRo(this.stmts.getById.get(id));
    });
  }

  // ---- Sessions ------------------------------------------------------------

  createSession(tokenHash, ttlMs) {
    const ts = new Date();
    const exp = new Date(ts.getTime() + ttlMs);
    this.stmts.insertSession.run(tokenHash, ts.toISOString(), exp.toISOString(), ts.toISOString());
  }

  /** Returns true if the session is valid; slides the expiry forward on each use. */
  touchSession(tokenHash, ttlMs) {
    const ts = new Date();
    const row = this.stmts.getSession.get(tokenHash, ts.toISOString());
    if (!row) return false;
    const exp = new Date(ts.getTime() + ttlMs);
    this.stmts.touchSession.run(ts.toISOString(), exp.toISOString(), tokenHash);
    return true;
  }

  deleteSession(tokenHash) {
    this.stmts.deleteSession.run(tokenHash);
  }

  purgeExpiredSessions() {
    this.stmts.purgeSessions.run(now());
  }
}

module.exports = { Store, AppError, normalizeRoNumber, roLabel, PHASES, FIRST_PHASE, FINAL_PHASE };
