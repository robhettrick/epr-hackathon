'use strict';

/**
 * ingest/seed-overlay.js — a deterministic, opt-in network seed overlay.
 *
 * Why this exists (fixtures/README "Known limitations (synthetic data)"): the real
 * submissions are synthetic, so suppliers and carrier vehicles do **not** overlap
 * naturally across files. With no shared entity, the cross-operator network
 * detector `single-supplier→many-operators` has nothing to fire on — its whole
 * point is one supplier feeding multiple operators.
 *
 * Two fixture sets, two seeding strategies:
 *   - The curated demo set (`fixtures/demo/*`) already has the shared entity baked
 *     into a handful of its rows (committed binaries), so the golden path / smoke
 *     test see it with no overlay and their counts stay exact.
 *   - The full fixtures (`FIXTURES=raw`) do **not** carry it. Rather than silently
 *     mutating those .xlsx binaries (un-reproducible, opaque), this module is the
 *     IMPLEMENTATION_PLAN item-G "deterministic ingest-time seed/overlay": a pure
 *     function the ingest entrypoint applies in memory when asked.
 *
 * What it does: re-points a small, fixed number of loads **per operator** at one
 * shared supplier and one shared carrier vehicle. The supplier is seeded by
 * postcode because `entity-derivation` keys suppliers on `supplierPostcode` (AJ)
 * before `supplierName` (AH) — a name-only seed would NOT merge across files whose
 * loads carry differing postcodes. After `deriveEntities`, the shared supplier /
 * vehicle therefore spans ≥2 distinct `operatorIds`.
 *
 * Properties (CLAUDE.md determinism + ADR C3 robustness):
 *   - PURE: returns a new `Load[]`; never mutates the frozen input Loads.
 *   - DETERMINISTIC: targets the first `loadsPerOperator` loads of each operator in
 *     first-seen order (Loads are concatenated in fixed file order), so the same
 *     inputs always yield the same seeded dataset.
 *   - OFF BY DEFAULT: only applied when the caller opts in (see `ingest`).
 */

const { makeLoad } = require('../model/load');

/**
 * The seeded shared entities. Values mirror the ones baked into `fixtures/demo/*`
 * so the same recognisable supplier/vehicle surfaces whichever fixture set is
 * ingested — the demo narrative ("Shared Metals Recovery Ltd", reg SH24RED) holds
 * on the full submissions too.
 */
const SHARED_SUPPLIER = Object.freeze({ name: 'Shared Metals Recovery Ltd', postcode: 'LS1 4AB' });
const SHARED_VEHICLE = Object.freeze({ reg: 'SH24RED' });

const DEFAULTS = Object.freeze({
  loadsPerOperator: 3, // loads per operator re-pointed at the shared entity
  supplier: true, // seed the shared supplier (postcode-keyed)
  vehicle: true, // seed the shared carrier vehicle
});

/**
 * Apply the shared network seed to a canonical `Load[]`.
 *
 * @param {object[]} loads canonical Loads (already concatenated across files).
 * @param {{loadsPerOperator?: number, supplier?: boolean, vehicle?: boolean}} [options]
 *   how many loads per operator to seed, and which shared entity/entities to seed.
 * @returns {object[]} a NEW Load[] (same length + order); seeded loads are rebuilt
 *   via `makeLoad` so they stay frozen and typed. Non-seeded loads are returned
 *   unchanged (same reference).
 */
function applyNetworkSeed(loads, options = {}) {
  if (!Array.isArray(loads)) return [];
  if (loads.length === 0) return [];

  const cfg = { ...DEFAULTS, ...options };
  const perOperator = Number.isInteger(cfg.loadsPerOperator) && cfg.loadsPerOperator > 0
    ? cfg.loadsPerOperator
    : DEFAULTS.loadsPerOperator;

  // Choose target indexes: the first `perOperator` loads of each operator, in
  // first-seen operator order. Spreading the seed across operators (not just the
  // leading rows of the whole array) is what produces the cross-operator span.
  const chosenByOperator = new Map(); // operatorId -> count chosen so far
  const targets = new Set();
  loads.forEach((load, index) => {
    if (!load) return;
    const op = load.operatorId === null || load.operatorId === undefined
      ? '__no-operator__'
      : load.operatorId;
    const count = chosenByOperator.get(op) || 0;
    if (count < perOperator) {
      targets.add(index);
      chosenByOperator.set(op, count + 1);
    }
  });

  return loads.map((load, index) => {
    if (!targets.has(index)) return load;
    // Spread the frozen Load, override the network fields, rebuild via makeLoad so
    // every other typed field (dates, tonnages) round-trips and the result stays
    // frozen. makeLoad re-coerces, but a Load's values already coerce to themselves.
    const overrides = { ...load };
    if (cfg.supplier) {
      overrides.supplierName = SHARED_SUPPLIER.name;
      overrides.supplierPostcode = SHARED_SUPPLIER.postcode;
    }
    if (cfg.vehicle) {
      overrides.carrierVehicleReg = SHARED_VEHICLE.reg;
    }
    return makeLoad(overrides);
  });
}

module.exports = { applyNetworkSeed, SHARED_SUPPLIER, SHARED_VEHICLE, DEFAULTS };
