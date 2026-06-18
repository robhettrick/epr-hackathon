'use strict';

/**
 * detectors/chain-mass-balance.js — the second real ★ detector (PRD §6).
 *
 * The #1 regulator check (docs/anomaly-scenarios-from-sample.md B1). Physically,
 * a load's tonnage must only ever shrink as it moves down the export chain:
 *
 *     tonnageReceivedForExport (S) ≥ tonnageExported (T) ≥ tonnageReceivedByOsr (BK)
 *
 * You cannot export more than you received, and an overseas reprocessor (OSR)
 * cannot receive more than was exported. A row that breaks either inequality is
 * physically impossible — the chain does not reconcile. On the sample file 8 loads
 * claim more exported than was ever received (B1).
 *
 * Two legs are checked independently (a row can break either, or both):
 *
 *   export leg   exp > recv + tolerance  → impossible: exported more than received.
 *   osr leg      osr > exp  + tolerance  → impossible: OSR received more than exported.
 *
 * Both are CRITICAL — an impossible chain is the headline regulator anomaly. The
 * `score` (0–100) is driven by the *relative* size of the worst overflow so the
 * per-detector ranked list (golden-path step 4) surfaces the most egregious
 * reconciliation failures first; it never drops below a configurable floor so any
 * impossible chain still ranks highly.
 *
 * Interim-site handling (col AC, carried as `interimHandling`) RELAXES the osr leg:
 * when waste is documented as passing through an interim site before reaching the
 * OSR, the recorded OSR receipt legitimately need not match the exported tonnage
 * (ADR-005/006 — "allow interim handling"). It does NOT relax the export leg:
 * nothing justifies exporting more than was received.
 *
 * A leg is only assessed when BOTH its tonnages are present numbers — a missing
 * figure is a data-quality gap, not a reconciliation failure, and is left to other
 * detectors. A load with no usable tonnages produces no finding.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   tolerance   rounding/measurement slack before a gap counts (default 0.01 t).
 *   baseScore   the score floor for any impossible chain (default 70).
 *
 * Pure & deterministic (ADR-004): reads frozen Loads, emits Findings, no I/O.
 * Self-registers on import. Dependency rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

/** A usable tonnage is a finite number; anything else (null/blank) is "unknown". */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Round to 3 dp for stable, human-readable evidence/reason figures (tonnes). */
function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Plain-English stub reason tying the figures to the broken inequality — the
 * fallback until the explain layer (item G) owns reason text. */
function reasonFor(violations, { recv, exp, osr }) {
  const parts = violations.map((v) => {
    if (v.leg === 'export') {
      return `reports ${round3(exp)} t exported but only ${round3(recv)} t received for export`;
    }
    return `reports ${round3(osr)} t received by the OSR but only ${round3(exp)} t exported`;
  });
  return `Chain does not reconcile: this load ${parts.join('; and ')} — physically impossible (expected received ≥ exported ≥ received-by-OSR).`;
}

const ChainMassBalance = {
  meta: {
    id: 'chain-mass-balance',
    title: 'Chain mass-balance does not reconcile',
    description: "Checks that tonnage only shrinks down the export chain (received for export >= exported >= received by reprocessor); a load that breaks this is physically impossible.",
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      tolerance: 0.01, // tonnes of slack before a gap counts (matches config.json)
      baseScore: 70, // score floor for any impossible chain (the rest scales with magnitude)
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per load whose chain does not reconcile.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || ChainMassBalance.meta.config;
    const tolerance = isNumber(cfg.tolerance) ? cfg.tolerance : ChainMassBalance.meta.config.tolerance;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : ChainMassBalance.meta.config.baseScore;

    const findings = [];
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      if (!load) continue;

      const recv = load.tonnageReceivedForExport;
      const exp = load.tonnageExported;
      const osr = load.tonnageReceivedByOsr;
      // An interim site (col AC) means the OSR-received figure need not match the
      // exported tonnage — relax that leg only when a route is documented.
      const interim = load.interimHandling !== null && load.interimHandling !== undefined;

      const violations = [];
      // Compare the rounded gap (tonnages are real-world ~3dp) so the tolerance
      // boundary is deterministic and free of IEEE-754 float artifacts.
      // export leg — never relaxed: exporting more than received is always impossible.
      if (isNumber(recv) && isNumber(exp)) {
        const delta = round3(exp - recv);
        if (delta > tolerance) violations.push({ leg: 'export', delta, base: Math.max(recv, exp) });
      }
      // osr leg — relaxed when the load passed through a documented interim site.
      if (!interim && isNumber(exp) && isNumber(osr)) {
        const delta = round3(osr - exp);
        if (delta > tolerance) violations.push({ leg: 'osr', delta, base: Math.max(exp, osr) });
      }

      if (violations.length === 0) continue;

      // Score scales with the worst *relative* overflow so the most egregious
      // failures rank top, with a floor so any impossible chain still ranks high.
      const worstRel = violations.reduce((m, v) => {
        const denom = v.base > 0 ? v.base : 1;
        return Math.max(m, v.delta / denom);
      }, 0);
      const score = Math.min(100, Math.round(baseScore + worstRel * (100 - baseScore)));

      findings.push(
        makeFinding({
          detectorId: ChainMassBalance.meta.id,
          version: ChainMassBalance.meta.version,
          subject: {
            type: SUBJECT_TYPE.LOAD,
            id: i,
            label: `Load #${i} — ${load.operatorId || 'unknown operator'}`,
          },
          score,
          severity: SEVERITY.CRITICAL, // an impossible chain is always critical
          reason: reasonFor(violations, { recv, exp, osr }),
          evidence: {
            recv: isNumber(recv) ? round3(recv) : null,
            exp: isNumber(exp) ? round3(exp) : null,
            osr: isNumber(osr) ? round3(osr) : null,
            interimHandling: load.interimHandling || null,
            violations: violations.map((v) => ({ leg: v.leg, delta: v.delta })),
          },
          thresholdsUsed: { tolerance, baseScore },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(ChainMassBalance);
