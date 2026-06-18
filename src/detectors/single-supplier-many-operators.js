'use strict';

/**
 * detectors/single-supplier-many-operators.js — the fifth real ★ detector (PRD §6).
 *
 * This is the **network / multi-operator** detector: it reasons over the derived
 * supplier *entities* (not individual loads), across every ingested submission, and
 * flags a supplier that feeds an unusually high number of distinct operators
 * (docs/anomaly-scenarios-from-sample.md: "a single source spread thinly across
 * many exporters is a pattern associated with waste-laundering or front
 * operations"). It satisfies the acceptance criterion "at least one detector spans
 * multiple operators".
 *
 * Why entities, not loads
 * -----------------------
 * Whether one supplier feeds many operators is only visible *after* ≥2 files are
 * ingested and their loads folded into shared entities. `entity-derivation` keys a
 * supplier on its postcode (AJ) else name (AH) and accumulates, on each supplier
 * entity, the distinct `operatorIds` it appears under (a `Set`) and the contributing
 * `loadIndexes` (a `Set`). This detector simply reads `entity.operatorIds.size`.
 * Synthetic fixtures don't overlap naturally, so a shared supplier is injected (the
 * curated demo set bakes it in; the full fixtures get it via `seed-overlay.js`).
 *
 * Findings are scoped to the **supplier** (the entity), one finding per offending
 * supplier. The score scales with how many operators the supplier spans (a wider
 * spread ranks higher); severity escalates from medium to high once the spread
 * reaches `highOperators`. Evidence carries the supplier label, the operator count,
 * the distinct operator ids, and the contributing-load count.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   maxOperatorsPerSupplier number of distinct operators a supplier may feed before
 *                           it is flagged — flag when `operatorIds.size > this`
 *                           (default 1: a supplier feeding ≥2 operators is flagged).
 *   baseScore               score floor for a just-over-threshold supplier (default 60).
 *   saturationOperators     operator count at which the score saturates to 100
 *                           (default 5).
 *   highOperators           operator count at/above which severity escalates from
 *                           medium to high (default 3).
 *
 * Pure & deterministic (ADR-004): reads the derived entities, emits Findings, no I/O
 * at evaluate time. Self-registers on import. Dependency rule (ADR C4):
 * detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

/** A usable threshold number is finite; anything else falls back to the default. */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Yield the supplier Entity records from the ingested dataset, tolerating either a
 * `Map<id, Entity>` (the production shape from `entity-derivation`) or a plain
 * array/iterable of entities (handy for unit tests). Anything else → no suppliers.
 */
function supplierEntities(data) {
  const suppliers = data && data.entities && data.entities.suppliers;
  if (!suppliers) return [];
  if (suppliers instanceof Map) return [...suppliers.values()];
  if (Array.isArray(suppliers)) return suppliers;
  if (typeof suppliers[Symbol.iterator] === 'function') return [...suppliers];
  return [];
}

/** Count the members of a Set-or-array back-ref, treating anything else as 0. */
function sizeOf(ref) {
  if (ref instanceof Set || ref instanceof Map) return ref.size;
  if (Array.isArray(ref)) return ref.length;
  return 0;
}

/** Materialise a Set-or-array back-ref to a plain array for evidence. */
function toArray(ref) {
  if (ref instanceof Set) return [...ref];
  if (Array.isArray(ref)) return ref.slice();
  return [];
}

const SingleSupplierManyOperators = {
  meta: {
    id: 'single-supplier-many-operators',
    title: 'Single supplier feeding many operators',
    scope: SUBJECT_TYPE.SUPPLIER,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      maxOperatorsPerSupplier: 1, // flag a supplier feeding MORE than this many operators
      baseScore: 60, // score floor for a just-over-threshold supplier
      saturationOperators: 5, // operator count at which the score saturates to 100
      highOperators: 3, // operator count at/above which severity escalates to high
    },
  },

  /**
   * @param {{entities?: {suppliers?: Map|object[]}}} data ingested dataset (uses the
   *   derived supplier entities, each carrying `operatorIds`/`loadIndexes` back-refs).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per supplier feeding more than the threshold
   *   number of distinct operators.
   */
  evaluate(data, ctx = {}) {
    const cfg = ctx.config || SingleSupplierManyOperators.meta.config;
    const defaults = SingleSupplierManyOperators.meta.config;

    const maxOperators = isNumber(cfg.maxOperatorsPerSupplier) && cfg.maxOperatorsPerSupplier >= 0
      ? cfg.maxOperatorsPerSupplier
      : defaults.maxOperatorsPerSupplier;
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
    for (const entity of supplierEntities(data)) {
      if (!entity || entity.id === null || entity.id === undefined) continue;

      const operatorCount = sizeOf(entity.operatorIds);
      if (operatorCount <= maxOperators) continue; // within the allowed spread — fine

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

      findings.push(
        makeFinding({
          detectorId: SingleSupplierManyOperators.meta.id,
          version: SingleSupplierManyOperators.meta.version,
          subject: {
            type: SUBJECT_TYPE.SUPPLIER,
            id: entity.id,
            label,
          },
          score,
          severity,
          reason: `Supplier ${label} feeds ${operatorCount} distinct operators (${operatorIds.join(', ')}) across the submissions, over the threshold of ${maxOperators}. A single source spread across many exporters is a waste-laundering / front-operation pattern.`,
          evidence: {
            supplier: label,
            operatorCount,
            operatorIds,
            loadCount,
          },
          thresholdsUsed: { maxOperatorsPerSupplier: maxOperators, saturationOperators, highOperators },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(SingleSupplierManyOperators);
