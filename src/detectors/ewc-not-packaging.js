'use strict';

/**
 * detectors/ewc-not-packaging.js — the first real ★ detector (PRD §6).
 *
 * UK *packaging-waste* exports must carry an EWC code from chapter `15 01`
 * (packaging). On the sample submissions only ~13/1000 rows do; the rest sit in
 * other chapters (`19`, `20`, …) and 488 carry the hazardous `*` marker — see
 * docs/anomaly-scenarios-from-sample.md (D1/D2). This detector validates each
 * load's `ewcCode` (column H) against the reference lists and flags three ways:
 *
 *   hazardous     code carries the `*` hazardous marker (e.g. `10 03 21*`)
 *                 → CRITICAL: hazardous waste should never ride a packaging export.
 *   off-list      code is not in the EWC reference list at all (invalid / typo)
 *                 → HIGH: the code itself is not a recognised EWC code.
 *   non-packaging code is a valid EWC code but not a `15 01 xx` packaging code
 *                 (e.g. `20 03 01` municipal) → HIGH: wrong chapter for packaging.
 *
 * A valid, non-hazardous packaging code (`15 01 04` etc.) produces NO finding.
 * Hazardous is checked first, so a hazardous *packaging* code (`15 01 10*`) still
 * flags critical (D2): the hazard outranks the chapter.
 *
 * Reference lists come from `ctx.reference` (built by the engine, item E) — the
 * detector reads them, never hard-codes them (ADR-006/007). It prefers the
 * `allowed-codes.json` shape (`packagingEwcCodes`, `ewcCodes`) and falls back to
 * the ingest reference shape (`allowedEwc`), deriving the packaging subset from
 * the `15 01` prefix if no explicit packaging list is supplied — so the detector
 * fires correctly whichever reference source feeds it.
 *
 * Pure & deterministic (ADR-004): reads frozen Loads + reference, emits Findings,
 * no I/O. Self-registers on import. Dependency rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

/** Collapse internal whitespace + trim so load codes and reference codes compare
 * on equal footing; the hazardous `*` is preserved (it is significant). */
function normCode(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** A code is hazardous iff it carries the EWC `*` marker. */
function isHazardous(code) {
  return code.includes('*');
}

/**
 * Build the comparison sets from whatever reference shape we are handed.
 *   allowedSet    — every valid EWC code (for the off-list test)
 *   packagingSet  — the `15 01 xx` packaging subset (for the non-packaging test)
 * Prefers `allowed-codes.json` keys, falls back to the ingest reference, and
 * derives the packaging subset from the `15 01` prefix when none is supplied.
 */
function buildReferenceSets(reference = {}) {
  const allowed = Array.isArray(reference.ewcCodes)
    ? reference.ewcCodes
    : Array.isArray(reference.allowedEwc)
      ? reference.allowedEwc
      : [];
  const allowedNorm = allowed.map(normCode).filter(Boolean);
  const allowedSet = new Set(allowedNorm);

  const explicitPackaging = Array.isArray(reference.packagingEwcCodes) && reference.packagingEwcCodes.length > 0
    ? reference.packagingEwcCodes
    : null;
  const packaging = explicitPackaging
    ? explicitPackaging.map(normCode).filter(Boolean)
    : allowedNorm.filter((c) => /^15\s*01\b/.test(c));

  return { allowedSet, packagingSet: new Set(packaging) };
}

/** Per-category stub reason — plain-English fallback until the explain layer
 * (item G) owns reason text. Each ties the figures to the regulatory expectation. */
function reasonFor(category, code) {
  switch (category) {
    case 'hazardous':
      return `EWC ${code} carries the hazardous (*) marker — hazardous waste should not be on a packaging export (expected 15 01 xx).`;
    case 'off-list':
      return `EWC ${code} is not a recognised EWC code (not in the reference list) — likely invalid or mistyped.`;
    case 'non-packaging':
    default:
      return `EWC ${code} is not a packaging code (expected 15 01 xx).`;
  }
}

const EwcNotPackaging = {
  meta: {
    id: 'ewc-not-packaging',
    title: 'EWC code is not a packaging code',
    description: "Flags loads whose EWC code is not a packaging code (15 01 xx), is hazardous, or is not a recognised code; packaging-waste exports should carry packaging codes.",
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Detector-local scores (0–100), tunable at runtime via config.json (ADR-006).
    // Read from ctx.config; these are the baked-in defaults.
    config: {
      scores: { hazardous: 100, offList: 90, nonPackaging: 80 },
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{reference?: object, config?: object}} [ctx] engine context: reference
   *   lists + effective config (ADR-006).
   * @returns {object[]} one Finding per offending load.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const { allowedSet, packagingSet } = buildReferenceSets(ctx.reference || {});
    const scores = (ctx.config && ctx.config.scores) || EwcNotPackaging.meta.config.scores;

    const findings = [];
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      const code = normCode(load && load.ewcCode);
      if (code === null) continue; // no code to classify — not this detector's concern

      let category;
      let severity;
      let score;
      if (isHazardous(code)) {
        category = 'hazardous';
        severity = SEVERITY.CRITICAL;
        score = scores.hazardous;
      } else if (packagingSet.has(code)) {
        continue; // valid, non-hazardous packaging code → no finding
      } else if (!allowedSet.has(code)) {
        category = 'off-list';
        severity = SEVERITY.HIGH;
        score = scores.offList;
      } else {
        category = 'non-packaging';
        severity = SEVERITY.HIGH;
        score = scores.nonPackaging;
      }

      findings.push(
        makeFinding({
          detectorId: EwcNotPackaging.meta.id,
          version: EwcNotPackaging.meta.version,
          subject: {
            type: SUBJECT_TYPE.LOAD,
            id: i,
            label: `${code} — ${load.operatorId || 'unknown operator'}`,
          },
          score,
          severity,
          reason: reasonFor(category, code),
          evidence: {
            ewcCode: code,
            material: load.material || null,
            category,
          },
          thresholdsUsed: { scores },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(EwcNotPackaging);
