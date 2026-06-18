'use strict';

/**
 * detectors/osr-refusal-rate.js — flag an overseas reprocessor (OSR) that refuses
 * an unusually high share of the loads sent to it (PRD §6 "later" set,
 * completion-pass scope; docs/anomaly-scenarios-from-sample.md / whiteboard #6 —
 * "a reprocessor turning away a large fraction of consignments").
 *
 * Why entities, not loads
 * -----------------------
 * A single refused load (AN=Yes, col AN) is routine — material can be rejected for
 * a one-off quality reason. What is suspicious is a *pattern*: one reprocessor that
 * refuses a large share of everything it is sent. That share is only visible once
 * loads are grouped by their destination OSR, so this detector reasons over the
 * derived **OSR entities** (keyed on `osrName`, BI) rather than individual loads.
 * Each OSR entity carries `loadIndexes` (a `Set` into the ingested `Load[]`) and the
 * distinct `operatorIds` it appears under; the detector reads the entity's loads
 * back out of `data.loads` and computes refused / total.
 *
 * A high refusal rate can mean persistent quality problems at that reprocessor,
 * mis-declared material being turned away on arrival, or paperwork that does not
 * match the consignment — all worth a regulator's attention.
 *
 * Findings are scoped to the **OSR** (the entity), one finding per offending
 * reprocessor. The score scales with how far the refusal rate exceeds the
 * threshold (a higher share ranks higher), floored at `baseScore` and saturating to
 * 100 at a 100% refusal rate; severity escalates from medium to high once the rate
 * reaches `highRefusalRate`. Evidence carries the OSR label, the refused/total
 * counts, the rate, and the operators involved.
 *
 * A `minLoads` floor is essential: an OSR with a single load that happens to be
 * refused is a 100% rate on a sample of one, which is noise, not a pattern. Only
 * OSRs with at least `minLoads` consignments are assessed (fixtures/demo/README.md:
 * the genuine signal "Global Reprocessing Ltd" has 2 of 5 refused, while the other
 * refused loads sit on single-load OSRs that must NOT flag).
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   maxRefusalRate   refusal share an OSR may have before it is flagged — flag when
 *                    `refused / total > this` (default 0.25).
 *   minLoads         minimum consignments to an OSR before its rate is assessed, so a
 *                    one-off refusal on a tiny sample is not flagged (default 3).
 *   baseScore        score floor for a just-over-threshold OSR (default 60).
 *   highRefusalRate  refusal rate at/above which severity escalates from medium to
 *                    high (default 0.5).
 *
 * Pure & deterministic (ADR-004): reads the derived entities + frozen Loads, emits
 * Findings, no I/O at evaluate time. Self-registers on import. Dependency rule
 * (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

/** A usable threshold is a finite number; anything else falls back to the default. */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Yield the OSR Entity records from the ingested dataset, tolerating either a
 * `Map<id, Entity>` (the production shape from `entity-derivation`) or a plain
 * array/iterable of entities (handy for unit tests). Anything else → no OSRs.
 */
function osrEntities(data) {
  const osrs = data && data.entities && data.entities.osrs;
  if (!osrs) return [];
  if (osrs instanceof Map) return [...osrs.values()];
  if (Array.isArray(osrs)) return osrs;
  if (typeof osrs[Symbol.iterator] === 'function') return [...osrs];
  return [];
}

/** Materialise a Set-or-array back-ref of load indexes to a plain array. */
function indexArray(ref) {
  if (ref instanceof Set) return [...ref];
  if (Array.isArray(ref)) return ref.slice();
  return [];
}

/** Round a 0–1 rate to a stable 4 dp for evidence/thresholds. */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

const OsrRefusalRate = {
  meta: {
    id: 'osr-refusal-rate',
    title: 'Overseas reprocessor refuses a high share of its loads',
    scope: SUBJECT_TYPE.OSR,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      maxRefusalRate: 0.25, // flag an OSR whose refused share EXCEEDS this
      minLoads: 3, // minimum consignments before a rate is assessed (kills 1-load noise)
      baseScore: 60, // score floor for a just-over-threshold OSR
      highRefusalRate: 0.5, // refusal rate at/above which severity escalates to high
    },
  },

  /**
   * @param {{loads?: object[], entities?: {osrs?: Map|object[]}}} data ingested
   *   dataset: uses the derived OSR entities (their `loadIndexes`/`operatorIds`)
   *   and reads each OSR's loads back out of `data.loads`.
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per OSR whose refusal rate exceeds the threshold.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || OsrRefusalRate.meta.config;
    const defaults = OsrRefusalRate.meta.config;

    const maxRefusalRate = isNumber(cfg.maxRefusalRate) && cfg.maxRefusalRate >= 0
      ? cfg.maxRefusalRate
      : defaults.maxRefusalRate;
    const minLoads = isNumber(cfg.minLoads) && cfg.minLoads >= 1
      ? cfg.minLoads
      : defaults.minLoads;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const highRefusalRate = isNumber(cfg.highRefusalRate)
      ? cfg.highRefusalRate
      : defaults.highRefusalRate;

    const findings = [];
    for (const entity of osrEntities(data)) {
      if (!entity || entity.id === null || entity.id === undefined) continue;

      // Read the OSR's loads back out of the Load[] via its loadIndexes back-ref.
      let total = 0;
      let refused = 0;
      for (const idx of indexArray(entity.loadIndexes)) {
        const load = loads[idx];
        if (!load) continue;
        total += 1;
        if (load.refused === true) refused += 1;
      }

      if (total < minLoads) continue; // sample too small to judge a rate — noise
      const rate = refused / total;
      if (rate <= maxRefusalRate) continue; // within acceptable refusal share — fine

      const operatorIds = entity.operatorIds instanceof Set
        ? [...entity.operatorIds]
        : (Array.isArray(entity.operatorIds) ? entity.operatorIds.slice() : []);
      const label = entity.label || entity.id;

      // Score floored at baseScore, scaling with how far the rate exceeds the
      // threshold (a higher refused share ranks higher), saturating to 100 at 100%.
      const reach = Math.min((rate - maxRefusalRate) / (1 - maxRefusalRate), 1);
      const score = Math.min(100, Math.round(baseScore + reach * (100 - baseScore)));
      const severity = rate >= highRefusalRate ? SEVERITY.HIGH : SEVERITY.MEDIUM;
      const pct = round4(rate * 100);
      const maxPct = round4(maxRefusalRate * 100);

      findings.push(
        makeFinding({
          detectorId: OsrRefusalRate.meta.id,
          version: OsrRefusalRate.meta.version,
          subject: {
            type: SUBJECT_TYPE.OSR,
            id: entity.id,
            label,
          },
          score,
          severity,
          reason: `Overseas reprocessor ${label} refused ${refused} of ${total} loads (${pct}%), above the ${maxPct}% threshold. A reprocessor turning away a large share of its consignments can indicate persistent quality problems or mis-declared material arriving on its doorstep.`,
          evidence: {
            osr: label,
            refusedLoads: refused,
            totalLoads: total,
            refusalRate: round4(rate),
            operatorIds,
          },
          thresholdsUsed: { maxRefusalRate, minLoads, highRefusalRate },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(OsrRefusalRate);
