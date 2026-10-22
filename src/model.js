'use strict';

/**
 * Shared between the SQLite store (Node) and the D1 store (Cloudflare):
 * the schema, RO-number normalization, and row → API object mapping.
 */

// PRAGMAs are applied only by the Node store; D1 manages its own journal.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS repair_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ro_number    TEXT    NOT NULL,
    vehicle      TEXT    NOT NULL DEFAULT '',
    phase        TEXT    NOT NULL,
    status       TEXT    NOT NULL CHECK (status IN ('active', 'archived')),
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    phase_since  TEXT    NOT NULL,
    completed_at TEXT
  )`,
  // Only one ACTIVE card per RO number. Archived copies may repeat.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_repair_orders_active_number
    ON repair_orders (ro_number) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS ix_repair_orders_status_phase ON repair_orders (status, phase)`,
  `CREATE TABLE IF NOT EXISTS ro_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ro_id      INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
    event      TEXT    NOT NULL CHECK (event IN ('created', 'phase_change', 'completed', 'restored', 'edited')),
    from_phase TEXT,
    to_phase   TEXT,
    detail     TEXT,
    created_at TEXT    NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_ro_history_ro ON ro_history (ro_id, id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  )`,
];

function now() {
  return new Date().toISOString();
}

/** Normalize an RO number the way the shop writes them: trimmed, upper-case, single spaces. */
function normalizeRoNumber(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** "RO 1234" for plain numbers, but don't double up when the shop already writes "RO-1234". */
function roLabel(number) {
  return /^RO\b/i.test(number) ? number : `RO ${number}`;
}

function normalizeText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, max);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function rowToRo(row) {
  if (!row) return null;
  return {
    id: row.id,
    roNumber: row.ro_number,
    vehicle: row.vehicle,
    phase: row.phase,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    phaseSince: row.phase_since,
    completedAt: row.completed_at,
  };
}

function rowToHistory(row) {
  return {
    id: row.id,
    event: row.event,
    fromPhase: row.from_phase,
    toPhase: row.to_phase,
    detail: row.detail,
    at: row.created_at,
  };
}

module.exports = { SCHEMA_STATEMENTS, now, normalizeRoNumber, roLabel, normalizeText, escapeLike, rowToRo, rowToHistory };
