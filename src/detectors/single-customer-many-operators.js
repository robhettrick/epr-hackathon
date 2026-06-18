'use strict';

/**
 * detectors/single-customer-many-operators.js — the mirror image of
 * `single-supplier-many-operators` (PRD §6 "later" set, completion-pass scope;
 * docs/anomaly-scenarios-from-sample.md / whiteboard #2).
 *
 * Where `single-supplier→many-operators` looks UPSTREAM (one source feeding many
 * exporters), this looks DOWNSTREAM: one **customer** — an overseas reprocessor
 * (OSR) — receiving consignments from an unusually high number of distinct UK
 * operators across the ingested submissions. A single foreign reprocessor that is
 * the common destination for many separate exporters is the converse
 * waste-laundering / front-operation pattern: it can act as a funnel that
 * consolidates mis-declared material arriving from several apparently-unrelated
 * sources.
 *
 * Why entities, not loads
 * -----------------------
 * Whether one customer draws from many operators is only visible *after* ≥2 files
 * are ingested and their loads folded into shared entities. `entity-derivation`
 * keys an OSR on its name (BI) and accumulates, on each OSR entity, the distinct
 * `operatorIds` it appears under (a `Set`) and the contributing `loadIndexes` (a
 * `Set`). This detector simply reads `entity.operatorIds.size`. Synthetic fixtures
 * don't overlap naturally, so a shared customer is seeded into the demo set
 * ("Global Reprocessing Ltd" across both operators — see fixtures/demo/README.md).
 *
 * Findings are scoped to the **OSR** (the entity), one finding per offending
 * customer. The score scales with how many operators the customer spans (a wider
 * spread ranks higher); severity escalates from medium to high once the spread
 * reaches `highOperators`. Evidence carries the OSR label, the operator count, the
 * distinct operator ids, and the contributing-load count.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   maxOperatorsPerCustomer number of distinct operators a customer may draw from
 *                           before it is flagged — flag when `operatorIds.size > this`
 *                           (default 1: a customer fed by ≥2 operators is flagged).
 *   baseScore               score floor for a just-over-threshold customer (default 60).
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
 * Yield the OSR (customer) Entity records from the ingested dataset, tolerating
 * either a `Map<id, Entity>` (the production shape from `entity-derivation`) or a
 * plain array/iterable of entities (handy for unit tests). Anything else → none.
 */
function osrEntities(data) {
  const osrs = data && data.entities && data.entities.osrs;
  if (!osrs) return [];
  if (osrs instanceof Map) return [...osrs.values()];
  if (Array.isArray(osrs)) return osrs;
  if (typeof osrs[Symbol.iterator] === 'function') return [...osrs];
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

const SingleCustomerManyOperators = {
  meta: {
    id: 'single-customer-many-operators',
    title: 'Single customer drawing from many operators',
    description: "Flags an overseas reprocessor drawing loads from an unusually large number of operators, a possible funnel or waste-laundering pattern.",
    scope: SUBJECT_TYPE.OSR,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      maxOperatorsPerCustomer: 1, // flag a customer fed by MORE than this many operators
      baseScore: 60, // score floor for a just-over-threshold customer
      saturationOperators: 5, // operator count at which the score saturates to 100
      highOperators: 3, // operator count at/above which severity escalates to high
    },
  },

  /**
   * @param {{entities?: {osrs?: Map|object[]}}} data ingested dataset (uses the
   *   derived OSR entities, each carrying `operatorIds`/`loadIndexes` back-refs).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per customer drawing from more than the
   *   threshold number of distinct operators.
   */
  evaluate(data, ctx = {}) {
    const cfg = ctx.config || SingleCustomerManyOperators.meta.config;
    const defaults = SingleCustomerManyOperators.meta.config;

    const maxOperators = isNumber(cfg.maxOperatorsPerCustomer) && cfg.maxOperatorsPerCustomer >= 0
      ? cfg.maxOperatorsPerCustomer
      : defaults.maxOperatorsPerCustomer;
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
    for (const entity of osrEntities(data)) {
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
          detectorId: SingleCustomerManyOperators.meta.id,
          version: SingleCustomerManyOperators.meta.version,
          subject: {
            type: SUBJECT_TYPE.OSR,
            id: entity.id,
            label,
          },
          score,
          severity,
          reason: `Overseas reprocessor ${label} receives loads from ${operatorCount} distinct operators (${operatorIds.join(', ')}) across the submissions, over the threshold of ${maxOperators}. A single customer that is the common destination for many separate exporters can act as a funnel for mis-declared waste — the downstream mirror of a single supplier feeding many operators.`,
          evidence: {
            customer: label,
            operatorCount,
            operatorIds,
            loadCount,
          },
          thresholdsUsed: { maxOperatorsPerCustomer: maxOperators, saturationOperators, highOperators },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(SingleCustomerManyOperators);
