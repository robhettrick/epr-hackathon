'use strict';

/**
 * detectors/material-profile.js — the third real ★ detector (PRD §6).
 *
 * The declared recyclable proportion (column R, `recyclableProportion`, 0–1) must
 * be consistent with the recyclable grade implied by the load's material
 * (column I, `descriptionWaste`). Many template materials encode their grade in
 * the name itself — "…AAIG aluminium cans and associated packaging (97.5%)" — so a
 * load of that grade declaring only 0.35 recyclable is internally inconsistent
 * (docs/anomaly-scenarios-from-sample.md E1: all 348 "97.5%" rows on the full
 * sample declare R ≤ 0.80). This detector flags those under-declarations.
 *
 * Expected recyclable proportion is resolved per load from two sources, in order:
 *
 *   grade-suffix   a "(NN.N%)" grade in the material name → NN.N / 100
 *                  (e.g. "(97.5%)" → 0.975). Intrinsic to the row, always safe.
 *   profile-table  a reviewed entry in material-profiles.json keyed on the exact
 *                  material string, for materials whose grade is NOT in the name
 *                  (e.g. "Fibre-based composite - drink cartons" → 0.75).
 *
 * A load is flagged only when BOTH a recyclable proportion and an expected grade
 * are known AND the declared figure falls below the expected one by more than the
 * tolerance: `expected - declared > tolerance`. The check is directional —
 * declaring *less* recyclable than the grade is the E1 anomaly; declaring at or
 * above grade is fine. A missing R or an unknown material is a data-quality /
 * coverage gap, not this detector's concern, and produces no finding.
 *
 * Keying is on **material, not aluminium** (the fixtures carry aluminium AND
 * fibre-based composite): the grade comes from each load's own material string or
 * its profile entry, never a hard-coded substance. The "(NN.N%)" suffix is parsed
 * with a regex over the parenthesised percentage only, so the en-dash variant in
 * one Steel material name ("Steel – AAIG … (97.5%)") parses identically.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   tolerance           proportion slack before an under-declaration counts (default 0.05).
 *   toleranceByMaterial optional per-material overrides (keyed by material string).
 *   baseScore           score floor for any mismatch (default 60); the rest scales
 *                       with the size of the shortfall.
 *   highDeviation       shortfall at/above which severity escalates medium→high
 *                       (default 0.5). E1 is a medium-severity profile check.
 *
 * Pure & deterministic (ADR-004): reads frozen Loads + a static reviewed table,
 * emits Findings, no I/O at evaluate time. Self-registers on import. Dependency
 * rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');
const PROFILE_TABLE = require('./material-profiles.json');

/** Reviewed expected-proportion table keyed on the exact material string. */
const PROFILES = (PROFILE_TABLE && PROFILE_TABLE.profiles) || {};

/** A usable proportion/threshold is a finite number; anything else is "unknown". */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Round to 3 dp for stable, human-readable evidence/reason figures. */
function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * Parse a "(NN.N%)" grade suffix from a material string into a proportion (0–1),
 * or null when the name carries no parenthesised percentage. Reads only the
 * parenthesised number, so the hyphen/en-dash in the material name is irrelevant.
 * If several appear, the last (the trailing grade) wins.
 */
function gradeFromName(material) {
  if (typeof material !== 'string') return null;
  const matches = material.match(/\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const pct = Number(last.replace(/[()%\s]/g, ''));
  if (!Number.isFinite(pct)) return null;
  return pct / 100;
}

/**
 * Resolve the expected recyclable proportion for a material and where it came
 * from. Grade-suffix (intrinsic to the row) takes precedence over the reviewed
 * profile table.
 * @returns {{expected: number, source: string}|null}
 */
function expectedFor(material) {
  const fromName = gradeFromName(material);
  if (fromName !== null) return { expected: fromName, source: 'grade-suffix' };
  if (typeof material === 'string' && isNumber(PROFILES[material])) {
    return { expected: PROFILES[material], source: 'profile-table' };
  }
  return null;
}

/** Plain-English stub reason tying the figures to the inconsistency — the fallback
 * until the explain layer owns reason text. */
function reasonFor(material, expected, declared, source) {
  const how = source === 'grade-suffix'
    ? `its name implies a ${round3(expected * 100)}% recyclable grade`
    : `the reviewed profile for this material expects ${round3(expected * 100)}% recyclable`;
  return `Declared recyclable proportion ${round3(declared)} is inconsistent with "${material}": ${how}, so the load under-declares by ${round3(expected - declared)}.`;
}

const MaterialProfile = {
  meta: {
    id: 'material-profile',
    title: 'Recyclable proportion inconsistent with material grade',
    description: "Compares each load's declared recyclable proportion against the grade implied by its material and flags figures well below the expected grade.",
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      tolerance: 0.05, // proportion slack before an under-declaration counts
      toleranceByMaterial: {}, // optional per-material overrides (keyed by material string)
      baseScore: 60, // score floor for any mismatch (the rest scales with the shortfall)
      highDeviation: 0.5, // shortfall at/above which severity escalates medium→high
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per load that under-declares vs its grade.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || MaterialProfile.meta.config;
    const defaults = MaterialProfile.meta.config;
    const tolerance = isNumber(cfg.tolerance) ? cfg.tolerance : defaults.tolerance;
    const byMaterial = (cfg.toleranceByMaterial && typeof cfg.toleranceByMaterial === 'object')
      ? cfg.toleranceByMaterial
      : {};
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const highDeviation = isNumber(cfg.highDeviation) ? cfg.highDeviation : defaults.highDeviation;

    const findings = [];
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      if (!load) continue;

      const material = load.descriptionWaste;
      const declared = load.recyclableProportion;
      if (!isNumber(declared)) continue; // no figure to assess — data-quality gap, not this detector

      const profile = expectedFor(material);
      if (!profile) continue; // unknown grade — coverage gap, not an anomaly

      const { expected, source } = profile;
      const matTolerance = isNumber(byMaterial[material]) ? byMaterial[material] : tolerance;
      const shortfall = round3(expected - declared);
      if (shortfall <= matTolerance) continue; // at/above grade (within slack) → consistent

      // Score scales with the size of the shortfall, floored at baseScore so any
      // mismatch still ranks; severity escalates for gross inconsistencies.
      const score = Math.min(100, Math.round(baseScore + Math.min(shortfall, 1) * (100 - baseScore)));
      const severity = shortfall >= highDeviation ? SEVERITY.HIGH : SEVERITY.MEDIUM;

      findings.push(
        makeFinding({
          detectorId: MaterialProfile.meta.id,
          version: MaterialProfile.meta.version,
          subject: {
            type: SUBJECT_TYPE.LOAD,
            id: i,
            label: `${material} — ${load.operatorId || 'unknown operator'}`,
          },
          score,
          severity,
          reason: reasonFor(material, expected, declared, source),
          evidence: {
            material,
            expectedRecyclable: round3(expected),
            declaredRecyclable: round3(declared),
            shortfall,
            source,
          },
          thresholdsUsed: { tolerance: matTolerance, baseScore, highDeviation },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(MaterialProfile);
