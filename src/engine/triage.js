'use strict';

/**
 * engine/triage.js — per-detector ranking + threshold-driven surfacing (ADR-005/009,
 * PRD §5.3, golden-path step 6).
 *
 * Each detector emits its own `Finding[]`; triage turns ONE such list into a ranked,
 * surfaced view a regulator works top-down:
 *
 *   1. RANK by `score` descending (ADR-005: scores are detector-local and need only
 *      be monotonic within the detector; triage never reinterprets or rescales them).
 *   2. KEEP `severity` as a tag — it is NOT the sort key (PRD §5.3); it can optionally
 *      gate surfacing (`minSeverity`).
 *   3. SURFACE by threshold — findings below the detector's current threshold are
 *      withheld (returned as `hidden`, not dropped, so the UI can say "N below
 *      threshold"). Raising the threshold surfaces fewer findings; this is exactly the
 *      live re-rank the demo shows (ADR-009 — the web layer recomputes triage per
 *      request from GET query params overlaid on the detector's config).
 *
 * PURE + RE-RUNNABLE (ADR-009): `triage(findings, options)` is a pure function of its
 * inputs — no I/O, no detector knowledge, no mutation of the input array or the
 * Findings (which are frozen anyway). The web layer can call it once per request with
 * the request's thresholds to re-render without re-running detectors (ADR-002/010).
 *
 * GENERIC (ADR-004): triage names no detector and knows no detector-specific config
 * shape. The caller resolves "the detector's current threshold config" (its
 * `meta.config` defaults overlaid with `config.json` and any request override) into
 * the plain `{ minScore, minSeverity, limit }` options below. That keeps the
 * config→threshold mapping in one place (the web/engine caller, item F) and triage a
 * stable, testable seam.
 *
 * Options are coerced defensively rather than validated loudly: they originate from
 * GET query params (ADR-009), so a malformed `?minScore=abc` degrades to "no
 * threshold" instead of 500-ing the page — the same partial-data spirit as ingest.
 *
 * Dependency rule (ADR C4): `engine → model`. Depends only on the Finding severity
 * enum, nothing outward.
 */

const { SEVERITIES } = require('../model/finding');

/**
 * Default surfacing options: surface everything, ranked by score desc.
 *   minScore     surface only findings with `score >= minScore` (0–100).
 *   minSeverity  surface only findings at least this severe (a `SEVERITY` value),
 *                or null for no severity gate.
 *   limit        investigator-capacity cap (PRD §5.3): surface at most this many of
 *                the passing findings, or null for no cap.
 */
const SURFACE_DEFAULTS = Object.freeze({ minScore: 0, minSeverity: null, limit: null });

/**
 * Severity rank: higher = more severe. Reads the `SEVERITIES` order (low→critical)
 * so the enum stays the single source of truth. An unknown severity ranks -1 (below
 * every gate), which can only happen if a Finding bypassed `makeFinding`.
 * @param {string} severity
 * @returns {number}
 */
function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

/**
 * Coerce a raw `minScore` (possibly a query-param string) to a number in 0–100.
 * Non-numeric / NaN → 0 (no floor); out-of-range values clamp to the bounds.
 * @param {*} raw
 * @returns {number}
 */
function coerceMinScore(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Coerce a raw `minSeverity` to a valid severity or null (no gate). An unrecognised
 * value is ignored rather than throwing (query-param origin).
 * @param {*} raw
 * @returns {string|null}
 */
function coerceMinSeverity(raw) {
  return SEVERITIES.includes(raw) ? raw : null;
}

/**
 * Coerce a raw `limit` to a positive integer or null (no cap). Zero, negatives and
 * non-integers fall back to null.
 * @param {*} raw
 * @returns {number|null}
 */
function coerceLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * Comparator: rank Findings by `score` descending, with deterministic tie-breaks so
 * the demo is reproducible regardless of the engine's sort stability — equal scores
 * fall back to severity (more severe first), then subject id (ascending, as text).
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function byScoreDesc(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const sev = severityRank(b.severity) - severityRank(a.severity);
  if (sev !== 0) return sev;
  return String(a.subject && a.subject.id).localeCompare(String(b.subject && b.subject.id));
}

/**
 * Triage one detector's findings: rank by score desc and split into the findings that
 * surface under the current threshold and those withheld below it.
 *
 * @param {object[]} findings a single detector's `Finding[]` (other inputs tolerated:
 *   a non-array degrades to an empty result rather than throwing).
 * @param {object} [options] surfacing thresholds, typically derived from the
 *   detector's config overlaid with request query params:
 * @param {number|string} [options.minScore=0]      minimum score to surface (0–100).
 * @param {string} [options.minSeverity=null]        minimum severity to surface.
 * @param {number|string} [options.limit=null]       max findings to surface (capacity).
 * @returns {{
 *   surfaced: object[],
 *   hidden: object[],
 *   total: number,
 *   surfacedCount: number,
 *   hiddenCount: number,
 *   thresholds: { minScore: number, minSeverity: (string|null), limit: (number|null) },
 * }} `surfaced` and `hidden` are both ranked score-desc; `thresholds` echoes the
 *   resolved (coerced) thresholds for the UI/audit. Surfacing is the union test
 *   `score >= minScore AND severity >= minSeverity`, then capped at `limit`.
 */
function triage(findings, options = {}) {
  const list = Array.isArray(findings) ? findings : [];

  const minScore = coerceMinScore(options.minScore);
  const minSeverity = coerceMinSeverity(options.minSeverity);
  const limit = coerceLimit(options.limit);
  const minSeverityRank = minSeverity === null ? -Infinity : severityRank(minSeverity);

  // Sort a COPY — the caller's array (and the orchestrator's `byDetector` lists) must
  // not be reordered by a read-only triage pass.
  const ranked = [...list].sort(byScoreDesc);

  const surfaced = [];
  const hidden = [];
  for (const finding of ranked) {
    const passesThreshold =
      finding.score >= minScore && severityRank(finding.severity) >= minSeverityRank;
    // `limit` caps the *passing* findings only; anything it drops is still "hidden",
    // so both lists stay ranked score-desc.
    if (passesThreshold && (limit === null || surfaced.length < limit)) {
      surfaced.push(finding);
    } else {
      hidden.push(finding);
    }
  }

  return {
    surfaced,
    hidden,
    total: ranked.length,
    surfacedCount: surfaced.length,
    hiddenCount: hidden.length,
    thresholds: { minScore, minSeverity, limit },
  };
}

module.exports = { triage, byScoreDesc, severityRank, SURFACE_DEFAULTS };
