'use strict';

/**
 * engine/aggregate.js — the combined per-subject aggregate score (ADR-005, PRD §5.3
 * stretch, architecture §9 `engine/ … (aggregate.js — stretch)`).
 *
 * Each detector owns its OWN ranked list and emits a **detector-local** score that is
 * only guaranteed monotonic within that detector (ADR-005). Triage ranks one such list.
 * This module answers the orthogonal question a regulator also asks: *"which SUBJECT is
 * most worth my time, across everything we run?"* — by fusing every finding that names
 * the same subject (a load, a supplier, an OSR, a vehicle, a country, a period) into one
 * combined 0–100 score and ranking subjects by it.
 *
 * Why this is a SEPARATE pure function, not a detector concern (ADR-005)
 * ---------------------------------------------------------------------
 * Cross-detector score comparability is genuinely hard, so the architecture deliberately
 * keeps detectors decoupled and defers fusion to here, "with its own calibration step".
 * This function IS that calibration step: the weights and the fusion `method` live here,
 * never in a detector. Adding/removing a detector changes the combined queue with zero
 * edits to any detector (the same generic-seam discipline as the orchestrator, ADR-004).
 *
 * Purity (ADR C4): `aggregate(findings, options)` is a pure function of its inputs — no
 * I/O, no detector knowledge, no mutation of the input array or the (frozen) Findings.
 * It can be re-run per request with different weights for a live "combined view" exactly
 * as triage is re-run for the live per-detector re-rank.
 *
 * Subject identity
 * ----------------
 * A "subject" is the `(subject.type, subject.id)` pair from the Finding contract
 * (PRD §5.2). Two findings fuse iff they name the same type AND id — so a load flagged by
 * three row-level detectors fuses, and an OSR flagged by both `osr-refusal-rate` and
 * `single-customer←many-operators` fuses, but a load and a supplier never collide even if
 * their ids happen to match. Corroboration across detectors is the whole signal: a subject
 * multiple independent detectors flag outranks one any single detector merely scores high.
 *
 * Fusion methods (research §"weighted-max / weighted-mean / voting — swappable")
 * -----------------------------------------------------------------------------
 *   'noisy-or'      (default) — treat each detector's score/100 as an independent
 *                   probability of "this subject is anomalous" and combine via
 *                   `1 − Π(1 − wᵢ·sᵢ/100)`. Saturates at 100, so corroboration always
 *                   raises the score above any single signal yet never overflows; a lone
 *                   score of 100 stays 100. This is the principled default.
 *   'weighted-mean' — `Σ(wᵢ·sᵢ) / Σwᵢ`. Averages the signals; corroboration by agreement,
 *                   not accumulation. Lower than noisy-or when signals disagree.
 *   'max'           — `max(min(100, wᵢ·sᵢ))`. The single strongest (weighted) signal,
 *                   ignoring corroboration. The conservative floor.
 *
 * Within one subject, each detector is first collapsed to its highest contributing score
 * (a detector that emits several findings for one subject is ONE signal, not many — it
 * must not be double-counted as independent corroboration).
 *
 * Severity is the **maximum** severity among the subject's findings (a subject is at
 * least as severe as its worst single signal — corroboration must never DOWNgrade it),
 * read off the model's `SEVERITIES` order so the enum stays the single source of truth.
 *
 * Dependency rule (ADR C4): `engine → model`. Depends only on the Finding severity enum.
 */

const { SEVERITIES } = require('../model/finding');

/** The fusion methods this module understands; anything else falls back to the default. */
const METHODS = Object.freeze(['noisy-or', 'weighted-mean', 'max']);
const DEFAULT_METHOD = 'noisy-or';

/** Default per-detector weight when `options.weights` names no value for a detector. */
const DEFAULT_WEIGHT = 1;

/**
 * Severity rank: higher = more severe, read from `SEVERITIES` (low→critical) so the enum
 * stays the single source of truth. An unknown severity ranks -1 (below every real one).
 * @param {string} severity
 * @returns {number}
 */
function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

/**
 * Resolve a detector's weight from `options.weights`. A missing entry defaults to 1; a
 * non-finite or negative weight clamps to 0 (a weight is a non-negative multiplier).
 * Defensive like triage's option coercion — weights may come from runtime config/UI.
 * @param {object} weights detectorId → number map (may be undefined).
 * @param {string} detectorId
 * @returns {number}
 */
function weightFor(weights, detectorId) {
  if (!weights || !Object.prototype.hasOwnProperty.call(weights, detectorId)) {
    return DEFAULT_WEIGHT;
  }
  const w = Number(weights[detectorId]);
  if (!Number.isFinite(w) || w < 0) return DEFAULT_WEIGHT;
  return w;
}

/** Clamp a number into 0–100. */
function clamp100(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Fuse one subject's per-detector contributions into a single 0–100 score.
 * @param {Array<{score:number, weight:number}>} contributions one entry per contributing
 *   detector (already collapsed to that detector's best score for this subject).
 * @param {string} method one of `METHODS`.
 * @returns {number} the combined score, 0–100 (not yet rounded).
 */
function fuse(contributions, method) {
  if (contributions.length === 0) return 0;

  if (method === 'max') {
    return contributions.reduce((acc, c) => Math.max(acc, clamp100(c.weight * c.score)), 0);
  }

  if (method === 'weighted-mean') {
    let weighted = 0;
    let totalWeight = 0;
    for (const c of contributions) {
      weighted += c.weight * c.score;
      totalWeight += c.weight;
    }
    // All-zero weights → no signal survives; report 0 rather than dividing by zero.
    return totalWeight === 0 ? 0 : clamp100(weighted / totalWeight);
  }

  // 'noisy-or' (default): 1 − Π(1 − pᵢ), where pᵢ = clamp(wᵢ·sᵢ/100) is the detector's
  // weighted probability that the subject is anomalous. Independent-evidence fusion.
  let complement = 1;
  for (const c of contributions) {
    const p = clamp100(c.weight * c.score) / 100;
    complement *= 1 - p;
  }
  return clamp100((1 - complement) * 100);
}

/**
 * Aggregate a flat `Finding[]` (across ALL detectors) into one combined, ranked record
 * per subject — the "combined per-subject score" (PRD §5.3 stretch, ADR-005).
 *
 * @param {object[]} findings every detector's findings, flattened into one array. A
 *   non-array (or a finding with no usable subject) degrades gracefully rather than
 *   throwing — same partial-data spirit as ingest/triage.
 * @param {object} [options]
 * @param {Object<string,number>} [options.weights] per-detector weight (detectorId →
 *   number); missing detectors weigh `1`, negatives/NaN clamp to `0`. This is the
 *   calibration knob ADR-005 reserves for the aggregate layer.
 * @param {string} [options.method='noisy-or'] fusion method, one of `METHODS`; an
 *   unrecognised value falls back to the default.
 * @returns {{
 *   subjects: Array<{
 *     subject: { type: string, id: (string|number), label: (string|null) },
 *     score: number,
 *     severity: string,
 *     detectorCount: number,
 *     findingCount: number,
 *     contributors: Array<{ detectorId: string, score: number, severity: string, weight: number }>,
 *     findings: object[],
 *   }>,
 *   count: number,
 *   method: string,
 * }} `subjects` is ranked combined-score desc (deterministic tie-breaks); `score` is the
 *   fused 0–100 score rounded to an integer; `contributors` lists each contributing
 *   detector's best score (desc) so a UI/CSV can explain the combined number;
 *   `findings` keeps the contributing Findings for drill-down.
 */
function aggregate(findings, options = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const method = METHODS.includes(options.method) ? options.method : DEFAULT_METHOD;
  const weights = options.weights;

  // Group findings by subject identity. A NUL separator can't appear in a type/id, so
  // `type id` is a collision-free key across the heterogeneous id space (load index
  // numbers, entity identity keys, period labels).
  const groups = new Map();
  for (const finding of list) {
    const subject = finding && finding.subject;
    if (!subject || subject.id === null || subject.id === undefined || subject.id === '') {
      continue; // not a usable subject — skip rather than throw (partial-data spirit).
    }
    const key = `${subject.type} ${subject.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { subject, findings: [] };
      groups.set(key, group);
    }
    group.findings.push(finding);
  }

  const subjects = [];
  for (const group of groups.values()) {
    // Collapse to ONE contribution per detector (its best score for this subject) so a
    // detector emitting several findings for the subject counts as a single signal, not
    // as independent corroboration. Track the severest contributing severity per detector.
    const byDetector = new Map();
    let maxSeverityRank = -1;
    let maxSeverity = null;
    for (const finding of group.findings) {
      const id = finding.detectorId;
      const existing = byDetector.get(id);
      if (!existing || finding.score > existing.score) {
        byDetector.set(id, {
          detectorId: id,
          score: finding.score,
          severity: finding.severity,
          weight: weightFor(weights, id),
        });
      }
      const r = severityRank(finding.severity);
      if (r > maxSeverityRank) {
        maxSeverityRank = r;
        maxSeverity = finding.severity;
      }
    }

    const contributors = [...byDetector.values()].sort(
      (a, b) => b.score - a.score || a.detectorId.localeCompare(b.detectorId),
    );
    const combined = Math.round(fuse(contributors, method));

    subjects.push({
      subject: {
        type: group.subject.type,
        id: group.subject.id,
        label: group.subject.label === undefined ? null : group.subject.label,
      },
      score: combined,
      severity: maxSeverity,
      detectorCount: contributors.length,
      findingCount: group.findings.length,
      contributors,
      findings: group.findings,
    });
  }

  // Rank subjects by combined score desc, with deterministic tie-breaks so the combined
  // queue is reproducible: more detectors corroborating first, then severer, then by
  // subject id (as text) — mirroring triage's tie-break philosophy.
  subjects.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.detectorCount !== a.detectorCount) return b.detectorCount - a.detectorCount;
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev !== 0) return sev;
    return String(a.subject.id).localeCompare(String(b.subject.id));
  });

  return { subjects, count: subjects.length, method };
}

module.exports = { aggregate, fuse, severityRank, METHODS, DEFAULT_METHOD, DEFAULT_WEIGHT };
