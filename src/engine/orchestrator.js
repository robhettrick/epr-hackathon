'use strict';

/**
 * engine/orchestrator.js — fan-out over the detector registry (ADR-004, golden-path step 2).
 *
 * The orchestrator is the generic seam that makes "add a detector = one file +
 * register()" true end-to-end: it discovers every enabled detector via the
 * registry and runs each one's `evaluate(data, ctx)`, with **NO per-detector
 * `if/else` anywhere** (ADR-004). Adding, removing, enabling or shadowing a
 * detector changes the run with zero edits here.
 *
 * Per-detector context (ADR-006)
 * ------------------------------
 * Detectors are pure and receive everything they need via `ctx`, never from a
 * literal or a disk read of their own. For each detector the orchestrator builds:
 *
 *   ctx.config     — the detector's effective, frozen config: its `meta.config`
 *                    defaults with the runtime `config.json` override for its id
 *                    deep-merged on top (`configFor`). This is what drives the live
 *                    threshold re-rank (golden-path step 6).
 *   ctx.reference  — the ingested reference lists (allowed EWC/material codes) so
 *                    detectors like `ewc-not-packaging` validate against them.
 *
 * Any additional keys the caller puts on the base `ctx` (e.g. a future run stamp,
 * ADR-008/item H) are forwarded to every detector untouched.
 *
 * Resilience (ADR-004)
 * --------------------
 * Detectors run independently and one detector throwing MUST NOT abort the run —
 * the regulator still gets every other detector's list. A throwing detector is
 * caught, recorded in `errors`, and contributes an empty list; the run continues.
 * Each `evaluate` is awaited so the same path serves sync and async detectors.
 *
 * Shadow detectors (ADR-008)
 * --------------------------
 * `getEnabled()` returns shadow detectors too — a shadow detector RUNS and logs;
 * it simply must not surface in the UI/counts. The orchestrator runs it and marks
 * its run record `surfaced:false`; the actual hiding is triage/web's job (which
 * read this flag / `registry.isShadow`). Keeping the policy as a flag here, not a
 * filter, is what lets the downstream layers stay generic.
 *
 * Scoring (ADR-005): each detector owns its detector-local score; the orchestrator
 * does NOT reinterpret or rescale. Sorting/threshold surfacing is triage (item E).
 *
 * Reasons (ADR-007): a detector emits a finding; the investigator-facing
 * `Finding.reason` is owned by the `explain/` layer, not the detector. After
 * fan-out the orchestrator runs every detector's findings through
 * `explain.applyReasons`, so reason resolution (cache → flag-gated LLM →
 * detector text → per-detector stub) lives in one generic place with no
 * per-detector branching. The flag is OFF by default, so this is deterministic
 * and network-free on the golden path.
 *
 * Dependency rule (ADR C4): `engine → detectors → model`, and `engine → explain`
 * (explain is consumed by the engine, never the reverse).
 */

const { getEnabled, isShadow } = require('../detectors/registry');
const { loadConfig, configFor } = require('../detectors/config');
const { applyReasons } = require('../explain');

/**
 * Run one detector under guard. Never rejects: a thrown/rejected `evaluate`
 * becomes `{ findings: [], error }` so a single bad detector can't abort the run.
 *
 * @param {object} detector a registered detector (`meta`, `evaluate`).
 * @param {object} data the ingested dataset (`{ loads, entities, reference }`).
 * @param {object} ctx the per-detector context (`config`, `reference`, …).
 * @returns {Promise<{findings: object[], error: (Error|null)}>}
 */
async function runOne(detector, data, ctx) {
  try {
    const result = await detector.evaluate(data, ctx);
    // A well-behaved detector returns Finding[]; tolerate a nullish/odd return
    // rather than letting it poison the per-detector map.
    return { findings: Array.isArray(result) ? result : [], error: null };
  } catch (error) {
    return { findings: [], error };
  }
}

/**
 * Fan out over every enabled detector and collect one ranked-input list per
 * detector (golden-path step 2). Detectors run concurrently but results are
 * assembled in registration order for a deterministic, reproducible demo.
 *
 * @param {{loads?: object[], entities?: object, reference?: object}} [data]
 *   the ingested dataset from `ingest()`.
 * @param {object} [ctx] base context shared by all detectors. Recognised keys:
 *   `runtime` (pre-loaded runtime config; defaults to `loadConfig()` from disk),
 *   `reference` (fallback when `data.reference` is absent). Any other keys are
 *   forwarded to each detector's `ctx` unchanged.
 * @returns {Promise<{
 *   byDetector: Object<string, object[]>,
 *   detectors: Array<{id,title,scope,version,shadow,surfaced,count,error:(Error|null)}>,
 *   errors: Array<{detectorId:string, error:Error}>,
 * }>} `byDetector` is one Finding[] per detector (id → list); `detectors` is the
 *   ordered per-detector run record (with `surfaced:false` for shadow detectors);
 *   `errors` lists detectors that threw (empty when all ran cleanly).
 */
async function run(data = {}, ctx = {}) {
  const detectors = getEnabled();

  // Resolve the runtime override layer once: honour a caller-supplied `runtime`
  // (tests inject a fixture; a future request handler may reuse a cached load),
  // else read the committed config.json. configFor merges it per detector.
  const runtime = ctx.runtime !== undefined ? ctx.runtime : loadConfig();

  // Reference lists travel on ctx.reference; prefer the dataset's own, fall back
  // to anything the caller put on the base ctx.
  const reference = (data && data.reference !== undefined) ? data.reference : ctx.reference;

  const outcomes = await Promise.all(
    detectors.map((detector) => {
      const detectorCtx = { ...ctx, reference, config: configFor(detector, runtime) };
      return runOne(detector, data, detectorCtx);
    }),
  );

  const byDetector = {};
  const records = [];
  const errors = [];

  for (let i = 0; i < detectors.length; i += 1) {
    const detector = detectors[i];
    const { findings, error } = outcomes[i];
    const meta = detector.meta;
    const shadow = isShadow(detector);

    byDetector[meta.id] = findings;
    records.push({
      id: meta.id,
      title: meta.title,
      scope: meta.scope,
      version: meta.version,
      shadow,
      surfaced: !shadow, // shadow detectors run but are not surfaced (ADR-008)
      count: findings.length,
      error,
    });
    if (error) errors.push({ detectorId: meta.id, error });
  }

  // Fill each finding's `reason` via the explain layer (ADR-007). One pass over
  // the assembled lists keeps it generic; counts are unchanged (reasons only).
  const explainOptions = ctx.explain || {};
  for (const id of Object.keys(byDetector)) {
    byDetector[id] = await applyReasons(byDetector[id], explainOptions); // eslint-disable-line no-await-in-loop
  }

  return { byDetector, detectors: records, errors };
}

module.exports = { run };
