'use strict';

/**
 * detectors/vehicle-plate-format.js — flag loads whose carrier vehicle
 * registration (BE) is not a plausible UK number plate (PRD §6 "later" set,
 * completion-pass scope; docs/whiteboard-scenarios-vs-data.md #7 — the in-file
 * proxy for the cross-operator "same vehicle" question).
 *
 * A carrier's vehicle registration should be a real UK plate. A value that does
 * not match ANY recognised UK registration format cannot identify a real vehicle,
 * so the movement either was never made by a roadworthy vehicle or the reg was
 * fabricated/mistyped — a "ghost vehicle" data-integrity signal worth a look. This
 * is a purely *syntactic* check (is this string shaped like a plate at all?), not a
 * DVLA lookup; a well-formed but non-existent plate is out of scope here.
 *
 * Recognised formats (whitespace and punctuation are normalised out, case-folded):
 *   current  2001+        AB12 CDE   2 letters, 2 numbers, 3 letters
 *   prefix   1983–2001    A123 BCD   1 letter, 1–3 numbers, 3 letters
 *   suffix   1963–1983    ABC 123D   3 letters, 1–3 numbers, 1 letter
 *   dateless pre-1963/NI  ABC 1234   1–3 letters then 1–4 numbers …
 *                         1234 AB    … or 1–4 numbers then 1–3 letters
 * A reg matching none of these is implausible. The synthetic fixture plates
 * (`AL00REG`, `SH24RED`, …) are all current-format and pass; the seeded
 * `NOTAPLATE` matches nothing and is the single demo hit (fixtures/demo/README.md).
 *
 * A load with no registration is a coverage gap, not a malformed plate, so it is
 * silently skipped (never a crash, ADR C3). Each offending load is its own
 * `load`-scoped finding — one claimed movement, one bad plate.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   baseScore  score for any implausible plate (default 60). Plate validity is
 *              binary — there is no "how wrong" to scale — so every finding scores
 *              the same; ranking within the list falls back to load order.
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

/** The recognised UK registration shapes, tested against the normalised plate. */
const UK_PLATE_FORMATS = [
  /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/, // current  2001+ : AB12CDE
  /^[A-Z][0-9]{1,3}[A-Z]{3}$/, // prefix   1983–2001 : A123BCD
  /^[A-Z]{3}[0-9]{1,3}[A-Z]$/, // suffix   1963–1983 : ABC123D
  /^[A-Z]{1,3}[0-9]{1,4}$/, // dateless / NI : ABC1234
  /^[0-9]{1,4}[A-Z]{1,3}$/, // dateless reversed : 1234AB
];

/** Strip spaces/punctuation and upper-case so display variants normalise to one form. */
function normalisePlate(reg) {
  return String(reg).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when the normalised plate matches a recognised UK registration format. */
function isPlausibleUkPlate(normalised) {
  return normalised.length > 0 && UK_PLATE_FORMATS.some((re) => re.test(normalised));
}

/** Plain-English stub reason — the fallback until the explain layer owns reason text. */
function reasonFor(reg) {
  return (
    `The carrier vehicle registration "${reg}" does not match any recognised UK ` +
    `number-plate format, so it cannot identify a real vehicle. A fabricated or ` +
    `mistyped plate points to a possible "ghost vehicle" / data-integrity problem.`
  );
}

const VehiclePlateFormat = {
  meta: {
    id: 'vehicle-plate-format',
    title: 'Carrier vehicle registration is not a plausible UK number plate',
    description: "Flags carrier vehicle registrations that match no valid UK number-plate format, a sign of a fictitious or mistyped carrier.",
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      baseScore: 60, // score for any implausible plate (binary check, fixed score)
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per load with an implausible vehicle reg.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const defaults = VehiclePlateFormat.meta.config;
    const cfg = ctx.config || defaults;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const score = Math.min(100, Math.max(0, baseScore));

    const findings = [];
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      if (!load) continue;

      const reg = load.carrierVehicleReg;
      if (!reg) continue; // no reg = coverage gap, not a malformed plate

      const normalised = normalisePlate(reg);
      if (isPlausibleUkPlate(normalised)) continue; // looks like a real UK plate

      findings.push(
        makeFinding({
          detectorId: VehiclePlateFormat.meta.id,
          version: VehiclePlateFormat.meta.version,
          subject: {
            type: SUBJECT_TYPE.LOAD,
            id: i,
            label: `Load #${i} — ${load.operatorId || 'unknown operator'}`,
          },
          score,
          severity: SEVERITY.MEDIUM,
          reason: reasonFor(reg),
          evidence: {
            vehicleReg: reg,
            normalised,
          },
          thresholdsUsed: { baseScore },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(VehiclePlateFormat);
