'use strict';

/**
 * detectors/shared-vehicle-across-operators.js — flag a carrier vehicle (BE) that
 * appears under two or more distinct operators on OVERLAPPING dates (PRD §6 "later"
 * set, completion-pass scope; docs/anomaly-scenarios-from-sample.md / whiteboard
 * "same vehicle, two operators, same week").
 *
 * Why entities, not loads
 * -----------------------
 * Whether one physical vehicle is shared across operators is only visible *after*
 * ≥2 files are ingested and their loads folded into shared entities.
 * `entity-derivation` keys a vehicle on its `carrierVehicleReg` (BE) and accumulates,
 * on each vehicle entity, the distinct `operatorIds` it appears under (a `Set`) and
 * the contributing `loadIndexes` (a `Set`). This detector reads the vehicle's loads
 * back out of `data.loads` via those indexes — like `osr-refusal-rate` — so it can
 * inspect each load's carriage dates. Synthetic fixtures don't overlap naturally, so
 * a shared vehicle is seeded (reg `SH24RED` across both operators — the curated demo
 * set bakes it in; the full fixtures get it via `seed-overlay.js`).
 *
 * The "overlapping dates" gate is what makes this distinct from
 * `single-supplier→many-operators` (pure spread). A carrier reused by separate
 * operators *months apart* is plausibly an innocently sub-contracted haulier; the
 * suspicious case is one vehicle apparently in use by two operators *at the same
 * time* — physically a single truck cannot be in two operators' chains at once, so
 * it points to a fictitious carrier, plate cloning, collusion, or a transcription
 * error. Each load's carriage window is the span of its present chain dates
 * (receivedForExport G … exported U … receivedByOsr Y); two loads overlap when their
 * windows intersect (widened by `toleranceDays`). The vehicle is flagged only when
 * at least one cross-operator pair of windows overlaps (unless `requireOverlap` is
 * turned off, in which case it degrades to pure cross-operator spread).
 *
 * Findings are scoped to the **vehicle** (the entity), one finding per offending
 * vehicle. The score scales with how many operators the vehicle spans (a wider
 * spread ranks higher), floored at `baseScore` and saturating to 100 at
 * `saturationOperators`; severity escalates from medium to high once the spread
 * reaches `highOperators`. Evidence carries the reg, the operator count + ids, the
 * load count, and a representative overlapping window.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   maxOperatorsPerVehicle number of distinct operators a vehicle may appear under
 *                          before it is flagged — flag when `operatorIds.size > this`
 *                          (default 1: a vehicle shared by ≥2 operators is a candidate).
 *   requireOverlap         when true (default), only flag when a cross-operator pair
 *                          of carriage windows overlaps; when false, flag any
 *                          cross-operator vehicle regardless of dates.
 *   toleranceDays          slack (in days) added to each window before testing
 *                          overlap, to absorb date-entry granularity (default 0).
 *   baseScore              score floor for a just-over-threshold vehicle (default 60).
 *   saturationOperators    operator count at which the score saturates to 100
 *                          (default 5).
 *   highOperators          operator count at/above which severity escalates from
 *                          medium to high (default 3).
 *
 * Pure & deterministic (ADR-004): reads the derived entities + frozen Loads, emits
 * Findings, no I/O at evaluate time. Self-registers on import. Dependency rule
 * (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A usable threshold is a finite number; anything else falls back to the default. */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A real Date, or not. */
function isDate(v) {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** ISO calendar date (YYYY-MM-DD) from an epoch-ms for stable, readable evidence. */
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Yield the vehicle Entity records from the ingested dataset, tolerating either a
 * `Map<id, Entity>` (the production shape from `entity-derivation`) or a plain
 * array/iterable of entities (handy for unit tests). Anything else → no vehicles.
 */
function vehicleEntities(data) {
  const vehicles = data && data.entities && data.entities.vehicles;
  if (!vehicles) return [];
  if (vehicles instanceof Map) return [...vehicles.values()];
  if (Array.isArray(vehicles)) return vehicles;
  if (typeof vehicles[Symbol.iterator] === 'function') return [...vehicles];
  return [];
}

/** Count the members of a Set-or-array back-ref, treating anything else as 0. */
function sizeOf(ref) {
  if (ref instanceof Set || ref instanceof Map) return ref.size;
  if (Array.isArray(ref)) return ref.length;
  return 0;
}

/** Materialise a Set-or-array back-ref to a plain array. */
function toArray(ref) {
  if (ref instanceof Set) return [...ref];
  if (Array.isArray(ref)) return ref.slice();
  return [];
}

/**
 * The carriage window for a load: the [min, max] epoch-ms span of its present chain
 * dates (receivedForExport G, exported U, receivedByOsr Y). A load with no usable
 * date returns null — it is a coverage gap and cannot establish an overlap (ADR C3).
 */
function carriageWindow(load) {
  if (!load) return null;
  const times = [load.receivedForExport, load.exported, load.receivedByOsr]
    .filter(isDate)
    .map((d) => d.getTime());
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}

/** Two windows overlap when they intersect once each is widened by `tolMs` of slack. */
function windowsOverlap(a, b, tolMs) {
  return a.start <= b.end + tolMs && b.start <= a.end + tolMs;
}

const SharedVehicleAcrossOperators = {
  meta: {
    id: 'shared-vehicle-across-operators',
    title: 'Carrier vehicle shared across operators on overlapping dates',
    scope: SUBJECT_TYPE.VEHICLE,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      maxOperatorsPerVehicle: 1, // flag a vehicle appearing under MORE than this many operators
      requireOverlap: true, // only flag when cross-operator carriage windows overlap
      toleranceDays: 0, // slack (days) added to each window before testing overlap
      baseScore: 60, // score floor for a just-over-threshold vehicle
      saturationOperators: 5, // operator count at which the score saturates to 100
      highOperators: 3, // operator count at/above which severity escalates to high
    },
  },

  /**
   * @param {{loads?: object[], entities?: {vehicles?: Map|object[]}}} data ingested
   *   dataset: uses the derived vehicle entities (their `operatorIds`/`loadIndexes`)
   *   and reads each vehicle's loads back out of `data.loads` for their dates.
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per vehicle shared across more than the threshold
   *   number of operators (with overlapping carriage dates when `requireOverlap`).
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || SharedVehicleAcrossOperators.meta.config;
    const defaults = SharedVehicleAcrossOperators.meta.config;

    const maxOperators = isNumber(cfg.maxOperatorsPerVehicle) && cfg.maxOperatorsPerVehicle >= 0
      ? cfg.maxOperatorsPerVehicle
      : defaults.maxOperatorsPerVehicle;
    const requireOverlap = typeof cfg.requireOverlap === 'boolean'
      ? cfg.requireOverlap
      : defaults.requireOverlap;
    const toleranceDays = isNumber(cfg.toleranceDays) && cfg.toleranceDays >= 0
      ? cfg.toleranceDays
      : defaults.toleranceDays;
    const tolMs = toleranceDays * MS_PER_DAY;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const highOperators = isNumber(cfg.highOperators)
      ? cfg.highOperators
      : defaults.highOperators;
    // Saturation must sit strictly above the flag threshold or the score can't scale.
    let saturationOperators = isNumber(cfg.saturationOperators)
      ? cfg.saturationOperators
      : defaults.saturationOperators;
    if (saturationOperators <= maxOperators) saturationOperators = maxOperators + 1;

    const findings = [];
    for (const entity of vehicleEntities(data)) {
      if (!entity || entity.id === null || entity.id === undefined) continue;

      const operatorCount = sizeOf(entity.operatorIds);
      if (operatorCount <= maxOperators) continue; // appears under few enough operators — fine

      // Build the per-load carriage windows tagged by operator, skipping date-less loads.
      const windows = [];
      for (const idx of toArray(entity.loadIndexes)) {
        const load = loads[idx];
        const window = carriageWindow(load);
        if (!window) continue;
        windows.push({ operatorId: load.operatorId, start: window.start, end: window.end });
      }

      // Find the cross-operator overlapping pairs — the physically-implausible case.
      let representative = null;
      let overlappingPairCount = 0;
      for (let i = 0; i < windows.length; i += 1) {
        for (let j = i + 1; j < windows.length; j += 1) {
          if (windows[i].operatorId === windows[j].operatorId) continue; // same operator — not the pattern
          if (!windowsOverlap(windows[i], windows[j], tolMs)) continue;
          overlappingPairCount += 1;
          if (representative === null) {
            // Record the intersection of the first overlapping pair for the detail view.
            representative = {
              operatorA: windows[i].operatorId,
              operatorB: windows[j].operatorId,
              sharedFrom: isoDay(Math.max(windows[i].start, windows[j].start)),
              sharedTo: isoDay(Math.min(windows[i].end, windows[j].end)),
            };
          }
        }
      }

      // The defining anomaly is the cross-operator date overlap — without it, a
      // shared carrier reused at different times is plausibly innocent, so skip.
      if (requireOverlap && overlappingPairCount === 0) continue;

      const operatorIds = toArray(entity.operatorIds);
      const loadCount = sizeOf(entity.loadIndexes);

      // Score floored at baseScore, scaling with how far the operator spread exceeds
      // the threshold (a wider spread ranks higher), saturating to 100.
      const reach = Math.min(
        (operatorCount - maxOperators) / (saturationOperators - maxOperators),
        1,
      );
      const score = Math.min(100, Math.round(baseScore + reach * (100 - baseScore)));
      const severity = operatorCount >= highOperators ? SEVERITY.HIGH : SEVERITY.MEDIUM;
      const label = entity.label || entity.id;

      const when = representative
        ? ` on overlapping dates (both operators between ${representative.sharedFrom} and ${representative.sharedTo})`
        : ' across the submissions';

      findings.push(
        makeFinding({
          detectorId: SharedVehicleAcrossOperators.meta.id,
          version: SharedVehicleAcrossOperators.meta.version,
          subject: {
            type: SUBJECT_TYPE.VEHICLE,
            id: entity.id,
            label,
          },
          score,
          severity,
          reason: `Carrier vehicle ${label} carries loads for ${operatorCount} distinct operators (${operatorIds.join(', ')})${when}. A single vehicle apparently in use by separate operators at the same time is physically implausible and can indicate a fictitious carrier, plate cloning, collusion, or a transcription error.`,
          evidence: {
            vehicle: label,
            operatorCount,
            operatorIds,
            loadCount,
            overlappingPairCount,
            overlap: representative,
          },
          thresholdsUsed: {
            maxOperatorsPerVehicle: maxOperators,
            requireOverlap,
            toleranceDays,
            saturationOperators,
            highOperators,
          },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(SharedVehicleAcrossOperators);
