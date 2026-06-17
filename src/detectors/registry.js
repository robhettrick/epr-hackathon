'use strict';

/**
 * detectors/registry.js — the central detector registry + base contract (ADR-004).
 *
 * Extensibility is the product (PRD §6): "add a scenario" must be one file +
 * `register()`, never a rewrite. This registry is the single seam that makes the
 * orchestrator, triage, and web layers fully generic — they fan out over whatever
 * `getEnabled()` returns, with NO per-detector `if/else` anywhere (ADR-004).
 *
 * The Detector contract
 * ---------------------
 * A detector is an object (typically a class with static members) that carries:
 *
 *   static meta = {
 *     id,       // string, unique  — e.g. 'ewc-not-packaging'
 *     title,    // human-readable label for the UI
 *     scope,    // what a finding is about: one of SUBJECT_TYPE (load|supplier|…)
 *     version,  // detector version, for run-stamping/reproducibility (ADR-008)
 *     enabled,  // default true; `enabled:false` ⇒ never runs
 *     shadow,   // default false; `shadow:true` ⇒ runs + logs but does NOT surface
 *     config,   // detector-local default thresholds (merged with runtime config, ADR-006)
 *   }
 *   static async evaluate(data, ctx) → Finding[]
 *
 * Detectors are PURE and DETERMINISTIC (ADR-004): no I/O, no shared mutable state,
 * no LLM calls. Thresholds arrive via `ctx`, never hard-coded (ADR-006). Each
 * detector owns its own ranked, detector-local score (ADR-005).
 *
 * enabled vs shadow
 * -----------------
 * `getEnabled()` returns every detector that should RUN — that includes shadow
 * detectors, because a shadow detector runs and logs; it simply must not surface
 * in the UI/counts. The surfacing decision belongs downstream (orchestrator marks
 * shadow results not-surfaced; triage/web filter them), so the registry exposes
 * `isShadow(Detector)` rather than hiding shadow detectors here (ADR-008).
 *
 * Dependency rule (ADR C4): `detectors → model`. The registry depends on nothing.
 */

/** Detectors keyed by `meta.id`, in registration (import) order — Map preserves it. */
const detectors = new Map();

/**
 * Whether a detector should run. Default-on: only an explicit `enabled:false`
 * keeps a detector out of the run (ADR-008).
 * @param {object} Detector a registered detector.
 * @returns {boolean}
 */
function isEnabled(Detector) {
  return Detector.meta.enabled !== false;
}

/**
 * Whether a detector is in shadow mode — it runs and logs but must not surface in
 * the UI/counts (ADR-008). Default-off.
 * @param {object} Detector a registered detector.
 * @returns {boolean}
 */
function isShadow(Detector) {
  return Detector.meta.shadow === true;
}

/**
 * Register a detector. Called by each detector module at import time, so importing
 * a detector file is all it takes to make it discoverable (ADR-004).
 *
 * Validates the minimum contract up front (loud failure: a malformed detector is a
 * programmer error, not dirty data — cf. `makeFinding`). Re-registering the SAME
 * class is a no-op (guards against double-import); registering a DIFFERENT class
 * under an already-used id throws, to catch copy-paste id collisions early.
 *
 * @param {object} Detector a detector with `meta` + `evaluate`.
 * @returns {object} the same Detector, so callers may `module.exports = register(Foo)`.
 * @throws {TypeError} if `meta`/`meta.id`/`evaluate` are missing or malformed.
 * @throws {Error} if a different detector is already registered under the same id.
 */
function register(Detector) {
  if (Detector === null || typeof Detector !== 'object') {
    if (typeof Detector !== 'function') {
      throw new TypeError('register: detector must be an object or class with static `meta`');
    }
  }

  const meta = Detector.meta;
  if (meta === null || typeof meta !== 'object') {
    throw new TypeError('register: detector is missing `static meta {id, …}`');
  }
  if (typeof meta.id !== 'string' || meta.id.trim() === '') {
    throw new TypeError('register: detector `meta.id` is required (non-empty string)');
  }
  if (typeof Detector.evaluate !== 'function') {
    throw new TypeError(`register: detector "${meta.id}" must implement evaluate(data, ctx)`);
  }

  const existing = detectors.get(meta.id);
  if (existing !== undefined) {
    if (existing === Detector) return Detector; // idempotent: same module imported twice
    throw new Error(`register: a different detector is already registered under id "${meta.id}"`);
  }

  detectors.set(meta.id, Detector);
  return Detector;
}

/**
 * Every detector that should run: all registered detectors except those explicitly
 * `enabled:false`. INCLUDES shadow detectors (they run; they just don't surface —
 * use `isShadow` to filter surfacing downstream). Returned in registration order.
 * @returns {object[]} enabled detectors.
 */
function getEnabled() {
  return [...detectors.values()].filter(isEnabled);
}

/**
 * Every registered detector regardless of enabled/shadow state, in registration
 * order. For diagnostics/admin views; the orchestrator uses `getEnabled()`.
 * @returns {object[]}
 */
function getAll() {
  return [...detectors.values()];
}

/**
 * Look up a single registered detector by its `meta.id`.
 * @param {string} id the detector id.
 * @returns {object|undefined} the detector, or undefined if not registered.
 */
function get(id) {
  return detectors.get(id);
}

/**
 * Clear the registry. Primarily for test isolation — the registry is module-level
 * singleton state shared across the process, so a test that registers dummy
 * detectors should `clear()` first to avoid bleed from real detectors imported
 * elsewhere (and vice versa).
 * @returns {void}
 */
function clear() {
  detectors.clear();
}

module.exports = { register, getEnabled, getAll, get, isEnabled, isShadow, clear };
