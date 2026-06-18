'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const MaterialProfile = require('../../src/detectors/material-profile');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector compares each load's declared recyclable proportion (col R) with
 * the recyclable grade implied by its material (col I) — either a "(NN.N%)" suffix
 * in the name or a reviewed entry in material-profiles.json. We craft real frozen
 * Loads through `makeLoad` (mirrors the engine path) and feed thresholds via
 * `ctx.config` so the test exercises the ADR-006 wiring, not literals. Cases
 * mirror docs/anomaly-scenarios-from-sample.md E1.
 */
function ctx(config) {
  return config ? { config } : {};
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

const AAIG = 'Aluminium - AAIG aluminium cans and associated packaging (97.5%)';
const DRINK_CARTONS = 'Fibre-based composite - drink cartons';

test('flags a 97.5%-grade load declaring 0.35 (grade-suffix), and the figures land in evidence', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.35, operatorId: 'E-ACC10001AL' }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'material-profile');
  assert.equal(f.subject.type, SUBJECT_TYPE.LOAD);
  assert.equal(f.subject.id, 0);
  assert.equal(f.evidence.material, AAIG);
  assert.equal(f.evidence.expectedRecyclable, 0.975);
  assert.equal(f.evidence.declaredRecyclable, 0.35);
  assert.equal(f.evidence.shortfall, 0.625);
  assert.equal(f.evidence.source, 'grade-suffix');
  // a 0.625 shortfall is gross → high (E1 baseline is medium)
  assert.equal(f.severity, SEVERITY.HIGH);
});

test('a load declaring exactly its grade reconciles (no finding)', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.975 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('a within-tolerance shortfall passes; just beyond it flags', () => {
  // expected 0.975, tolerance 0.05 → 0.93 (shortfall 0.045) passes, 0.92 (0.055) flags
  assert.equal(
    MaterialProfile.evaluate(loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.93 }), ctx()).length,
    0,
  );
  assert.equal(
    MaterialProfile.evaluate(loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.92 }), ctx()).length,
    1,
  );
});

test('declaring at or ABOVE grade never flags (the check is directional)', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.99 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('keys correctly for a fibre material via the reviewed profile table', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: DRINK_CARTONS, recyclableProportion: 0.3, operatorId: 'E-ACC10002FB' }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.evidence.source, 'profile-table');
  assert.equal(f.evidence.expectedRecyclable, 0.75);
  assert.equal(f.evidence.declaredRecyclable, 0.3);
  // 0.45 shortfall < 0.5 highDeviation → medium
  assert.equal(f.severity, SEVERITY.MEDIUM);
});

test('a fibre material declaring its expected profile value passes', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: DRINK_CARTONS, recyclableProportion: 0.75 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('the en-dash Steel grade suffix parses identically to a hyphen', () => {
  const steel = 'Steel – AAIG steel cans and associated packaging, grade 6E (97.5%)';
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: steel, recyclableProportion: 0.4 }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.expectedRecyclable, 0.975);
  assert.equal(findings[0].evidence.source, 'grade-suffix');
});

test('an unknown material (no suffix, not in the table) produces no finding', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: 'Aluminium - other', recyclableProportion: 0.2 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('a missing recyclable proportion is skipped (data-quality gap, not an anomaly)', () => {
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: AAIG, recyclableProportion: null }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('thresholds come from ctx.config (ADR-006): a per-material tolerance override', () => {
  // A generous per-material tolerance suppresses what the default would flag.
  const findings = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.35 }),
    ctx({ tolerance: 0.05, toleranceByMaterial: { [AAIG]: 0.7 }, baseScore: 60, highDeviation: 0.5 }),
  );
  assert.equal(findings.length, 0);
  // and the override is echoed into thresholdsUsed when it does fire
  const fired = MaterialProfile.evaluate(
    loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.35 }),
    ctx({ tolerance: 0.05, toleranceByMaterial: { [AAIG]: 0.1 }, baseScore: 60, highDeviation: 0.5 }),
  );
  assert.equal(fired.length, 1);
  assert.equal(fired[0].thresholdsUsed.tolerance, 0.1);
});

test('score scales with the shortfall (bigger gap ranks higher)', () => {
  const small = MaterialProfile.evaluate(loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.85 }), ctx())[0];
  const big = MaterialProfile.evaluate(loadsFrom({ descriptionWaste: AAIG, recyclableProportion: 0.2 }), ctx())[0];
  assert.ok(big.score > small.score);
  assert.ok(small.score >= 60); // floored at baseScore
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('material-profile'), MaterialProfile);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(MaterialProfile.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(MaterialProfile.evaluate({}, ctx()), []);
  assert.deepEqual(MaterialProfile.evaluate(undefined, ctx()), []);
});
