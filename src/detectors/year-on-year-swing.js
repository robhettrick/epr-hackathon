'use strict';

/**
 * detectors/year-on-year-swing.js — cross-period tonnage swing (PRD §6 "later" set,
 * completion-pass scope; PRD §5.1 "Cross-period", docs/anomaly-scenarios-from-sample.md
 * H2 / whiteboard #9 — "compare received tonnes for this operator, year-on-year").
 *
 * Why a period, not a load or an entity
 * -------------------------------------
 * The other detectors judge a single load (mass-balance, EWC, temporal) or a derived
 * entity (a supplier, an OSR, a vehicle). This one judges a *reporting period*: it
 * totals each operator's received-for-export tonnage (`S`, col S /
 * `tonnageReceivedForExport`) per calendar year and compares each year against the
 * operator's previous available year. A large swing in the volume an operator pushes
 * through the export chain — up or down — is the H2 anomaly: it can flag a sudden
 * ramp (capacity that may not exist), a collapse (activity moved off-book), or simply
 * a re-submission whose figures no longer match the prior filing. Only visible once a
 * **prior-period** submission is ingested alongside the current one (the file is
 * otherwise single-year): the curated demo seeds a 2024 AL re-submission slice
 * (`fixtures/demo/demo_exporter_AL_2024.xlsx`) to pair against the 2026 AL file. On
 * the default golden-path demo (2026-only) every operator has a single period, so
 * this detector is correctly silent and the five ★ counts are undisturbed.
 *
 * The subject is a **period** (`SUBJECT_TYPE.PERIOD`), one finding per flagged
 * operator-and-year-pair, with a stable id `${operatorId}:${prevYear}->${currYear}`.
 * Periods are paired in chronological order against the *previous available* year, so
 * a gap (2024 → 2026, no 2025 submission) compares 2026 against 2024 rather than
 * silently dropping the comparison.
 *
 * Robustness: the swing is a relative change in the period total, gated by a
 * `minTonnage` floor so a large *percentage* move on a negligible volume (the classic
 * small-denominator artefact) is not flagged — the change must involve real tonnage to
 * count. A period with no prior tonnage but real current tonnage ("appeared from
 * nothing") is treated as a maximal swing.
 *
 * The period year is taken from each load's export date (`exported`, col U), falling
 * back to `receivedForExport` (G) then `receivedByOsr` (Y) — the reporting year of the
 * submission. A load carrying none of the three dates cannot be placed in a period and
 * is a coverage gap, skipped from the aggregation (never a crash, ADR C3).
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   maxRelSwing  relative change in S a period may show before it is flagged — flag
 *               when `|Δ/prev| > this` (default 0.5 — a ±50% year-on-year move).
 *   minTonnage  robustness floor: ignore a swing unless at least one of the two
 *               periods exceeds this many tonnes of S (default 100), so a big % move on
 *               trivial volume is not surfaced.
 *   baseScore   score floor for a just-over-threshold swing (default 60).
 *   highSwing   |relative change| at/above which the score saturates to 100 and
 *               severity escalates from medium to high (default 2.0 — a tripling/third).
 *
 * Pure & deterministic (ADR-004): reads frozen Loads, emits Findings, no I/O at
 * evaluate time. Self-registers on import. Dependency rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

/** A usable threshold is a finite number; anything else falls back to the default. */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A real Date, or null. */
function isDate(v) {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** The reporting year for a load: export year, else received-for-export, else OSR. */
function periodYear(load) {
  const date = [load.exported, load.receivedForExport, load.receivedByOsr].find(isDate);
  return date ? date.getUTCFullYear() : null;
}

/** A finite tonnage ≥ 0, else 0 (blank/garbage S degrades to no contribution). */
function tonnage(v) {
  return isNumber(v) && v > 0 ? v : 0;
}

/** Round a tonnage to 1 dp for stable, human-readable evidence. */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Relative change from `prev` to `curr`. Standard `(curr - prev) / prev` when there
 * was prior tonnage; when there was none but the current period has tonnage the load
 * "appeared from nothing" — an unbounded swing, returned as `Infinity` (capped by the
 * caller for scoring). Both-zero is no change.
 */
function relativeChange(prev, curr) {
  if (prev > 0) return (curr - prev) / prev;
  if (curr > 0) return Infinity;
  return 0;
}

const YearOnYearSwing = {
  meta: {
    id: 'year-on-year-swing',
    title: 'Year-on-year tonnage swing for an operator',
    description: "Compares an operator's total received-for-export tonnage between years and flags a large swing against the previous year's submission.",
    scope: SUBJECT_TYPE.PERIOD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      maxRelSwing: 0.5, // flag a relative S change whose magnitude EXCEEDS this
      minTonnage: 100, // at least one period must exceed this S, else the swing is noise
      baseScore: 60, // score floor for a just-over-threshold swing
      highSwing: 2.0, // |relative change| at/above which score saturates + severity → high
    },
  },

  /**
   * @param {{loads?: object[]}} data ingested dataset (uses `data.loads`; needs a
   *   prior-period submission ingested alongside the current one to compare).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per operator-year whose S swings beyond the threshold.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || YearOnYearSwing.meta.config;
    const defaults = YearOnYearSwing.meta.config;

    const maxRelSwing = isNumber(cfg.maxRelSwing) && cfg.maxRelSwing >= 0
      ? cfg.maxRelSwing
      : defaults.maxRelSwing;
    const minTonnage = isNumber(cfg.minTonnage) && cfg.minTonnage >= 0
      ? cfg.minTonnage
      : defaults.minTonnage;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const highSwing = isNumber(cfg.highSwing) && cfg.highSwing > 0
      ? cfg.highSwing
      : defaults.highSwing;

    // Aggregate S per (operatorId, year): operator → Map<year, {tonnage, loads}>.
    const byOperator = new Map();
    for (const load of loads) {
      if (!load) continue;
      const operatorId = load.operatorId;
      if (operatorId === null || operatorId === undefined || operatorId === '') continue;
      const year = periodYear(load); // null ⇒ undateable, can't be placed in a period
      if (year === null) continue;

      let years = byOperator.get(operatorId);
      if (!years) {
        years = new Map();
        byOperator.set(operatorId, years);
      }
      const bucket = years.get(year) || { tonnage: 0, loads: 0 };
      bucket.tonnage += tonnage(load.tonnageReceivedForExport);
      bucket.loads += 1;
      years.set(year, bucket);
    }

    const findings = [];
    for (const [operatorId, years] of byOperator) {
      const ordered = [...years.keys()].sort((a, b) => a - b); // chronological
      if (ordered.length < 2) continue; // no prior period for this operator — nothing to compare

      for (let i = 1; i < ordered.length; i += 1) {
        const prevYear = ordered[i - 1];
        const currYear = ordered[i];
        const prev = years.get(prevYear);
        const curr = years.get(currYear);

        const relChange = relativeChange(prev.tonnage, curr.tonnage);
        const magnitude = Math.abs(relChange);
        if (magnitude <= maxRelSwing) continue; // within the allowed year-on-year move
        // Robustness floor: a big % move on negligible volume is a small-denominator
        // artefact, not a real swing — require real tonnage in at least one period.
        if (Math.max(prev.tonnage, curr.tonnage) < minTonnage) continue;

        const direction = curr.tonnage >= prev.tonnage ? 'increase' : 'decrease';
        // Score floored at baseScore, scaling with the swing magnitude (a wider swing
        // ranks higher), saturating to 100 at highSwing (Infinity → reach 1).
        const reach = Math.min(magnitude / highSwing, 1);
        const score = Math.min(100, Math.round(baseScore + reach * (100 - baseScore)));
        const severity = magnitude >= highSwing ? SEVERITY.HIGH : SEVERITY.MEDIUM;
        // Infinity (appeared from nothing) is not JSON-representable — surface null
        // plus the direction so the detail view reads cleanly.
        const relPct = Number.isFinite(relChange) ? Math.round(relChange * 1000) / 10 : null;
        const label = `${operatorId} ${prevYear}→${currYear}`;

        findings.push(
          makeFinding({
            detectorId: YearOnYearSwing.meta.id,
            version: YearOnYearSwing.meta.version,
            subject: {
              type: SUBJECT_TYPE.PERIOD,
              id: `${operatorId}:${prevYear}->${currYear}`,
              label,
            },
            score,
            severity,
            reason: relPct === null
              ? `Operator ${operatorId} reported ${round1(curr.tonnage)} t received for export in ${currYear} against none in ${prevYear} — a new flow appearing from nothing. A large year-on-year swing in declared tonnage warrants a look at whether the capacity and chain support it.`
              : `Operator ${operatorId}'s received-for-export tonnage moved ${relPct > 0 ? 'up' : 'down'} ${Math.abs(relPct)}% from ${round1(prev.tonnage)} t in ${prevYear} to ${round1(curr.tonnage)} t in ${currYear}, beyond the ${Math.round(maxRelSwing * 100)}% year-on-year threshold. A large swing in declared tonnage warrants a look at whether the capacity and chain support it.`,
            evidence: {
              operatorId,
              priorYear: prevYear,
              currentYear: currYear,
              priorTonnage: round1(prev.tonnage),
              currentTonnage: round1(curr.tonnage),
              deltaTonnage: round1(curr.tonnage - prev.tonnage),
              relativeChangePct: relPct,
              direction,
              priorLoads: prev.loads,
              currentLoads: curr.loads,
            },
            thresholdsUsed: { maxRelSwing, minTonnage, highSwing },
          }),
        );
      }
    }

    return findings;
  },
};

module.exports = register(YearOnYearSwing);
