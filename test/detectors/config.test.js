'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { CONFIG_PATH, loadConfig, mergeConfig, configFor } = require('../../src/detectors/config');

/**
 * The core of the done-when (item D): a detector must read its threshold from
 * `ctx.config`, NOT from a literal. We model a detector exactly as the registry
 * expects (static `meta` incl. `config` defaults + `evaluate`) and prove the value
 * it sees is the runtime override, not its baked-in default.
 */
function makeDetector(overrides = {}) {
  return {
    meta: {
      id: 'chain-mass-balance',
      title: 'Chain mass balance',
      scope: 'load',
      version: '1',
      config: { tolerance: 0.5, severityFloor: 'medium' },
      ...overrides,
    },
    // A pure detector reading its threshold from ctx — never a hard-coded literal.
    evaluate(_data, ctx) {
      return ctx.config.tolerance;
    },
  };
}

test('loadConfig reads the committed config.json as an object namespaced by detector id', () => {
  const cfg = loadConfig();
  assert.equal(typeof cfg, 'object');
  assert.ok(cfg !== null && !Array.isArray(cfg));
  // config.json ships the one plan-pinned threshold (chain-mass-balance tolerance).
  assert.equal(cfg['chain-mass-balance'].tolerance, 0.01);
});

test('configFor lets a detector read a runtime threshold from ctx.config (not a literal)', () => {
  const detector = makeDetector();
  const runtime = loadConfig(); // real config.json overrides tolerance → 0.01

  const ctx = { config: configFor(detector, runtime) };
  // The detector's baked default is 0.5; the runtime override must win.
  assert.equal(detector.evaluate(null, ctx), 0.01);
  // Untouched default keys survive the merge.
  assert.equal(ctx.config.severityFloor, 'medium');
});

test('configFor falls back to meta.config defaults when no override is namespaced for the id', () => {
  const detector = makeDetector({ id: 'no-overrides-here' });
  const ctx = { config: configFor(detector, loadConfig()) };
  assert.equal(ctx.config.tolerance, 0.5);
  assert.equal(ctx.config.severityFloor, 'medium');
});

test('configFor returns {} for a detector with no meta.config and no override', () => {
  const detector = { meta: { id: 'bare', title: 'Bare', scope: 'load', version: '1' } };
  assert.deepEqual(configFor(detector, {}), {});
});

test('configFor deep-freezes the effective config so a pure detector cannot mutate it', () => {
  const ctx = { config: configFor(makeDetector(), {}) };
  assert.ok(Object.isFrozen(ctx.config));
  assert.throws(() => {
    ctx.config.tolerance = 999;
  }, TypeError);
});

test('mergeConfig deep-merges plain objects without mutating either input', () => {
  const base = { byMaterial: { aluminium: 0.05, fibre: 0.1 }, mode: 'strict' };
  const override = { byMaterial: { fibre: 0.2 }, extra: true };
  const merged = mergeConfig(base, override);

  assert.deepEqual(merged, {
    byMaterial: { aluminium: 0.05, fibre: 0.2 }, // nested key preserved + overridden
    mode: 'strict',
    extra: true,
  });
  // Inputs untouched (meta.config is shared/frozen across runs).
  assert.deepEqual(base.byMaterial, { aluminium: 0.05, fibre: 0.1 });
  assert.equal(override.extra, true);
});

test('mergeConfig replaces arrays and scalars wholesale (does not splice arrays)', () => {
  const merged = mergeConfig(
    { destinations: ['DE', 'NL'], tolerance: 0.5 },
    { destinations: ['CN'], tolerance: 0.1 },
  );
  assert.deepEqual(merged.destinations, ['CN']);
  assert.equal(merged.tolerance, 0.1);
});

test('loadConfig returns {} for a missing file (no overrides is valid)', () => {
  const missing = path.join(__dirname, 'does-not-exist-config.json');
  assert.deepEqual(loadConfig(missing), {});
});

test('loadConfig throws on a present-but-malformed config file (build error, not silent)', () => {
  // README.md exists but is not JSON — proves bad committed config fails loudly.
  const notJson = path.join(__dirname, '..', '..', 'src', 'detectors', 'README.md');
  assert.throws(() => loadConfig(notJson), /not valid JSON/);
});

test('CONFIG_PATH points at the committed src/detectors/config.json', () => {
  assert.ok(CONFIG_PATH.endsWith(path.join('src', 'detectors', 'config.json')));
});
