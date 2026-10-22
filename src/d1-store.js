'use strict';

/**
 * Data access on Cloudflare D1. Same methods as the SQLite Store in db.js, but async.
 *
 * D1 has no interactive transactions, so each mutation is one atomic `batch()` whose
 * history INSERT is written as an INSERT … SELECT that only matches when the preceding
 * UPDATE actually applied (we tag the row with a fresh timestamp and select on it).
 * Pre-checks give friendly 409s; the partial unique index is the hard guarantee.
 */

const { PHASES, FIRST_PHASE, FINAL_PHASE, isPhase } = require('./phases');
const { AppError } = require('./errors');
const { SCHEMA_STATEMENTS, now, normalizeRoNumber, roLabel, normalizeText, escapeLike, rowToRo, rowToHistory } = require('./model');

const ACTIVE_BY_NUMBER = `SELECT * FROM repair_orders WHERE ro_number = ? AND status = 'active'`;
const BY_ID = `SELECT * FROM repair_orders WHERE id = ?`;
const INSERT_HISTORY_IF = `INSERT INTO ro_history (ro_id, event, from_phase, to_phase, detail, created_at)
  SELECT id, ?, ?, ?, ?, ? FROM repair_orders WHERE id = ? AND updated_at = ?`;

let schemaReady = null; // one initialization per isolate

class D1Store {
  constructor(db) {
    this.db = db;
  }

  /** Create tables on first use. Cheap after the first call (CREATE IF NOT EXISTS). */
  async ensureSchema() {
    if (!schemaReady) {
      schemaReady = this.db.batch(SCHEMA_STATEMENTS.map((s) => this.db.prepare(s))).catch((err) => { schemaReady = null; throw err; });
    }
    await schemaReady;
  }

  q(sql, ...params) {
    return this.db.prepare(sql).bind(...params);
  }

  // ---- Repair orders -------------------------------------------------------

  async getRo(id) {
    return rowToRo(await this.q(BY_ID, id).first());
  }

  async getActiveByNumber(roNumber) {
    return rowToRo(await this.q(ACTIVE_BY_NUMBER, normalizeRoNumber(roNumber)).first());
  }

  async listActive() {
    const { results } = await this.q(`SELECT * FROM repair_orders WHERE status = 'active' ORDER BY phase_since ASC, id ASC`).all();
    return results.map(rowToRo);
  }

  async listArchived(query = '', limit = 200) {
    const q = normalizeRoNumber(query);
    const like = q ? `%${escapeLike(q)}%` : '%';
    const { results } = await this.q(`SELECT * FROM repair_orders WHERE status = 'archived'
      AND (? = '' OR ro_number LIKE ? ESCAPE '\\') ORDER BY completed_at DESC LIMIT ?`, q, like, limit).all();
    return results.map(rowToRo);
  }

  async search(query, limit = 50) {
    const q = normalizeRoNumber(query);
    if (!q) return [];
    const { results } = await this.q(`SELECT * FROM repair_orders WHERE ro_number LIKE ? ESCAPE '\\'
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, ro_number ASC, completed_at DESC LIMIT ?`, `%${escapeLike(q)}%`, limit).all();
    return results.map(rowToRo);
  }

  async history(id) {
    const { results } = await this.q(`SELECT * FROM ro_history WHERE ro_id = ? ORDER BY id ASC`, id).all();
    return results.map(rowToHistory);
  }

  async counts() {
    const { results } = await this.q(`SELECT status, COUNT(*) AS n FROM repair_orders GROUP BY status`).all();
    const out = { active: 0, archived: 0 };
    for (const row of results) out[row.status] = row.n;
    return out;
  }

  async createRo({ roNumber, vehicle = '', allowArchivedDuplicate = false }) {
    const number = normalizeRoNumber(roNumber);
    if (!number) throw new AppError(400, 'ro_number_required', 'RO number is required.');
    if (number.length > 40) throw new AppError(400, 'ro_number_too_long', 'RO number is too long (40 characters max).');
    const veh = normalizeText(vehicle, 120);

    const existing = rowToRo(await this.q(ACTIVE_BY_NUMBER, number).first());
    if (existing) throw new AppError(409, 'duplicate_active', `${roLabel(number)} is already on the board in ${existing.phase}.`, { existing });
    const archived = rowToRo(await this.q(`SELECT * FROM repair_orders WHERE ro_number = ? AND status = 'archived' ORDER BY completed_at DESC LIMIT 1`, number).first());
    if (archived && !allowArchivedDuplicate) {
      throw new AppError(409, 'exists_in_archive', `${roLabel(number)} was completed on ${archived.completedAt}. Restore it, or start a new RO with the same number.`, { archived });
    }

    const ts = now();
    try {
      await this.db.batch([
        this.q(`INSERT INTO repair_orders (ro_number, vehicle, phase, status, created_at, updated_at, phase_since)
                VALUES (?, ?, ?, 'active', ?, ?, ?)`, number, veh, FIRST_PHASE, ts, ts, ts),
        this.q(`INSERT INTO ro_history (ro_id, event, from_phase, to_phase, detail, created_at)
                SELECT id, 'created', NULL, ?, ?, ? FROM repair_orders WHERE ro_number = ? AND status = 'active' AND created_at = ?`,
        FIRST_PHASE, veh ? `Vehicle: ${veh}` : null, ts, number, ts),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const clash = rowToRo(await this.q(ACTIVE_BY_NUMBER, number).first());
        throw new AppError(409, 'duplicate_active', `${roLabel(number)} is already on the board${clash ? ` in ${clash.phase}` : ''}.`, { existing: clash });
      }
      throw err;
    }
    return rowToRo(await this.q(ACTIVE_BY_NUMBER, number).first());
  }

  async moveRo(id, toPhase) {
    if (!isPhase(toPhase)) throw new AppError(400, 'invalid_phase', `Unknown phase "${toPhase}".`);
    const ro = rowToRo(await this.q(BY_ID, id).first());
    if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
    if (ro.status !== 'active') throw new AppError(409, 'not_active', `${roLabel(ro.roNumber)} is archived. Restore it first.`);
    if (ro.phase === toPhase) return ro;
    const ts = now();
    await this.db.batch([
      this.q(`UPDATE repair_orders SET phase = ?, phase_since = ?, updated_at = ? WHERE id = ? AND status = 'active' AND phase = ?`, toPhase, ts, ts, id, ro.phase),
      this.q(INSERT_HISTORY_IF, 'phase_change', ro.phase, toPhase, null, ts, id, ts),
    ]);
    return this.getRo(id);
  }

  async completeRo(id) {
    const ro = rowToRo(await this.q(BY_ID, id).first());
    if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
    if (ro.status !== 'active') throw new AppError(409, 'not_active', `${roLabel(ro.roNumber)} is already archived.`);
    if (ro.phase !== FINAL_PHASE) {
      throw new AppError(409, 'not_in_qc', `${roLabel(ro.roNumber)} must be in ${FINAL_PHASE} before it can be marked complete (currently ${ro.phase}).`);
    }
    const ts = now();
    await this.db.batch([
      this.q(`UPDATE repair_orders SET status = 'archived', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND phase = ?`, ts, ts, id, FINAL_PHASE),
      this.q(INSERT_HISTORY_IF, 'completed', FINAL_PHASE, null, null, ts, id, ts),
    ]);
    return this.getRo(id);
  }

  async restoreRo(id) {
    const ro = rowToRo(await this.q(BY_ID, id).first());
    if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
    if (ro.status !== 'archived') throw new AppError(409, 'not_archived', `${roLabel(ro.roNumber)} is already on the board.`);
    const clash = rowToRo(await this.q(ACTIVE_BY_NUMBER, ro.roNumber).first());
    if (clash) throw new AppError(409, 'duplicate_active', `${roLabel(ro.roNumber)} is already on the board in ${clash.phase}.`, { existing: clash });
    const ts = now();
    try {
      await this.db.batch([
        this.q(`UPDATE repair_orders SET status = 'active', phase = ?, phase_since = ?, completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'archived'`, FIRST_PHASE, ts, ts, id),
        this.q(INSERT_HISTORY_IF, 'restored', null, FIRST_PHASE, null, ts, id, ts),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const c = rowToRo(await this.q(ACTIVE_BY_NUMBER, ro.roNumber).first());
        throw new AppError(409, 'duplicate_active', `${roLabel(ro.roNumber)} is already on the board${c ? ` in ${c.phase}` : ''}.`, { existing: c });
      }
      throw err;
    }
    return this.getRo(id);
  }

  async editRo(id, { roNumber, vehicle }) {
    const ro = rowToRo(await this.q(BY_ID, id).first());
    if (!ro) throw new AppError(404, 'not_found', 'RO not found.');
    const number = roNumber === undefined ? ro.roNumber : normalizeRoNumber(roNumber);
    const veh = vehicle === undefined ? ro.vehicle : normalizeText(vehicle, 120);
    if (!number) throw new AppError(400, 'ro_number_required', 'RO number is required.');
    if (number.length > 40) throw new AppError(400, 'ro_number_too_long', 'RO number is too long (40 characters max).');
    if (number === ro.roNumber && veh === ro.vehicle) return ro;
    if (number !== ro.roNumber && ro.status === 'active') {
      const clash = rowToRo(await this.q(ACTIVE_BY_NUMBER, number).first());
      if (clash) throw new AppError(409, 'duplicate_active', `${roLabel(number)} is already on the board in ${clash.phase}.`, { existing: clash });
    }
    const changes = [];
    if (number !== ro.roNumber) changes.push(`RO number ${ro.roNumber} → ${number}`);
    if (veh !== ro.vehicle) changes.push(`Vehicle: ${veh || '(cleared)'}`);
    const ts = now();
    try {
      await this.db.batch([
        this.q(`UPDATE repair_orders SET ro_number = ?, vehicle = ?, updated_at = ? WHERE id = ?`, number, veh, ts, id),
        this.q(INSERT_HISTORY_IF, 'edited', null, null, changes.join('; '), ts, id, ts),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const c = rowToRo(await this.q(ACTIVE_BY_NUMBER, number).first());
        throw new AppError(409, 'duplicate_active', `${roLabel(number)} is already on the board${c ? ` in ${c.phase}` : ''}.`, { existing: c });
      }
      throw err;
    }
    return this.getRo(id);
  }

  // ---- Sessions ------------------------------------------------------------

  async createSession(tokenHash, ttlMs) {
    const ts = new Date();
    const exp = new Date(ts.getTime() + ttlMs);
    await this.q(`INSERT INTO sessions (token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)`,
      tokenHash, ts.toISOString(), exp.toISOString(), ts.toISOString()).run();
  }

  async touchSession(tokenHash, ttlMs) {
    const ts = new Date();
    const exp = new Date(ts.getTime() + ttlMs);
    const { meta } = await this.q(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ? AND expires_at > ?`,
      ts.toISOString(), exp.toISOString(), tokenHash, ts.toISOString()).run();
    return meta.changes > 0;
  }

  async deleteSession(tokenHash) {
    await this.q(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash).run();
  }

  async purgeExpiredSessions() {
    await this.q(`DELETE FROM sessions WHERE expires_at <= ?`, now()).run();
  }
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err && err.message));
}

module.exports = { D1Store, PHASES };
