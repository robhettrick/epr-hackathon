'use strict';

/**
 * detectors/temporal-logic.js — date-ordering integrity check (PRD §6 "later" set,
 * completion-pass scope; docs/anomaly-scenarios-from-sample.md temporal scenario).
 *
 * The three chain dates must run forward in time:
 *
 *   receivedForExport (G)  ≤  exported (U)  ≤  receivedByOsr (Y)
 *
 * Waste cannot be exported before it was received for export, and an overseas
 * reprocessor cannot receive a load before it was exported. Either ordering is a
 * hard logical contradiction — a load travelling backwards through its own chain —
 * so a violation is always CRITICAL (mirrors `chain-mass-balance`'s treatment of an
 * impossible chain). This is a date analogue of the mass-balance reconciliation.
 *
 * Two legs are checked independently, so one load can break both:
 *
 *   export-before-received  exported < receivedForExport
 *   osr-before-export       receivedByOsr < exported
 *
 * A leg is only assessed when BOTH of its dates are present; a missing date is a
 * coverage gap, not an anomaly, and is silently skipped (never a crash, ADR C3).
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   toleranceDays  slack (in days) before a backwards step counts, to absorb
 *                  same-day / data-entry granularity (default 0 — dates are
 *                  date-granular, so an earlier calendar day is a real violation).
 *   baseScore      score floor for any violation (default 80); the rest scales
 *                  with how far back in time the load travels.
 *   highGapDays    backwards gap (days) at/above which the score saturates to 100
 *                  (default 30).
 *
 * Pure & deterministic (ADR-004): reads frozen Loads, emits Findings, no I/O at
 * evaluate time. Self-registers on import. Dependency rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A usable threshold is a finite number; anything else falls back to the default. */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A real Date, or null. */
function isDate(v) {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** Whole-day gap (rounded) that `to` falls before `from`; negative when `to` is later. */
function gapDays(from, to) {
  return Math.round((from.getTime() - to.getTime()) / MS_PER_DAY);
}

/** ISO calendar date (YYYY-MM-DD) for stable, human-readable evidence. */
function isoDate(d) {
  return isDate(d) ? d.toISOString().slice(0, 10) : null;
}

/** The two ordered legs of the chain: each later date must not precede its earlier one. */
const LEGS = [
  { id: 'export-before-received', fromField: 'receivedForExport', toField: 'exported' },
  { id: 'osr-before-export', fromField: 'exported', toField: 'receivedByOsr' },
];

/** Plain-English stub reason — the fallback until the explain layer owns reason text. */
function reasonFor(violations) {
  const parts = violations.map((v) =>
    v.id === 'export-before-received'
      ? `it was exported (${v.to}) ${v.gapDays} day(s) before it was received for export (${v.from})`
      : `it was received by the overseas reprocessor (${v.to}) ${v.gapDays} day(s) before it was exported (${v.from})`,
  );
  return `The chain dates run backwards: ${parts.join('; and ')}. This ordering is physically impossible and points to a data-integrity problem.`;
}

const TemporalLogic = {
  meta: {
    id: 'temporal-logic',
    title: 'Chain dates out of order (export/receipt run backwards)',
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      toleranceDays: 0, // slack before a backwards step counts
      baseScore: 80, // score floor for any violation
      highGapDays: 30, // gap at/above which the score saturates to 100
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per load whose chain dates run backwards.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || TemporalLogic.meta.config;
    const defaults = TemporalLogic.meta.config;
    const toleranceDays = isNumber(cfg.toleranceDays) ? cfg.toleranceDays : defaults.toleranceDays;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const highGapDays = isNumber(cfg.highGapDays) && cfg.highGapDays > 0
      ? cfg.highGapDays
      : defaults.highGapDays;

    const findings = [];
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      if (!load) continue;

      const violations = [];
      for (const leg of LEGS) {
        const from = load[leg.fromField];
        const to = load[leg.toField];
        if (!isDate(from) || !isDate(to)) continue; // both dates required to assess this leg
        const gap = gapDays(from, to); // > 0 ⇒ `to` precedes `from` (backwards)
        if (gap > toleranceDays) {
          violations.push({ id: leg.id, from: isoDate(from), to: isoDate(to), gapDays: gap });
        }
      }
      if (violations.length === 0) continue;

      // Score scales with the worst backwards gap, floored at baseScore so any
      // contradiction still ranks; an impossible ordering is uniformly critical.
      const worstGap = violations.reduce((m, v) => Math.max(m, v.gapDays), 0);
      const score = Math.min(
        100,
        Math.round(baseScore + Math.min(worstGap / highGapDays, 1) * (100 - baseScore)),
      );

      findings.push(
        makeFinding({
          detectorId: TemporalLogic.meta.id,
          version: TemporalLogic.meta.version,
          subject: {
            type: SUBJECT_TYPE.LOAD,
            id: i,
            label: `Load #${i} — ${load.operatorId || 'unknown operator'}`,
          },
          score,
          severity: SEVERITY.CRITICAL,
          reason: reasonFor(violations),
          evidence: {
            receivedForExport: isoDate(load.receivedForExport),
            exported: isoDate(load.exported),
            receivedByOsr: isoDate(load.receivedByOsr),
            violations,
          },
          thresholdsUsed: { toleranceDays, baseScore, highGapDays },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(TemporalLogic);
