'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  register,
  getEnabled,
  getAll,
  get,
  isEnabled,
  isShadow,
  clear,
} = require('../../src/detectors/registry');

/**
 * Build a minimal valid dummy detector. The registry only cares about `meta` +
 * `evaluate`; tests override one field at a time. Detectors are static-member
 * objects (pure, no instance state) — the orchestrator calls `Detector.evaluate`.
 */
function makeDetector(metaOverrides = {}, evaluate = async () => []) {
  return {
    meta: {
      id: 'dummy',
      title: 'Dummy detector',
      scope: 'load',
      version: '1',
      ...metaOverrides,
    },
    evaluate,
  };
}

// The registry is process-wide singleton state; isolate every test from bleed.
beforeEach(() => clear());

test('register adds a detector and getEnabled returns it', () => {
  const d = makeDetector();
  const returned = register(d);

  assert.equal(returned, d, 'register returns the detector for chaining');
  assert.deepEqual(getEnabled(), [d]);
  assert.equal(get('dummy'), d);
  assert.deepEqual(getAll(), [d]);
});

test('getEnabled preserves registration order', () => {
  const a = makeDetector({ id: 'a' });
  const b = makeDetector({ id: 'b' });
  const c = makeDetector({ id: 'c' });
  register(a);
  register(b);
  register(c);

  assert.deepEqual(
    getEnabled().map((d) => d.meta.id),
    ['a', 'b', 'c'],
  );
});

test('disabled detectors do not run but remain registered', () => {
  const live = makeDetector({ id: 'live' });
  const off = makeDetector({ id: 'off', enabled: false });
  register(live);
  register(off);

  assert.deepEqual(
    getEnabled().map((d) => d.meta.id),
    ['live'],
    'getEnabled excludes enabled:false',
  );
  assert.equal(isEnabled(off), false);
  assert.equal(isEnabled(live), true);
  // still discoverable via getAll/get for admin/diagnostics
  assert.deepEqual(
    getAll().map((d) => d.meta.id),
    ['live', 'off'],
  );
  assert.equal(get('off'), off);
});

test('enabled defaults to true when meta omits the flag', () => {
  const d = makeDetector(); // no `enabled`
  register(d);
  assert.equal(isEnabled(d), true);
  assert.deepEqual(getEnabled(), [d]);
});

test('shadow detectors still run (getEnabled) but are flagged not-to-surface', () => {
  const live = makeDetector({ id: 'live' });
  const shadow = makeDetector({ id: 'shadow', shadow: true });
  register(live);
  register(shadow);

  // shadow runs — it appears in getEnabled (ADR-008: runs + logs)
  assert.deepEqual(
    getEnabled().map((d) => d.meta.id),
    ['live', 'shadow'],
  );
  assert.equal(isShadow(shadow), true);
  assert.equal(isShadow(live), false, 'shadow defaults to false');
});

test('a disabled shadow detector does not even run', () => {
  const d = makeDetector({ id: 's', shadow: true, enabled: false });
  register(d);
  assert.deepEqual(getEnabled(), [], 'enabled:false wins over shadow');
});

test('re-registering the same detector is idempotent', () => {
  const d = makeDetector();
  register(d);
  register(d); // e.g. module imported twice
  assert.deepEqual(getAll(), [d]);
});

test('registering a different detector under an existing id throws', () => {
  register(makeDetector({ id: 'clash' }));
  assert.throws(
    () => register(makeDetector({ id: 'clash' })),
    /already registered under id "clash"/,
  );
});

test('register validates the minimum contract', () => {
  assert.throws(() => register({ evaluate: async () => [] }), {
    name: 'TypeError',
    message: /missing `static meta/,
  });
  assert.throws(() => register({ meta: {}, evaluate: async () => [] }), {
    name: 'TypeError',
    message: /meta\.id` is required/,
  });
  assert.throws(() => register({ meta: { id: '  ' }, evaluate: async () => [] }), {
    name: 'TypeError',
    message: /meta\.id` is required/,
  });
  assert.throws(() => register({ meta: { id: 'no-eval' } }), {
    name: 'TypeError',
    message: /must implement evaluate/,
  });
});

test('get returns undefined for an unregistered id', () => {
  assert.equal(get('nope'), undefined);
});

test('clear empties the registry', () => {
  register(makeDetector());
  assert.equal(getAll().length, 1);
  clear();
  assert.deepEqual(getAll(), []);
  assert.equal(get('dummy'), undefined);
});
