'use strict';

/**
 * detectors/arithmetic-integrity.js — recompute the declared net weight and flag
 * loads where the arithmetic does not add up (PRD §6 "later" set, completion-pass
 * scope; docs/anomaly-scenarios-from-sample.md tamper/formula-override scenario).
 *
 * The net weight is a derived figure: a load's net is whatever is left once the
 * container and pallet are removed from the gross weight —
 *
 *     net (N)  ==  gross (K)  −  tare (L)  −  pallet (M)
 *
 * In a clean submission the spreadsheet computes `net` by formula, so it always
 * reconciles. A `net` that does NOT equal `gross − tare − pallet` means the cell
 * was overridden — the declared figure was typed over the formula — which is the
 * classic tamper / data-integrity signal: the headline tonnage can be quietly
 * inflated or deflated independent of the weights it is supposed to be derived
 * from. We recompute the expected net from the inputs and flag any reconciliation
 * gap beyond a tolerance.
 *
 * A load is only assessed when ALL of gross, tare, pallet and net are present
 * numbers — the recompute is impossible otherwise, and a missing input is a
 * coverage gap (left to other detectors), not an anomaly, so it is silently
 * skipped (never a crash, ADR C3).
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   tolerance    rounding/measurement slack (in the same unit as the weights)
 *                before a discrepancy counts (default 0.5).
 *   baseScore    score floor for any unreconciled load (default 70); the rest
 *                scales with the *relative* size of the discrepancy so the most
 *                egregious overrides rank top of the list.
 *   criticalRel  relative discrepancy (|declared − expected| / max(...)) at/above
 *                which the finding escalates from `high` to `critical` (default
 *                0.1 — a ≥10% override is a strong tamper signal, not a typo).
 *
 * Pure & deterministic (ADR-004): reads frozen Loads, emits Findings, no I/O at
 * evaluate time. Self-registers on import. Dependency rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

/** A usable weight is a finite number; anything else (null/blank) is "unknown". */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Round to 3 dp for stable, human-readable evidence/reason figures. */
function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Plain-English stub reason tying the figures to the broken identity — the
 * fallback until the explain layer owns reason text. */
function reasonFor({ gross, tare, pallet, declared, expected }) {
  return (
    `Net weight does not reconcile: the load declares ${round3(declared)} but ` +
    `gross − tare − pallet (${round3(gross)} − ${round3(tare)} − ${round3(pallet)}) ` +
    `= ${round3(expected)}. A net that does not match its own weights points to a ` +
    `formula override / data-integrity problem.`
  );
}

const ArithmeticIntegrity = {
  meta: {
    id: 'arithmetic-integrity',
    title: 'Net weight does not reconcile (gross − tare − pallet)',
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      tolerance: 0.5, // slack before a discrepancy counts (matches config.json)
      baseScore: 70, // score floor for any unreconciled load
      criticalRel: 0.1, // relative gap at/above which it is critical, not high
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per load whose net does not reconcile.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const defaults = ArithmeticIntegrity.meta.config;
    const cfg = ctx.config || defaults;
    const tolerance = isNumber(cfg.tolerance) ? cfg.tolerance : defaults.tolerance;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const criticalRel = isNumber(cfg.criticalRel) ? cfg.criticalRel : defaults.criticalRel;

    const findings = [];
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      if (!load) continue;

      const { gross, tare, pallet, net: declared } = load;
      // All four are needed to recompute; a missing input is a coverage gap.
      if (!isNumber(gross) || !isNumber(tare) || !isNumber(pallet) || !isNumber(declared)) continue;

      const expected = gross - tare - pallet;
      const diff = round3(Math.abs(declared - expected));
      if (diff <= tolerance) continue; // reconciles within slack

      // Score scales with the *relative* discrepancy so the worst overrides rank
      // top, with a floor so any unreconciled load still ranks highly.
      const base = Math.max(Math.abs(expected), Math.abs(declared), 1);
      const rel = diff / base;
      const score = Math.min(100, Math.round(baseScore + Math.min(rel, 1) * (100 - baseScore)));
      const severity = rel >= criticalRel ? SEVERITY.CRITICAL : SEVERITY.HIGH;

      findings.push(
        makeFinding({
          detectorId: ArithmeticIntegrity.meta.id,
          version: ArithmeticIntegrity.meta.version,
          subject: {
            type: SUBJECT_TYPE.LOAD,
            id: i,
            label: `Load #${i} — ${load.operatorId || 'unknown operator'}`,
          },
          score,
          severity,
          reason: reasonFor({ gross, tare, pallet, declared, expected }),
          evidence: {
            gross: round3(gross),
            tare: round3(tare),
            pallet: round3(pallet),
            declaredNet: round3(declared),
            expectedNet: round3(expected),
            discrepancy: round3(declared - expected),
          },
          thresholdsUsed: { tolerance, baseScore, criticalRel },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(ArithmeticIntegrity);
