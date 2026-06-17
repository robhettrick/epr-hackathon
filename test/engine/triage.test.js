'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { triage, byScoreDesc, severityRank, SURFACE_DEFAULTS } = require('../../src/engine/triage');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * Build a minimal valid Finding for triage tests. Triage only reads `score`,
 * `severity` and `subject.id`, but we go through `makeFinding` so the fixtures are
 * real contract objects (frozen), proving triage never mutates them.
 */
function finding(id, score, severity = SEVERITY.MEDIUM) {
  return makeFinding({
    detectorId: 'test-detector',
    version: '1.0.0',
    subject: { type: SUBJECT_TYPE.LOAD, id, label: `Load #${id}` },
    score,
    severity,
    reason: 'test',
  });
}

test('ranks findings by score descending (PRD §5.3)', () => {
  const result = triage([finding(1, 10), finding(2, 90), finding(3, 50)]);
  assert.deepEqual(result.surfaced.map((f) => f.score), [90, 50, 10]);
  assert.equal(result.surfacedCount, 3);
  assert.equal(result.hiddenCount, 0);
  assert.equal(result.total, 3);
});

test('raising the threshold drops lower-scoring findings (done-when / ADR-009)', () => {
  const findings = [finding(1, 30), finding(2, 60), finding(3, 90)];

  const low = triage(findings, { minScore: 0 });
  assert.deepEqual(low.surfaced.map((f) => f.score), [90, 60, 30]);

  const raised = triage(findings, { minScore: 50 });
  assert.deepEqual(raised.surfaced.map((f) => f.score), [90, 60]);
  // The dropped finding is withheld, not lost — still available + ranked.
  assert.deepEqual(raised.hidden.map((f) => f.score), [30]);
  assert.equal(raised.surfacedCount, 2);
  assert.equal(raised.hiddenCount, 1);
});

test('minScore is inclusive (>=), boundary surfaces', () => {
  const result = triage([finding(1, 50), finding(2, 49)], { minScore: 50 });
  assert.deepEqual(result.surfaced.map((f) => f.score), [50]);
  assert.deepEqual(result.hidden.map((f) => f.score), [49]);
});

test('minSeverity gate surfaces only findings at least that severe', () => {
  const findings = [
    finding(1, 80, SEVERITY.LOW),
    finding(2, 70, SEVERITY.HIGH),
    finding(3, 60, SEVERITY.CRITICAL),
    finding(4, 50, SEVERITY.MEDIUM),
  ];
  const result = triage(findings, { minSeverity: SEVERITY.HIGH });
  // high + critical surface (ranked by score), regardless of the higher LOW score.
  assert.deepEqual(result.surfaced.map((f) => f.subject.id), [2, 3]);
  assert.deepEqual(result.hidden.map((f) => f.subject.id), [1, 4]);
});

test('limit caps surfaced to investigator capacity; overflow is hidden but ranked', () => {
  const result = triage([finding(1, 30), finding(2, 90), finding(3, 60), finding(4, 10)], {
    limit: 2,
  });
  assert.deepEqual(result.surfaced.map((f) => f.score), [90, 60]);
  // Capacity-dropped findings join `hidden`, still in score-desc order.
  assert.deepEqual(result.hidden.map((f) => f.score), [30, 10]);
});

test('minScore and limit compose: threshold filters first, then capacity caps', () => {
  const result = triage([finding(1, 95), finding(2, 80), finding(3, 40), finding(4, 70)], {
    minScore: 50,
    limit: 2,
  });
  // 40 fails the threshold; of {95,80,70} only the top 2 fit the limit.
  assert.deepEqual(result.surfaced.map((f) => f.score), [95, 80]);
  assert.deepEqual(result.hidden.map((f) => f.score), [70, 40]);
});

test('deterministic tie-break: equal scores order by severity then subject id', () => {
  const findings = [
    finding(2, 50, SEVERITY.LOW),
    finding(1, 50, SEVERITY.LOW),
    finding(3, 50, SEVERITY.CRITICAL),
  ];
  const result = triage(findings);
  // critical first (more severe); the two LOWs tie on severity → ascending id 1,2.
  assert.deepEqual(result.surfaced.map((f) => f.subject.id), [3, 1, 2]);
});

test('does not mutate or reorder the input array', () => {
  const findings = [finding(1, 10), finding(2, 90)];
  const snapshot = findings.slice();
  triage(findings, { minScore: 50 });
  assert.deepEqual(findings, snapshot);
  assert.equal(findings[0].score, 10); // original order preserved
});

test('echoes the resolved thresholds for the UI/audit', () => {
  const result = triage([finding(1, 50)], { minScore: 30, minSeverity: SEVERITY.HIGH, limit: 5 });
  assert.deepEqual(result.thresholds, { minScore: 30, minSeverity: 'high', limit: 5 });
});

test('coerces malformed query-param options instead of throwing (ADR-009)', () => {
  const findings = [finding(1, 80), finding(2, 20)];
  // minScore="abc" → 0, minSeverity="bogus" → null, limit="x" → null: surface all.
  const result = triage(findings, { minScore: 'abc', minSeverity: 'bogus', limit: 'x' });
  assert.equal(result.surfacedCount, 2);
  assert.deepEqual(result.thresholds, { minScore: 0, minSeverity: null, limit: null });
});

test('coerces a numeric string minScore (query params arrive as strings)', () => {
  const result = triage([finding(1, 80), finding(2, 40)], { minScore: '50' });
  assert.deepEqual(result.surfaced.map((f) => f.score), [80]);
  assert.equal(result.thresholds.minScore, 50);
});

test('clamps out-of-range minScore to 0–100', () => {
  assert.equal(triage([], { minScore: -10 }).thresholds.minScore, 0);
  assert.equal(triage([], { minScore: 250 }).thresholds.minScore, 100);
});

test('ignores a non-positive or non-integer limit (no cap)', () => {
  assert.equal(triage([finding(1, 10)], { limit: 0 }).thresholds.limit, null);
  assert.equal(triage([finding(1, 10)], { limit: -3 }).thresholds.limit, null);
  assert.equal(triage([finding(1, 10)], { limit: 2.7 }).thresholds.limit, 2);
});

test('tolerates a non-array input → empty result, no throw', () => {
  const result = triage(undefined);
  assert.deepEqual(result.surfaced, []);
  assert.deepEqual(result.hidden, []);
  assert.equal(result.total, 0);
});

test('empty findings → empty surfaced/hidden', () => {
  const result = triage([]);
  assert.equal(result.total, 0);
  assert.equal(result.surfacedCount, 0);
  assert.equal(result.hiddenCount, 0);
});

test('SURFACE_DEFAULTS is the no-op threshold (surface everything)', () => {
  assert.deepEqual(SURFACE_DEFAULTS, { minScore: 0, minSeverity: null, limit: null });
  const findings = [finding(1, 1), finding(2, 100)];
  const result = triage(findings, SURFACE_DEFAULTS);
  assert.equal(result.surfacedCount, 2);
});

test('severityRank reflects the low→critical order', () => {
  assert.ok(severityRank(SEVERITY.CRITICAL) > severityRank(SEVERITY.HIGH));
  assert.ok(severityRank(SEVERITY.HIGH) > severityRank(SEVERITY.MEDIUM));
  assert.ok(severityRank(SEVERITY.MEDIUM) > severityRank(SEVERITY.LOW));
  assert.equal(severityRank('nonsense'), -1);
});

test('byScoreDesc is a usable standalone comparator', () => {
  const sorted = [finding(1, 10), finding(2, 90), finding(3, 50)].sort(byScoreDesc);
  assert.deepEqual(sorted.map((f) => f.score), [90, 50, 10]);
});
