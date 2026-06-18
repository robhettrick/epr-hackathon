'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeFinding,
  stampRunMeta,
  SEVERITY,
  SEVERITIES,
  SUBJECT_TYPE,
  SUBJECT_TYPES,
} = require('../../src/model/finding');

/** A minimal valid spec; tests override one field at a time. */
function validSpec(overrides = {}) {
  return {
    detectorId: 'ewc-not-packaging',
    version: '1',
    subject: { type: SUBJECT_TYPE.LOAD, id: 42, label: 'Load #42' },
    score: 80,
    severity: SEVERITY.HIGH,
    reason: 'EWC code is not a packaging code',
    evidence: { ewcCode: '20 03 01', material: 'Aluminium' },
    thresholdsUsed: { offListScore: 70 },
    ...overrides,
  };
}

test('makeFinding builds a valid Finding with the full PRD §5.2 contract', () => {
  const f = makeFinding(validSpec());

  assert.equal(f.detectorId, 'ewc-not-packaging');
  assert.equal(f.version, '1');
  assert.deepEqual(f.subject, { type: 'load', id: 42, label: 'Load #42' });
  assert.equal(f.score, 80);
  assert.equal(f.severity, 'high');
  assert.equal(f.reason, 'EWC code is not a packaging code');
  assert.deepEqual(f.evidence, { ewcCode: '20 03 01', material: 'Aluminium' });
  assert.deepEqual(f.thresholdsUsed, { offListScore: 70 });
  // every contract field is present even when not supplied
  assert.deepEqual(f.runMeta, {});
});

test('makeFinding rejects an out-of-range score (done-when)', () => {
  // detectors normalise to 0–100; anything outside is a detector bug, fail loud
  assert.throws(() => makeFinding(validSpec({ score: 101 })), RangeError);
  assert.throws(() => makeFinding(validSpec({ score: -1 })), RangeError);
  assert.throws(() => makeFinding(validSpec({ score: NaN })), RangeError);
  assert.throws(() => makeFinding(validSpec({ score: '80' })), RangeError);
  // the 0 and 100 boundaries are valid
  assert.equal(makeFinding(validSpec({ score: 0 })).score, 0);
  assert.equal(makeFinding(validSpec({ score: 100 })).score, 100);
});

test('makeFinding rejects a severity not in the enum (done-when)', () => {
  assert.throws(() => makeFinding(validSpec({ severity: 'urgent' })), RangeError);
  assert.throws(() => makeFinding(validSpec({ severity: undefined })), RangeError);
  // every enum member is accepted
  for (const sev of SEVERITIES) {
    assert.equal(makeFinding(validSpec({ severity: sev })).severity, sev);
  }
});

test('makeFinding validates the subject (type in enum, id present)', () => {
  assert.throws(() => makeFinding(validSpec({ subject: undefined })), TypeError);
  assert.throws(
    () => makeFinding(validSpec({ subject: { type: 'planet', id: 1 } })),
    RangeError,
  );
  assert.throws(
    () => makeFinding(validSpec({ subject: { type: SUBJECT_TYPE.SUPPLIER } })),
    TypeError,
  );
  // every subject type the PRD lists is accepted
  for (const type of SUBJECT_TYPES) {
    const f = makeFinding(validSpec({ subject: { type, id: 'x' } }));
    assert.equal(f.subject.type, type);
    assert.equal(f.subject.label, null); // label defaults to null when omitted
  }
});

test('makeFinding requires a non-empty detectorId', () => {
  assert.throws(() => makeFinding(validSpec({ detectorId: undefined })), TypeError);
  assert.throws(() => makeFinding(validSpec({ detectorId: '' })), TypeError);
  assert.throws(() => makeFinding(validSpec({ detectorId: '  ' })), TypeError);
});

test('makeFinding defaults optional fields and coerces version to a string', () => {
  const f = makeFinding({
    detectorId: 'chain-mass-balance',
    subject: { type: SUBJECT_TYPE.LOAD, id: 7 },
    score: 50,
    severity: SEVERITY.MEDIUM,
  });
  assert.equal(f.version, '0'); // default
  assert.equal(f.reason, null);
  assert.deepEqual(f.evidence, {});
  assert.deepEqual(f.thresholdsUsed, {});
  assert.deepEqual(f.runMeta, {});

  // numeric version is coerced for stable comparison/echo
  const g = makeFinding(validSpec({ version: 2 }));
  assert.equal(g.version, '2');
});

test('the returned Finding and its subject are frozen (detectors are pure)', () => {
  const f = makeFinding(validSpec());
  assert.equal(Object.isFrozen(f), true);
  assert.equal(Object.isFrozen(f.subject), true);
});

test('stampRunMeta returns a new frozen Finding carrying the run stamp (ADR-008)', () => {
  const f = makeFinding(validSpec()); // runMeta defaults to {}
  const runMeta = {
    detectorId: 'ewc-not-packaging',
    detectorVersion: '1',
    configHash: 'abc123def456',
    snapshotId: 'deadbeef0000',
    timestamp: '2026-06-18T00:00:00.000Z',
  };
  const stamped = stampRunMeta(f, runMeta);

  // a NEW object (Findings are immutable) — the original is untouched
  assert.notEqual(stamped, f);
  assert.deepEqual(f.runMeta, {}, 'the source finding is not mutated');
  assert.deepEqual(stamped.runMeta, runMeta);
  assert.equal(Object.isFrozen(stamped), true);

  // every other contract field is preserved verbatim
  assert.equal(stamped.detectorId, f.detectorId);
  assert.equal(stamped.version, f.version);
  assert.deepEqual(stamped.subject, f.subject);
  assert.equal(stamped.score, f.score);
  assert.equal(stamped.severity, f.severity);
  assert.equal(stamped.reason, f.reason);
  assert.deepEqual(stamped.evidence, f.evidence);
  assert.deepEqual(stamped.thresholdsUsed, f.thresholdsUsed);
});

test('stampRunMeta merges over any detector-set runMeta, the stamp winning', () => {
  const f = makeFinding(validSpec({ runMeta: { detectorNote: 'kept', snapshotId: 'old' } }));
  const stamped = stampRunMeta(f, { snapshotId: 'new', timestamp: 't' });

  assert.equal(stamped.runMeta.detectorNote, 'kept', 'detector-set field survives');
  assert.equal(stamped.runMeta.snapshotId, 'new', 'engine stamp wins on conflict');
  assert.equal(stamped.runMeta.timestamp, 't');
});
