'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { register, clear } = require('../../src/detectors/registry');
const { run } = require('../../src/engine/orchestrator');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * A trivial detector that emits one Finding per load whose `flag` field is truthy.
 * Mirrors a real detector's shape (static `meta` + `evaluate`) so the orchestrator
 * exercises the same generic path it uses in production — no test-only contract.
 */
function makeFlagDetector(id, metaOverrides = {}) {
  const detector = {
    meta: { id, title: `Flag ${id}`, scope: SUBJECT_TYPE.LOAD, version: '1.0.0', ...metaOverrides },
    evaluate(data) {
      const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
      const findings = [];
      loads.forEach((load, i) => {
        if (load && load.flag) {
          findings.push(
            makeFinding({
              detectorId: id,
              version: '1.0.0',
              subject: { type: SUBJECT_TYPE.LOAD, id: i, label: `Load #${i}` },
              score: 50,
              severity: SEVERITY.MEDIUM,
              reason: 'flagged',
              evidence: { flag: load.flag },
            }),
          );
        }
      });
      return findings;
    },
  };
  return detector;
}

// The registry is process-wide singleton state; isolate every test from bleed
// (real detectors self-register on import elsewhere).
beforeEach(() => clear());

test('runs every enabled detector and returns one list per detector', async () => {
  // The done-when: two trivial detectors over a small dataset → one list each.
  register(makeFlagDetector('alpha'));
  register(makeFlagDetector('beta'));

  const data = { loads: [{ flag: 'x' }, {}, { flag: 'y' }], reference: {} };
  const { byDetector } = await run(data, { runtime: {} });

  assert.deepEqual(Object.keys(byDetector), ['alpha', 'beta'], 'one list per detector, in registration order');
  assert.equal(byDetector.alpha.length, 2, 'two flagged loads → two findings');
  assert.equal(byDetector.beta.length, 2);
  assert.equal(byDetector.alpha[0].detectorId, 'alpha');
});

test('detectors record carries id/title/scope/version/count in registration order', async () => {
  register(makeFlagDetector('alpha'));
  register(makeFlagDetector('beta'));

  const data = { loads: [{ flag: 'x' }], reference: {} };
  const { detectors } = await run(data, { runtime: {} });

  assert.deepEqual(detectors.map((d) => d.id), ['alpha', 'beta']);
  assert.equal(detectors[0].title, 'Flag alpha');
  assert.equal(detectors[0].scope, SUBJECT_TYPE.LOAD);
  assert.equal(detectors[0].version, '1.0.0');
  assert.equal(detectors[0].count, 1);
  assert.equal(detectors[0].error, null);
});

test('one detector throwing does not abort the run (ADR-004)', async () => {
  const boom = {
    meta: { id: 'boom', title: 'Boom', scope: SUBJECT_TYPE.LOAD, version: '1.0.0' },
    evaluate() {
      throw new Error('kaboom');
    },
  };
  register(boom);
  register(makeFlagDetector('survivor'));

  const data = { loads: [{ flag: 'x' }], reference: {} };
  const { byDetector, detectors, errors } = await run(data, { runtime: {} });

  // The thrower yields an empty list and is recorded; the other detector still ran.
  assert.deepEqual(byDetector.boom, []);
  assert.equal(byDetector.survivor.length, 1, 'a sibling detector still produced its findings');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].detectorId, 'boom');
  assert.match(errors[0].error.message, /kaboom/);
  assert.equal(detectors.find((d) => d.id === 'boom').error.message, 'kaboom');
});

test('async detectors are awaited and merged like sync ones', async () => {
  const asyncDetector = {
    meta: { id: 'async', title: 'Async', scope: SUBJECT_TYPE.LOAD, version: '1.0.0' },
    async evaluate() {
      await Promise.resolve();
      return [
        makeFinding({
          detectorId: 'async',
          version: '1.0.0',
          subject: { type: SUBJECT_TYPE.LOAD, id: 0, label: 'L0' },
          score: 10,
          severity: SEVERITY.LOW,
          reason: 'async',
          evidence: {},
        }),
      ];
    },
  };
  register(asyncDetector);

  const { byDetector } = await run({ loads: [] }, { runtime: {} });
  assert.equal(byDetector.async.length, 1);
});

test('shadow detectors run but are marked not-surfaced (ADR-008)', async () => {
  register(makeFlagDetector('live'));
  register(makeFlagDetector('shadowy', { shadow: true }));

  const data = { loads: [{ flag: 'x' }], reference: {} };
  const { byDetector, detectors } = await run(data, { runtime: {} });

  // Shadow detector RAN (it has findings) but its run record says not surfaced.
  assert.equal(byDetector.shadowy.length, 1, 'shadow detector still runs');
  assert.equal(detectors.find((d) => d.id === 'shadowy').shadow, true);
  assert.equal(detectors.find((d) => d.id === 'shadowy').surfaced, false);
  assert.equal(detectors.find((d) => d.id === 'live').surfaced, true);
});

test('disabled detectors do not run (registry filters them out)', async () => {
  register(makeFlagDetector('on'));
  register(makeFlagDetector('off', { enabled: false }));

  const { byDetector } = await run({ loads: [{ flag: 'x' }] }, { runtime: {} });
  assert.deepEqual(Object.keys(byDetector), ['on'], 'enabled:false detector is absent from the run');
});

test('builds ctx.config per detector from meta.config + runtime override (ADR-006)', async () => {
  let seenConfig;
  const configReader = {
    meta: {
      id: 'cfg',
      title: 'Cfg',
      scope: SUBJECT_TYPE.LOAD,
      version: '1.0.0',
      config: { threshold: 5, nested: { a: 1, b: 2 } },
    },
    evaluate(data, ctx) {
      seenConfig = ctx.config;
      return [];
    },
  };
  register(configReader);

  // Runtime override wins on `threshold` and deep-merges `nested.b` without wiping a.
  await run({ loads: [] }, { runtime: { cfg: { threshold: 99, nested: { b: 20 } } } });

  assert.equal(seenConfig.threshold, 99, 'runtime override wins over meta.config default');
  assert.deepEqual(seenConfig.nested, { a: 1, b: 20 }, 'deep-merged, not replaced');
  assert.throws(() => { seenConfig.threshold = 1; }, 'ctx.config is frozen for pure detectors');
});

test('passes the dataset reference lists through on ctx.reference', async () => {
  let seenReference;
  const refReader = {
    meta: { id: 'ref', title: 'Ref', scope: SUBJECT_TYPE.LOAD, version: '1.0.0' },
    evaluate(data, ctx) {
      seenReference = ctx.reference;
      return [];
    },
  };
  register(refReader);

  const reference = { ewcCodes: ['15 01 04'], materials: ['Aluminium'] };
  await run({ loads: [], reference }, { runtime: {} });

  assert.deepEqual(seenReference, reference, 'data.reference reaches the detector via ctx.reference');
});

test('empty registry yields empty results, never throws', async () => {
  const { byDetector, detectors, errors } = await run({ loads: [] }, { runtime: {} });
  assert.deepEqual(byDetector, {});
  assert.deepEqual(detectors, []);
  assert.deepEqual(errors, []);
});
