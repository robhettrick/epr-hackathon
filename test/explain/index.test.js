'use strict';

/**
 * explain/index.test.js — the reason-resolution layer (ADR-007, item G).
 *
 * Proves the done-when: findings get a per-detector reason from the stub with no
 * network, and the stub fallback fires when the explainer flag is off. Also
 * covers the full precedence (cache → LLM → detector reason → stub), the
 * frozen-finding rebuild, and that a missing SDK on the flag-on path degrades to
 * the stub rather than throwing (the determinism guardrail).
 */

const Fs = require('fs');
const Os = require('os');
const Path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyReasons, reasonFor, findingKey, stubFor, withReason } = require('../../src/explain');
const cache = require('../../src/explain/cache');
const STUBS = require('../../src/explain/stubs.json');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/** Build a finding for a detector, with an optional reason (defaults to none). */
function finding(detectorId, { reason = null, id = 0 } = {}) {
  return makeFinding({
    detectorId,
    version: '1.0.0',
    subject: { type: SUBJECT_TYPE.LOAD, id, label: `Load #${id}` },
    score: 50,
    severity: SEVERITY.MEDIUM,
    reason,
    evidence: { sample: true },
  });
}

/** A throwaway cache dir so tests never read/write the real explain/cache/. */
function tmpCacheDir() {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), 'explain-cache-'));
}

test('done-when: stub fallback fires when the flag is off and there is no cache', async () => {
  const dir = tmpCacheDir();
  const f = finding('ewc-not-packaging'); // no detector reason supplied
  const reason = await reasonFor(f, { llm: false, cacheDir: dir });

  assert.equal(reason, STUBS['ewc-not-packaging'], 'the per-detector stub is used with no network');
  assert.ok(reason.length > 0, 'reason is non-empty');
});

test('an unknown detector falls back to the shared default stub', async () => {
  const dir = tmpCacheDir();
  const reason = await reasonFor(finding('no-such-detector'), { llm: false, cacheDir: dir });
  assert.equal(reason, STUBS.default);
});

test('stubFor exposes per-detector vs default selection', () => {
  assert.equal(stubFor('chain-mass-balance'), STUBS['chain-mass-balance']);
  assert.equal(stubFor('mystery'), STUBS.default);
  assert.equal(stubFor(undefined), STUBS.default);
});

test('the detector\'s own reason is preferred over the generic stub', async () => {
  const dir = tmpCacheDir();
  const f = finding('ewc-not-packaging', { reason: 'EWC 20 03 01 is municipal waste, not packaging.' });
  const reason = await reasonFor(f, { llm: false, cacheDir: dir });
  assert.equal(reason, 'EWC 20 03 01 is municipal waste, not packaging.');
});

test('the on-disk cache is the primary source, even with the flag off', async () => {
  const dir = tmpCacheDir();
  const f = finding('chain-mass-balance', { reason: 'detector text' });
  cache.write(findingKey(f), 'CACHED model prose', dir);

  const reason = await reasonFor(f, { llm: false, cacheDir: dir });
  assert.equal(reason, 'CACHED model prose', 'cache wins over detector reason and stub');
});

test('flag on but no SDK degrades to the stub (determinism guardrail)', async () => {
  const dir = tmpCacheDir();
  // EXPLAIN_LLM unset; force the flag on via options. The SDK is not installed,
  // so llm.explain throws and reasonFor must fall through, not reject.
  const reason = await reasonFor(finding('material-profile'), { llm: true, cacheDir: dir });
  assert.equal(reason, STUBS['material-profile']);
});

test('flag on with an injected client uses the model output and caches it', async () => {
  const dir = tmpCacheDir();
  const f = finding('destination-plausibility', { id: 7 });

  // A fake SDK client implementing just messages.create (structured output shape).
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return { content: [{ type: 'text', text: JSON.stringify({ reason: 'LLM says: implausible.' }) }] };
      },
    },
  };

  const reason = await reasonFor(f, { llm: true, cacheDir: dir, client });
  assert.equal(reason, 'LLM says: implausible.');
  assert.equal(calls, 1, 'the model was called once');

  // Cached on success — a second call (even with the client removed) reads the cache.
  assert.equal(cache.read(findingKey(f), dir), 'LLM says: implausible.');
  const second = await reasonFor(f, { llm: true, cacheDir: dir });
  assert.equal(second, 'LLM says: implausible.', 'second resolution served from cache, no model call');
});

test('applyReasons returns new frozen findings carrying the resolved reason', async () => {
  const dir = tmpCacheDir();
  const findings = [finding('ewc-not-packaging'), finding('chain-mass-balance', { id: 1 })];
  const explained = await applyReasons(findings, { llm: false, cacheDir: dir });

  assert.equal(explained.length, 2, 'one explained finding per input, order preserved');
  assert.equal(explained[0].reason, STUBS['ewc-not-packaging']);
  assert.equal(explained[1].reason, STUBS['chain-mass-balance']);
  // Every other field is preserved and the result is still a frozen Finding.
  assert.equal(explained[0].detectorId, 'ewc-not-packaging');
  assert.equal(explained[0].score, 50);
  assert.equal(explained[0].subject.id, 0);
  assert.throws(() => { explained[0].reason = 'mutate'; }, 'explained finding is frozen');
});

test('withReason keeps the original object when the reason is unchanged', () => {
  const f = finding('ewc-not-packaging', { reason: 'same' });
  assert.equal(withReason(f, 'same'), f, 'no rebuild when nothing changed');
  assert.notEqual(withReason(f, 'different'), f, 'a changed reason yields a new object');
});

test('applyReasons tolerates a non-array input', async () => {
  assert.deepEqual(await applyReasons(undefined, { llm: false }), []);
});

test('findingKey is the stable detector:type:id identity', () => {
  const f = finding('ewc-not-packaging', { id: 42 });
  assert.equal(findingKey(f), 'ewc-not-packaging:load:42');
});
