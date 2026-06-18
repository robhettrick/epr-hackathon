'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ArithmeticIntegrity = require('../../src/detectors/arithmetic-integrity');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector recomputes net = gross − tare − pallet and flags any load whose
 * declared `net` does not reconcile (a formula override / tamper signal). We craft
 * real frozen Loads through `makeLoad` (mirrors the engine path; strings coerce to
 * numbers) and feed thresholds via `ctx.config` so the test exercises the ADR-006
 * wiring, not literals. Mirrors the demo fixture's seeded anomaly
 * (fixtures/demo/README.md: "one AL load whose NET_WEIGHT ≠ GROSS − TARE − PALLET,
 * off by 120 t").
 */
function ctx(config) {
  return config ? { config } : {};
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

// A clean load whose net reconciles exactly: 367 − 10 − 5 = 352.
const CLEAN = {
  gross: 367,
  tare: 10,
  pallet: 5,
  net: 352,
  operatorId: 'E-ACC10001AL',
};

test('flags a load whose declared net does not equal gross − tare − pallet', () => {
  // Same weights as CLEAN but net typed as 232 (expected 352) — off by 120.
  const findings = ArithmeticIntegrity.evaluate(loadsFrom({ ...CLEAN, net: 232 }), ctx());
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'arithmetic-integrity');
  assert.equal(f.subject.type, SUBJECT_TYPE.LOAD);
  assert.equal(f.subject.id, 0);
  assert.equal(f.evidence.expectedNet, 352);
  assert.equal(f.evidence.declaredNet, 232);
  assert.equal(f.evidence.discrepancy, -120);
});

test('a load whose net reconciles exactly produces no finding', () => {
  assert.equal(ArithmeticIntegrity.evaluate(loadsFrom(CLEAN), ctx()).length, 0);
});

test('a discrepancy within tolerance is not flagged (rounding slack)', () => {
  // 352.3 vs expected 352 → 0.3 gap, inside the default 0.5 tolerance.
  assert.equal(
    ArithmeticIntegrity.evaluate(loadsFrom({ ...CLEAN, net: 352.3 }), ctx()).length,
    0,
  );
});

test('a large relative discrepancy is critical; a small one is high', () => {
  // 120/352 ≈ 34% ≥ criticalRel(0.1) → critical
  const big = ArithmeticIntegrity.evaluate(loadsFrom({ ...CLEAN, net: 232 }), ctx())[0];
  assert.equal(big.severity, SEVERITY.CRITICAL);
  // A ~1.4% gap (5/352) sits below criticalRel but above tolerance → high
  const small = ArithmeticIntegrity.evaluate(loadsFrom({ ...CLEAN, net: 357 }), ctx())[0];
  assert.equal(small.severity, SEVERITY.HIGH);
});

test('score scales with the relative discrepancy (bigger override ranks higher)', () => {
  const small = ArithmeticIntegrity.evaluate(loadsFrom({ ...CLEAN, net: 357 }), ctx())[0];
  const big = ArithmeticIntegrity.evaluate(loadsFrom({ ...CLEAN, net: 232 }), ctx())[0];
  assert.ok(big.score > small.score);
  assert.ok(small.score >= 70); // floored at baseScore
  assert.ok(big.score <= 100);
});

test('a load missing any recompute input is skipped (coverage gap, not an anomaly)', () => {
  // No pallet weight → the net cannot be recomputed; skip silently.
  assert.equal(
    ArithmeticIntegrity.evaluate(loadsFrom({ gross: 367, tare: 10, pallet: null, net: 232 }), ctx())
      .length,
    0,
  );
});

test('thresholds come from ctx.config (ADR-006): widening tolerance suppresses a discrepancy', () => {
  const rows = loadsFrom({ ...CLEAN, net: 347 }); // 5-unit gap
  // A 10-unit tolerance absorbs the 5-unit gap → no finding...
  assert.equal(
    ArithmeticIntegrity.evaluate(rows, ctx({ tolerance: 10, baseScore: 70, criticalRel: 0.1 }))
      .length,
    0,
  );
  // ...and the applied thresholds are echoed when it does fire.
  const fired = ArithmeticIntegrity.evaluate(
    rows,
    ctx({ tolerance: 0.5, baseScore: 70, criticalRel: 0.1 }),
  );
  assert.equal(fired.length, 1);
  assert.equal(fired[0].thresholdsUsed.tolerance, 0.5);
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('arithmetic-integrity'), ArithmeticIntegrity);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(ArithmeticIntegrity.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(ArithmeticIntegrity.evaluate({}, ctx()), []);
  assert.deepEqual(ArithmeticIntegrity.evaluate(undefined, ctx()), []);
});

test('fires exactly once on the demo fixtures (the seeded AL load, off by 120 t)', async () => {
  const { ingest } = require('../../src/ingest');
  const dir = 'fixtures/demo';
  const files = ['demo_exporter_AL.xlsx', 'demo_exporter_FB.xlsx'].map((f) => `${dir}/${f}`);
  const { loads } = await ingest(files);
  const findings = ArithmeticIntegrity.evaluate({ loads }, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.label.includes('E-ACC10001AL'), true);
  assert.equal(findings[0].evidence.discrepancy, -120);
});
