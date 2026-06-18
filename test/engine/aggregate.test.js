'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregate,
  fuse,
  METHODS,
  DEFAULT_METHOD,
} = require('../../src/engine/aggregate');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * Build a real (frozen) Finding so the aggregate fixtures exercise the actual contract
 * and prove aggregate never mutates the findings it fuses. `aggregate` reads
 * `detectorId`, `subject.{type,id,label}`, `score` and `severity`.
 */
function finding({ detectorId = 'det-a', type = SUBJECT_TYPE.LOAD, id, label, score, severity = SEVERITY.MEDIUM }) {
  return makeFinding({
    detectorId,
    version: '1.0.0',
    subject: { type, id, label: label || `${type} ${id}` },
    score,
    severity,
    reason: 'test',
  });
}

test('fuses findings that name the same subject into one record (corroboration)', () => {
  const { subjects, count } = aggregate([
    finding({ detectorId: 'ewc-not-packaging', id: 7, score: 50, severity: SEVERITY.HIGH }),
    finding({ detectorId: 'chain-mass-balance', id: 7, score: 50, severity: SEVERITY.CRITICAL }),
  ]);
  assert.equal(count, 1);
  const [s] = subjects;
  assert.equal(s.subject.id, 7);
  assert.equal(s.detectorCount, 2);
  assert.equal(s.findingCount, 2);
  // noisy-or of two 50s = 1 − 0.5·0.5 = 0.75 → 75, above either single signal (corroboration).
  assert.equal(s.score, 75);
  // severity is the MAX contributing severity — corroboration never downgrades.
  assert.equal(s.severity, SEVERITY.CRITICAL);
});

test('different subject types never collide even with equal ids', () => {
  const { subjects, count } = aggregate([
    finding({ type: SUBJECT_TYPE.LOAD, id: 1, score: 80 }),
    finding({ type: SUBJECT_TYPE.SUPPLIER, id: 1, score: 90 }),
  ]);
  assert.equal(count, 2);
  // Two distinct subjects, each with a single contributor.
  assert.ok(subjects.every((s) => s.detectorCount === 1));
  assert.deepEqual(subjects.map((s) => s.subject.type).sort(), ['load', 'supplier']);
});

test('ranks subjects by combined score descending', () => {
  const { subjects } = aggregate([
    finding({ id: 1, score: 30 }),
    finding({ id: 2, score: 90 }),
    finding({ id: 3, score: 60 }),
  ]);
  assert.deepEqual(subjects.map((s) => s.score), [90, 60, 30]);
});

test('a single score of 100 stays 100 under noisy-or (no overflow)', () => {
  const { subjects } = aggregate([finding({ id: 1, score: 100, severity: SEVERITY.CRITICAL })]);
  assert.equal(subjects[0].score, 100);
});

test('a detector emitting several findings for one subject counts as ONE signal', () => {
  // Same detector, same subject, twice — must NOT noisy-or against itself (that would
  // fabricate corroboration). Its best score is taken; detectorCount stays 1.
  const { subjects } = aggregate([
    finding({ detectorId: 'det-a', id: 1, score: 50 }),
    finding({ detectorId: 'det-a', id: 1, score: 40 }),
  ]);
  const [s] = subjects;
  assert.equal(s.detectorCount, 1);
  assert.equal(s.findingCount, 2);
  assert.equal(s.score, 50); // best single score, NOT 1−0.5·0.6 = 70.
});

test('weights scale a detector\'s contribution; weight 0 mutes it', () => {
  const findings = [
    finding({ detectorId: 'strong', id: 1, score: 80 }),
    finding({ detectorId: 'muted', id: 1, score: 90 }),
  ];
  const muted = aggregate(findings, { weights: { muted: 0 } });
  // muted contributes nothing → combined is just the strong signal (80).
  assert.equal(muted.subjects[0].score, 80);
  assert.equal(muted.subjects[0].detectorCount, 2); // still recorded as a contributor…
  assert.equal(muted.subjects[0].contributors.find((c) => c.detectorId === 'muted').weight, 0);

  // Negative / NaN weights clamp to the default (1), not to a negative score.
  const odd = aggregate(findings, { weights: { strong: -5, muted: 'xyz' } });
  assert.equal(odd.subjects[0].contributors.find((c) => c.detectorId === 'strong').weight, 1);
  assert.equal(odd.subjects[0].contributors.find((c) => c.detectorId === 'muted').weight, 1);
});

test('weighted-mean averages signals (corroboration by agreement)', () => {
  const { subjects } = aggregate(
    [
      finding({ detectorId: 'a', id: 1, score: 40 }),
      finding({ detectorId: 'b', id: 1, score: 80 }),
    ],
    { method: 'weighted-mean' },
  );
  assert.equal(subjects[0].score, 60); // (40 + 80) / 2
});

test('weighted-mean honours weights', () => {
  const { subjects } = aggregate(
    [
      finding({ detectorId: 'a', id: 1, score: 40 }),
      finding({ detectorId: 'b', id: 1, score: 80 }),
    ],
    { method: 'weighted-mean', weights: { b: 3 } },
  );
  // (1·40 + 3·80) / (1 + 3) = 280 / 4 = 70.
  assert.equal(subjects[0].score, 70);
});

test('max method takes the single strongest signal, ignoring corroboration', () => {
  const { subjects } = aggregate(
    [
      finding({ detectorId: 'a', id: 1, score: 40 }),
      finding({ detectorId: 'b', id: 1, score: 80 }),
    ],
    { method: 'max' },
  );
  assert.equal(subjects[0].score, 80); // not boosted above the max.
});

test('unrecognised method falls back to the default (noisy-or)', () => {
  const result = aggregate([finding({ id: 1, score: 50 })], { method: 'nonsense' });
  assert.equal(result.method, DEFAULT_METHOD);
});

test('contributors are sorted by score desc and explain the combined number', () => {
  const { subjects } = aggregate([
    finding({ detectorId: 'low', id: 1, score: 20 }),
    finding({ detectorId: 'high', id: 1, score: 90 }),
    finding({ detectorId: 'mid', id: 1, score: 55 }),
  ]);
  assert.deepEqual(subjects[0].contributors.map((c) => c.detectorId), ['high', 'mid', 'low']);
  assert.deepEqual(subjects[0].contributors.map((c) => c.score), [90, 55, 20]);
});

test('tie-break: more corroborating detectors rank first at equal score', () => {
  // Subject X: two detectors at 50 → noisy-or 75. Subject Y: one detector at 75 → 75.
  // Equal combined score, but X has more corroboration and must rank first.
  const { subjects } = aggregate([
    finding({ detectorId: 'a', id: 'X', score: 50 }),
    finding({ detectorId: 'b', id: 'X', score: 50 }),
    finding({ detectorId: 'a', id: 'Y', score: 75 }),
  ]);
  assert.deepEqual(subjects.map((s) => s.subject.id), ['X', 'Y']);
  assert.equal(subjects[0].detectorCount, 2);
});

test('output is deterministic and reproducible regardless of input order', () => {
  const a = finding({ detectorId: 'a', id: 'P', score: 50 });
  const b = finding({ detectorId: 'b', id: 'P', score: 50 });
  const c = finding({ detectorId: 'a', id: 'Q', score: 90, severity: SEVERITY.CRITICAL });
  const r1 = aggregate([a, b, c]);
  const r2 = aggregate([c, b, a]);
  assert.deepEqual(
    r1.subjects.map((s) => [s.subject.id, s.score]),
    r2.subjects.map((s) => [s.subject.id, s.score]),
  );
});

test('does not mutate the input array or the frozen findings', () => {
  const findings = [
    finding({ detectorId: 'a', id: 1, score: 50 }),
    finding({ detectorId: 'b', id: 1, score: 60 }),
  ];
  const snapshot = [...findings];
  aggregate(findings);
  assert.deepEqual(findings, snapshot); // same order, same objects.
  assert.ok(Object.isFrozen(findings[0])); // findings remain frozen.
});

test('skips findings with no usable subject rather than throwing', () => {
  // A bare object with an unusable subject (bypassing makeFinding) must not crash the run.
  const usable = finding({ id: 1, score: 70 });
  const result = aggregate([usable, { subject: { type: 'load', id: '' } }, { subject: null }, null]);
  assert.equal(result.count, 1);
  assert.equal(result.subjects[0].subject.id, 1);
});

test('non-array input degrades to an empty result', () => {
  assert.deepEqual(aggregate(undefined), { subjects: [], count: 0, method: DEFAULT_METHOD });
  assert.deepEqual(aggregate(null).subjects, []);
});

test('preserves the subject label for the combined view', () => {
  const { subjects } = aggregate([
    finding({ id: 'sup-1', type: SUBJECT_TYPE.SUPPLIER, label: 'Shared Metals Recovery Ltd', score: 70 }),
  ]);
  assert.equal(subjects[0].subject.label, 'Shared Metals Recovery Ltd');
});

test('fuse() is exported and consistent with the documented formulae', () => {
  assert.ok(METHODS.includes('noisy-or'));
  // noisy-or of 50 & 50 weight 1 each.
  assert.equal(
    Math.round(fuse([{ score: 50, weight: 1 }, { score: 50, weight: 1 }], 'noisy-or')),
    75,
  );
  // empty contributions → 0, never NaN.
  assert.equal(fuse([], 'noisy-or'), 0);
  assert.equal(fuse([], 'weighted-mean'), 0);
});
