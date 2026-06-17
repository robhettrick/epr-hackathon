'use strict';

/**
 * detectors/config.js — the runtime detector config store (ADR-006).
 *
 * Board requirement: "make % configurable — differs by domain." Thresholds must
 * NEVER be baked into detector code; they reach a detector via `ctx.config` and
 * are adjustable at runtime (this is what drives the demo's live threshold
 * re-rank, golden-path step 6).
 *
 * Two layers, merged per detector
 * -------------------------------
 *   1. `Detector.meta.config` — the detector's own baked-in DEFAULTS. Ships in the
 *      detector file so a detector is usable with no external config present.
 *   2. `detectors/config.json` — the analyst-facing runtime OVERRIDES, namespaced
 *      by `meta.id` at the top level (and nested per material/domain where a
 *      detector keys on material). Tunable without a deploy.
 *
 * `configFor(detector, runtime)` deep-merges (2) over (1) and hands back the frozen
 * effective config the orchestrator places on `ctx.config` for that detector. The
 * override layer intentionally shadows the default layer — a value present in both
 * is by design (config.json wins), not accidental duplication.
 *
 * The merge is DEEP for plain objects (so an override can tweak a single material's
 * tolerance without wiping the rest) and REPLACE-wholesale for scalars and arrays
 * (an array is a complete value — e.g. a destination allow-list — not something to
 * splice into). The result is deep-frozen because detectors are pure and must not
 * mutate the config they are handed.
 *
 * Failure policy mirrors `register`/`makeFinding`: a MISSING config.json is fine
 * (no overrides — defaults stand), but a MALFORMED one is a programmer/build error
 * and throws loudly rather than silently dropping every override.
 *
 * Dependency rule (ADR C4): this is leaf infrastructure under `detectors/`; it
 * depends on nothing in the app.
 */

const fs = require('fs');
const path = require('path');

/** Canonical location of the runtime override file. */
const CONFIG_PATH = path.join(__dirname, 'config.json');

/**
 * True for a real, mergeable record `{}` — not null, not an array, not a Date or
 * other class instance. Only plain objects are merged key-by-key; everything else
 * is a leaf value that an override replaces wholesale.
 * @param {*} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  );
}

/**
 * Deep-merge `override` over `base`, returning a NEW object — neither input is
 * mutated (so a detector's shared/frozen `meta.config` is never clobbered).
 * Plain-object values recurse; scalars and arrays are replaced wholesale.
 * @param {object} base defaults.
 * @param {object} override values that win.
 * @returns {object} a fresh merged object.
 */
function mergeConfig(base = {}, override = {}) {
  const out = {};
  const sources = [base, override];
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of Object.keys(source)) {
      const next = source[key];
      const prev = out[key];
      out[key] = isPlainObject(prev) && isPlainObject(next) ? mergeConfig(prev, next) : next;
    }
  }
  return out;
}

/**
 * Recursively freeze a config object so a pure detector can't mutate the thresholds
 * it reads. Returns the same object, now frozen.
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Load the runtime override config.
 *
 * A missing file yields `{}` (no overrides — every detector falls back to its
 * `meta.config` defaults). A present-but-malformed file throws: it is committed
 * config, so bad JSON is a build error we want surfaced, not swallowed.
 *
 * @param {string} [filePath] override path (tests point this at a fixture).
 * @returns {object} the raw runtime config, namespaced by detector id.
 * @throws {Error} if the file exists but is not valid JSON, or is not an object.
 */
function loadConfig(filePath = CONFIG_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`detectors/config: ${filePath} is not valid JSON: ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`detectors/config: ${filePath} must contain a JSON object keyed by detector id`);
  }
  return parsed;
}

/**
 * The effective, frozen config for one detector: its `meta.config` defaults with
 * the runtime override for its `meta.id` deep-merged on top. This is exactly what
 * the orchestrator puts on `ctx.config` (ADR-006) — detectors read thresholds from
 * here, never from a literal.
 *
 * @param {object} detector a registered detector (`meta.id`, optional `meta.config`).
 * @param {object} [runtime] the runtime config (from `loadConfig`); defaults to {}.
 * @returns {object} frozen effective config for the detector.
 */
function configFor(detector, runtime = {}) {
  const defaults = detector && detector.meta && isPlainObject(detector.meta.config)
    ? detector.meta.config
    : {};
  const id = detector && detector.meta ? detector.meta.id : undefined;
  const overrides = id !== undefined && isPlainObject(runtime[id]) ? runtime[id] : {};
  return deepFreeze(mergeConfig(defaults, overrides));
}

module.exports = { CONFIG_PATH, loadConfig, mergeConfig, configFor };
