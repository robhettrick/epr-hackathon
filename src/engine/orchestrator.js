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
 * Any additional keys the caller puts on the base `ctx` are forwarded to every
 * detector untouched.
 *
 * Run-stamping (ADR-008)
 * ----------------------
 * After fan-out the orchestrator stamps every finding's `runMeta` with the
 * reproducibility metadata — detector id+version, a hash of the exact config the
 * detector ran under, the dataset snapshot id, and the run timestamp — so any
 * flagged case is auditable and replayable against its inputs and logic. The
 * snapshot id and timestamp are taken from `ctx` when supplied (deterministic
 * tests, shared run id) and otherwise derived (a hash of the loads / the current
 * time). The stamp is applied generically to every detector's findings, with no
 * per-detector branching.
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

const crypto = require('crypto');

const { getEnabled, isShadow } = require('../detectors/registry');
const { loadConfig, configFor } = require('../detectors/config');
const { applyReasons } = require('../explain');
const { stampRunMeta } = require('../model/finding');

/**
 * Deterministic JSON for hashing (ADR-008). `JSON.stringify` key order is
 * insertion order, so the same logical config produced via different merge paths
 * could stringify differently — sort object keys so the hash depends only on the
 * VALUES, not how they were assembled. Dates serialise to their ISO string (a
 * plain `JSON.stringify` over a Date object would otherwise lose the instant).
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** A short, stable content hash for run-stamping (config hash, snapshot id). */
function shortHash(value) {
  return crypto.createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12);
}

/**
 * The dataset snapshot id (ADR-008): a content hash over the ingested `Load[]` so
 * two runs over the same data share an id and any change to the data changes it —
 * which is what makes a flagged case replayable against the exact inputs. Hashing
 * the loads (the canonical records detectors read) is sufficient; entities are
 * derived from them. A caller may inject a precomputed id via `ctx.snapshotId`.
 */
function snapshotOf(data) {
  const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
  return shortHash({ count: loads.length, loads });
}

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
 *   `reference` (fallback when `data.reference` is absent), `snapshotId` /
 *   `timestamp` (injected run-stamp fields, ADR-008; default to a hash of the
 *   loads and the current time). Any other keys are forwarded to each detector's
 *   `ctx` unchanged.
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

  // Run stamp shared by every finding (ADR-008). The snapshot id and timestamp are
  // injectable so a run is reproducible and tests are deterministic: the engine is
  // not a pure detector, but the *timestamp* is taken from ctx (not read off the
  // clock inside a detector) so the stamp stays under the caller's control.
  const snapshotId = ctx.snapshotId !== undefined ? ctx.snapshotId : snapshotOf(data);
  const timestamp = ctx.timestamp !== undefined ? ctx.timestamp : new Date().toISOString();

  // Resolve each detector's effective config ONCE: it both reaches the detector on
  // ctx.config and is hashed into its run stamp, so the configHash provably matches
  // the thresholds the detector actually ran under.
  const configs = detectors.map((detector) => configFor(detector, runtime));

  const outcomes = await Promise.all(
    detectors.map((detector, i) => {
      const detectorCtx = { ...ctx, reference, config: configs[i] };
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

    // Stamp every finding with its reproducibility metadata (ADR-008): detector
    // id+version, the hash of the config it ran under, the dataset snapshot id, and
    // the run timestamp. Generic over all detectors — no per-detector branching.
    const runMeta = {
      detectorId: meta.id,
      detectorVersion: String(meta.version),
      configHash: shortHash(configs[i]),
      snapshotId,
      timestamp,
    };
    byDetector[meta.id] = findings.map((finding) => stampRunMeta(finding, runMeta));
    records.push({
      id: meta.id,
      title: meta.title,
      description: meta.description || null,
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
