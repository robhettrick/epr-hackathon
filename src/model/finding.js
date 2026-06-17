'use strict';

/**
 * model/finding.js — the uniform `Finding` contract + `makeFinding(spec)` factory.
 *
 * A `Finding` is the single output shape every detector emits (PRD §5.2). Because
 * the contract is uniform, the engine, triage, and the web UI are all generic —
 * there is no per-detector branching anywhere downstream (ADR-004): a detector is
 * `evaluate(data, ctx) → Finding[]`, and everything after consumes `Finding[]`.
 *
 * Like `Load`/`Entity` this is an innermost domain type (ADR C4): pure data + a
 * factory, no dependencies on other `src/` modules.
 *
 * Contract (PRD §5.2):
 *   detectorId      which detector produced this (e.g. "ewc-not-packaging")
 *   version         detector version, for reproducibility (ADR-008)
 *   subject         { type, id, label } — the thing flagged (a load or an entity)
 *   score           0–100, normalised so lists rank and (optionally) combine
 *   severity        low | medium | high | critical (a tag, not the sort key)
 *   reason          plain-English, investigator-facing (from the explain layer)
 *   evidence        the fields/records that justify it (drives the detail view)
 *   thresholdsUsed  echo of the config used, for auditability
 *   runMeta         detector+config version, dataset snapshot, timestamp (ADR-008)
 *
 * Validation policy — opposite to `Load`. `Load` coerces external spreadsheet data
 * and NEVER throws (a bad row degrades to partial data). A `Finding`, by contrast,
 * is produced by OUR OWN code: an out-of-range score or an unknown severity is a
 * programmer error in a detector, not dirty input, so `makeFinding` THROWS on it.
 * Failing loudly here keeps a malformed Finding from silently poisoning the ranked
 * lists a regulator acts on.
 */

/** Allowed severities, ordered low → critical (PRD §5.2 / §5.3). */
const SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SEVERITIES = Object.freeze(Object.values(SEVERITY));

/** Subject kinds a finding can be about — a raw load, or a derived entity
 * (mirrors `ENTITY_TYPE` plus `load`). Matches PRD §5.2's `subject.type`. */
const SUBJECT_TYPE = Object.freeze({
  LOAD: 'load',
  OPERATOR: 'operator',
  SUPPLIER: 'supplier',
  OSR: 'osr',
  VEHICLE: 'vehicle',
  COUNTRY: 'country',
});

const SUBJECT_TYPES = Object.freeze(Object.values(SUBJECT_TYPE));

/**
 * Build a validated, frozen `Finding`.
 *
 * @param {object} spec
 * @param {string} spec.detectorId        id of the emitting detector (required).
 * @param {string} [spec.version]          detector version (defaults to '0').
 * @param {object} spec.subject            what is flagged: `{ type, id, label }`.
 * @param {string} spec.subject.type       one of `SUBJECT_TYPE`.
 * @param {string|number} spec.subject.id  stable id of the subject.
 * @param {string} [spec.subject.label]    human-readable label for the subject.
 * @param {number} spec.score              normalised 0–100 (required, validated).
 * @param {string} spec.severity           one of `SEVERITY` (required, validated).
 * @param {string} [spec.reason]           investigator-facing explanation.
 * @param {object} [spec.evidence]         the figures/records that justify it.
 * @param {object} [spec.thresholdsUsed]   echo of the config thresholds applied.
 * @param {object} [spec.runMeta]          run stamp (populated by the engine, ADR-008).
 * @returns {object} a frozen Finding matching the PRD §5.2 contract.
 * @throws {TypeError} on a missing detectorId / malformed subject.
 * @throws {RangeError} on a score outside 0–100 or a severity/subject.type not in the enum.
 */
function makeFinding(spec = {}) {
  const {
    detectorId,
    version = '0',
    subject,
    score,
    severity,
    reason = null,
    evidence = {},
    thresholdsUsed = {},
    runMeta = {},
  } = spec;

  if (typeof detectorId !== 'string' || detectorId.trim() === '') {
    throw new TypeError('makeFinding: detectorId is required (non-empty string)');
  }

  if (subject === null || typeof subject !== 'object') {
    throw new TypeError('makeFinding: subject is required ({ type, id, label })');
  }
  if (!SUBJECT_TYPES.includes(subject.type)) {
    throw new RangeError(
      `makeFinding: subject.type "${subject.type}" not one of ${SUBJECT_TYPES.join(', ')}`,
    );
  }
  if (subject.id === null || subject.id === undefined || subject.id === '') {
    throw new TypeError('makeFinding: subject.id is required');
  }

  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError(`makeFinding: score must be a number in 0–100, got ${score}`);
  }

  if (!SEVERITIES.includes(severity)) {
    throw new RangeError(
      `makeFinding: severity "${severity}" not one of ${SEVERITIES.join(', ')}`,
    );
  }

  const finding = {
    detectorId,
    version: String(version),
    subject: Object.freeze({
      type: subject.type,
      id: subject.id,
      label: subject.label === undefined ? null : subject.label,
    }),
    score,
    severity,
    reason,
    evidence,
    thresholdsUsed,
    runMeta,
  };

  return Object.freeze(finding);
}

module.exports = { makeFinding, SEVERITY, SEVERITIES, SUBJECT_TYPE, SUBJECT_TYPES };
