'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { register, clear } = require('../../src/detectors/registry');
const { run } = require('../../src/engine/orchestrator');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * Run-stamping (ADR-008): every Finding must carry a `runMeta` recording the
 * detector id+version, a hash of the config it ran under, the dataset snapshot id
 * and the run timestamp — so a flagged case is auditable and replayable against
 * its exact inputs and logic. These tests drive the real orchestrator path so the
 * stamp is exercised exactly as production assembles it.
 */

/** A detector that emits one Finding per load, mirroring a real detector's shape. */
function makeEmitter(id, metaOverrides = {}) {
  return {
    meta: { id, title: `Emit ${id}`, scope: SUBJECT_TYPE.LOAD, version: '1.2.3', ...metaOverrides },
    evaluate(data) {
      const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
      return loads.map((load, i) =>
        makeFinding({
          detectorId: id,
          version: this.meta.version,
          subject: { type: SUBJECT_TYPE.LOAD, id: i, label: `Load #${i}` },
          score: 50,
          severity: SEVERITY.MEDIUM,
          reason: 'emitted',
          evidence: {},
        }),
      );
    },
  };
}

beforeEach(() => clear());

test('every finding carries detector version + config hash + snapshot id (done-when)', async () => {
  register(makeEmitter('alpha'));
  const data = { loads: [{ x: 1 }, { x: 2 }], reference: {} };

  const { byDetector } = await run(data, {
    runtime: {},
    snapshotId: 'snap-fixed',
    timestamp: '2026-06-18T12:00:00.000Z',
  });

  assert.equal(byDetector.alpha.length, 2);
  for (const finding of byDetector.alpha) {
    const rm = finding.runMeta;
    assert.equal(rm.detectorId, 'alpha');
    assert.equal(rm.detectorVersion, '1.2.3', 'detector version is stamped');
    assert.equal(typeof rm.configHash, 'string');
    assert.ok(rm.configHash.length > 0, 'config hash is present');
    assert.equal(rm.snapshotId, 'snap-fixed', 'dataset snapshot id is stamped');
    assert.equal(rm.timestamp, '2026-06-18T12:00:00.000Z', 'run timestamp is stamped');
  }
});

test('the injected snapshot id and timestamp are shared by every detector', async () => {
  register(makeEmitter('alpha'));
  register(makeEmitter('beta'));
  const data = { loads: [{ x: 1 }], reference: {} };

  const { byDetector } = await run(data, {
    runtime: {},
    snapshotId: 'shared-snap',
    timestamp: 'shared-ts',
  });

  const all = [...byDetector.alpha, ...byDetector.beta];
  assert.ok(all.length >= 2);
  for (const f of all) {
    assert.equal(f.runMeta.snapshotId, 'shared-snap');
    assert.equal(f.runMeta.timestamp, 'shared-ts');
  }
});

test('snapshot id defaults to a deterministic hash of the loads (changes with the data)', async () => {
  register(makeEmitter('alpha'));

  const dataA = { loads: [{ x: 1 }, { x: 2 }], reference: {} };
  const first = await run(dataA, { runtime: {}, timestamp: 't' });
  const again = await run(dataA, { runtime: {}, timestamp: 't' });
  const idA1 = first.byDetector.alpha[0].runMeta.snapshotId;
  const idA2 = again.byDetector.alpha[0].runMeta.snapshotId;

  assert.equal(typeof idA1, 'string');
  assert.ok(idA1.length > 0);
  assert.equal(idA1, idA2, 'same loads → same snapshot id (deterministic, replayable)');

  const dataB = { loads: [{ x: 1 }, { x: 3 }], reference: {} };
  const other = await run(dataB, { runtime: {}, timestamp: 't' });
  assert.notEqual(other.byDetector.alpha[0].runMeta.snapshotId, idA1, 'different loads → different id');
});

test('config hash reflects the effective config a detector ran under (ADR-006/008)', async () => {
  register(makeEmitter('cfg', { config: { threshold: 5 } }));
  const data = { loads: [{ x: 1 }], reference: {} };

  const base = await run(data, { runtime: {}, snapshotId: 's', timestamp: 't' });
  const overridden = await run(data, {
    runtime: { cfg: { threshold: 99 } },
    snapshotId: 's',
    timestamp: 't',
  });

  const hashDefault = base.byDetector.cfg[0].runMeta.configHash;
  const hashOverride = overridden.byDetector.cfg[0].runMeta.configHash;

  assert.equal(typeof hashDefault, 'string');
  assert.notEqual(hashDefault, hashOverride, 'a runtime threshold override changes the config hash');
});

test('distinct detectors get distinct config hashes for distinct configs', async () => {
  register(makeEmitter('a', { config: { threshold: 1 } }));
  register(makeEmitter('b', { config: { threshold: 2 } }));
  const data = { loads: [{ x: 1 }], reference: {} };

  const { byDetector } = await run(data, { runtime: {}, snapshotId: 's', timestamp: 't' });
  assert.notEqual(
    byDetector.a[0].runMeta.configHash,
    byDetector.b[0].runMeta.configHash,
    'different config → different hash',
  );
});

test('the run stamp survives the explain (reason) pass', async () => {
  // applyReasons rebuilds findings to set `reason`; runMeta must be preserved.
  register(makeEmitter('alpha'));
  const data = { loads: [{ x: 1 }], reference: {} };

  const { byDetector } = await run(data, { runtime: {}, snapshotId: 'keep', timestamp: 'ts' });
  const finding = byDetector.alpha[0];
  assert.equal(finding.runMeta.snapshotId, 'keep', 'stamp survives reason resolution');
  assert.equal(finding.runMeta.timestamp, 'ts');
  assert.equal(typeof finding.reason, 'string', 'reason was still resolved by the explain layer');
});
