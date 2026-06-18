'use strict';

/**
 * explain/cache.js — on-disk, per-finding reason cache (ADR-007).
 *
 * The LLM explainer is a *cached* explainer: a reason produced for a finding is
 * written to disk so the demo replays it deterministically with no network and
 * no key. The cache is the primary source on the default (flag-off) path — a
 * pre-populated reason is served straight from here; only a cache miss falls
 * through to the per-detector stub.
 *
 * One JSON file per finding, keyed by the finding's stable identity
 * (`detectorId:subject.type:subject.id`). The cache directory is git-ignored
 * (`.gitignore` → `src/explain/cache/`) because it is regenerated, and is
 * created lazily on first write — never at import time, so requiring this
 * module has no filesystem side effect.
 *
 * Reads NEVER throw: a missing directory, missing file, or malformed JSON all
 * degrade to `null` (→ stub), matching the determinism guardrail (the demo can
 * never fail on the explainer). Writes never throw either — a failed write just
 * means the next run regenerates the reason.
 *
 * Dependency rule (ADR C4): explain → model (this file depends on neither).
 */

const Fs = require('fs');
const Path = require('path');

/** Default cache directory — git-ignored, regenerated. */
const DEFAULT_DIR = Path.join(__dirname, 'cache');

/**
 * Sanitise a finding key into a safe single-segment filename (no path
 * separators, no traversal). Keys are our own (`detectorId:type:id`) but a
 * subject id can be a free-text entity key from submission data, so collapse
 * anything outside `[A-Za-z0-9._-]` to `_`.
 */
function safeName(key) {
  return String(key).replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Absolute path of the cache file for a key under `dir` (default DEFAULT_DIR). */
function pathFor(key, dir) {
  return Path.join(dir || DEFAULT_DIR, `${safeName(key)}.json`);
}

/**
 * Read a cached reason for `key`. Returns the reason string, or `null` on any
 * miss (no dir/file, unreadable, malformed, or no `reason` field).
 *
 * @param {string} key finding identity key.
 * @param {string} [dir] cache directory (defaults to DEFAULT_DIR; tests override).
 * @returns {string|null}
 */
function read(key, dir) {
  try {
    const raw = Fs.readFileSync(pathFor(key, dir), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed.reason === 'string' && parsed.reason.trim())
      ? parsed.reason
      : null;
  } catch (e) {
    return null; // missing/unreadable/malformed → cache miss, never throw
  }
}

/**
 * Write a reason to the cache for `key`. Creates the cache directory on demand.
 * Never throws — a failed write simply means a future run regenerates it.
 *
 * @param {string} key finding identity key.
 * @param {string} reason the reason text to cache.
 * @param {string} [dir] cache directory (defaults to DEFAULT_DIR).
 * @returns {boolean} true if written, false if the write failed.
 */
function write(key, reason, dir) {
  try {
    const target = dir || DEFAULT_DIR;
    Fs.mkdirSync(target, { recursive: true });
    Fs.writeFileSync(pathFor(key, target), `${JSON.stringify({ reason }, null, 2)}\n`);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { read, write, pathFor, DEFAULT_DIR };
