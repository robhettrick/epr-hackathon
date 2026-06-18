'use strict';

/**
 * explain/index.js — the layer that fills `Finding.reason` (ADR-007, PRD §5.2).
 *
 * Every finding's investigator-facing reason flows through here, so reason
 * resolution lives in ONE generic place with no per-detector branching (ADR-004).
 * The engine runs each detector's findings through `applyReasons` after fan-out,
 * which is why the web detail view shows a reason for any finding.
 *
 * Resolution precedence (first hit wins):
 *   1. On-disk cache (`cache.js`) — a reason produced earlier (by the LLM) and
 *      replayed deterministically. This is the primary source even when the flag
 *      is OFF: a pre-populated cache serves real model prose with no network.
 *   2. LLM (`llm.js`) — only when the explainer flag is ON and the cache missed;
 *      the result is written to the cache for next time. Any failure (missing
 *      SDK, network, bad output) degrades silently to the next tier.
 *   3. The detector's own reason — detectors already compose an evidence-specific
 *      explanation (ADR-007's "tripped detector + evidence → reason"); it is
 *      richer than a generic stub, so it is preferred over one.
 *   4. The per-detector stub (`stubs.json`) — the static fallback that guarantees
 *      every finding carries a reason with no network and no key. A detector with
 *      no entry uses `stubs.default`.
 *
 * Flag (OFF by default — determinism guardrail, CLAUDE.md/ADR-007): the LLM path
 * is enabled per-call via `options.llm === true`, else by env `EXPLAIN_LLM` in
 * (`on`, `1`, `true`). The golden-path demo sets none of these, so it runs from
 * tiers 1/3/4 only.
 *
 * Dependency rule (ADR C4): explain → model. Consumed by engine/web, never the
 * reverse.
 */

const { makeFinding } = require('../model/finding');
const cache = require('./cache');
const llm = require('./llm');
const STUBS = require('./stubs.json');

/**
 * Stable per-finding identity used as the cache key. Combines the detector with
 * the subject so one finding maps to one cache entry regardless of triage order.
 */
function findingKey(finding) {
  const subject = finding.subject || {};
  return `${finding.detectorId}:${subject.type}:${subject.id}`;
}

/** The per-detector stub, or the shared default when the detector has no entry. */
function stubFor(detectorId) {
  return (detectorId && STUBS[detectorId]) || STUBS.default;
}

/** Whether the live LLM path is enabled for this call (flag OFF by default). */
function isLlmEnabled(options = {}) {
  if (typeof options.llm === 'boolean') return options.llm;
  const flag = process.env.EXPLAIN_LLM;
  return flag === 'on' || flag === '1' || flag === 'true';
}

/**
 * Resolve the reason string for one finding via the precedence above. Never
 * throws — the LLM tier is fully guarded so the explainer can't break a run.
 *
 * @param {object} finding the Finding to explain.
 * @param {object} [options] `{ llm?: boolean, cacheDir?: string, client?: object }`.
 * @returns {Promise<string>}
 */
async function reasonFor(finding, options = {}) {
  const key = findingKey(finding);

  // 1. Cache (primary, deterministic, no network) — used regardless of the flag.
  const cached = cache.read(key, options.cacheDir);
  if (cached) return cached;

  // 2. LLM — flag-gated, cache-on-success, degrade on any failure.
  if (isLlmEnabled(options)) {
    try {
      const reason = await llm.explain(finding, options);
      if (typeof reason === 'string' && reason.trim()) {
        cache.write(key, reason, options.cacheDir);
        return reason;
      }
    } catch (e) {
      // Determinism guardrail: a failed model call never aborts; fall through.
    }
  }

  // 3. The detector's own evidence-derived reason, if it supplied one.
  if (typeof finding.reason === 'string' && finding.reason.trim()) return finding.reason;

  // 4. The per-detector stub (always present).
  return stubFor(finding.detectorId);
}

/**
 * Rebuild a frozen Finding with a new reason, preserving every other field. A
 * Finding is immutable (ADR: detectors are pure), so a changed reason means a
 * new object via `makeFinding`.
 */
function withReason(finding, reason) {
  if (finding.reason === reason) return finding; // unchanged → keep the original
  return makeFinding({
    detectorId: finding.detectorId,
    version: finding.version,
    subject: finding.subject,
    score: finding.score,
    severity: finding.severity,
    reason,
    evidence: finding.evidence,
    thresholdsUsed: finding.thresholdsUsed,
    runMeta: finding.runMeta,
  });
}

/**
 * Apply resolved reasons to a list of findings, returning new findings whose
 * `reason` comes from this layer. Order is preserved.
 *
 * @param {object[]} findings the detector's Finding[].
 * @param {object} [options] resolution options (see `reasonFor`).
 * @returns {Promise<object[]>}
 */
async function applyReasons(findings, options = {}) {
  if (!Array.isArray(findings)) return [];
  const out = [];
  for (const finding of findings) {
    const reason = await reasonFor(finding, options); // eslint-disable-line no-await-in-loop
    out.push(withReason(finding, reason));
  }
  return out;
}

module.exports = { applyReasons, reasonFor, withReason, findingKey, stubFor, isLlmEnabled };
