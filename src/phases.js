'use strict';

// Fixed shop workflow. Order matters: this is the column order on the board.
// Intentionally not configurable — there are no phase-management settings.
const PHASES = Object.freeze([
  'Inspection',
  'Estimate',
  'Parts',
  'Mechanical',
  'Wheel',
  'Repair',
  'PDR',
  'Paint Correction',
  'Spot Repair',
  'Interior',
  'Detail',
  'QC',
]);

const FIRST_PHASE = PHASES[0];
const FINAL_PHASE = PHASES[PHASES.length - 1];

function isPhase(value) {
  return typeof value === 'string' && PHASES.includes(value);
}

module.exports = { PHASES, FIRST_PHASE, FINAL_PHASE, isPhase };
