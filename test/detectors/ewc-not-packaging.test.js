'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const EwcNotPackaging = require('../../src/detectors/ewc-not-packaging');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector validates each load's EWC code against reference lists. We feed it
 * a minimal `ctx.reference` in the canonical `allowed-codes.json` shape and craft
 * loads through `makeLoad` so they are real frozen Loads (mirrors the engine path).
 *
 * Why these cases: docs/anomaly-scenarios-from-sample.md D1/D2 — a `15 01 xx`
 * packaging code is the only thing that should pass; `20 03 01` is the canonical
 * non-packaging example (golden-path demo step), and a `*` code is the critical
 * hazardous case. Off-list and the prefix-fallback cover the other two branches.
 */
const REFERENCE = {
  // a small but representative slice; mixes packaging, non-packaging and hazardous
  ewcCodes: ['15 01 01', '15 01 04', '15 01 10*', '20 03 01', '19 12 04', '10 03 21*'],
  packagingEwcCodes: ['15 01 01', '15 01 04', '15 01 10*'],
};

function ctx(reference = REFERENCE, config) {
  return config ? { reference, config } : { reference };
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

test('a 15 01 04 packaging load passes (no finding)', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '15 01 04', material: 'Aluminium' }), ctx());
  assert.equal(findings.length, 0);
});

test('a 20 03 01 (municipal) load flags as non-packaging, high severity', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '20 03 01', material: 'Aluminium' }), ctx());
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'ewc-not-packaging');
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.equal(f.evidence.category, 'non-packaging');
  assert.equal(f.evidence.ewcCode, '20 03 01');
  assert.equal(f.subject.type, SUBJECT_TYPE.LOAD);
});

test('a hazardous (*) code flags as critical severity', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '10 03 21*', material: 'Aluminium' }), ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.CRITICAL);
  assert.equal(findings[0].evidence.category, 'hazardous');
});

test('hazard outranks chapter: a hazardous packaging code (15 01 10*) is critical, not a pass', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '15 01 10*' }), ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.CRITICAL);
  assert.equal(findings[0].evidence.category, 'hazardous');
});

test('a code absent from the reference list flags as off-list, high severity', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '99 99 99' }), ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.HIGH);
  assert.equal(findings[0].evidence.category, 'off-list');
});

test('hazardous scores above off-list scores above non-packaging', () => {
  const findings = EwcNotPackaging.evaluate(
    loadsFrom({ ewcCode: '10 03 21*' }, { ewcCode: '99 99 99' }, { ewcCode: '20 03 01' }),
    ctx(),
  );
  const byCat = Object.fromEntries(findings.map((f) => [f.evidence.category, f.score]));
  assert.ok(byCat.hazardous > byCat['off-list']);
  assert.ok(byCat['off-list'] > byCat['non-packaging']);
});

test('a blank EWC code is skipped (not this detector\'s concern)', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '', material: 'Aluminium' }), ctx());
  assert.equal(findings.length, 0);
});

test('packaging subset is derived from the 15 01 prefix when no explicit list is supplied', () => {
  // ingest-reference shape: only `allowedEwc`, no `packagingEwcCodes`.
  const reference = { allowedEwc: ['15 01 04', '20 03 01'] };
  const findings = EwcNotPackaging.evaluate(
    loadsFrom({ ewcCode: '15 01 04' }, { ewcCode: '20 03 01' }),
    ctx(reference),
  );
  // 15 01 04 derived as packaging → passes; 20 03 01 → non-packaging finding.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.category, 'non-packaging');
  assert.equal(findings[0].evidence.ewcCode, '20 03 01');
});

test('scores are read from ctx.config, not hard-coded (ADR-006)', () => {
  const config = { scores: { hazardous: 50, offList: 40, nonPackaging: 30 } };
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '20 03 01' }), ctx(REFERENCE, config));
  assert.equal(findings[0].score, 30);
  assert.deepEqual(findings[0].thresholdsUsed.scores, config.scores);
});

test('whitespace-variant codes still match the reference (normalised compare)', () => {
  const findings = EwcNotPackaging.evaluate(loadsFrom({ ewcCode: '15  01   04' }), ctx());
  assert.equal(findings.length, 0); // normalises to "15 01 04" → packaging → passes
});

test('the detector self-registered under its meta id', () => {
  const registry = require('../../src/detectors/registry');
  assert.equal(registry.get('ewc-not-packaging'), EwcNotPackaging);
  assert.ok(registry.getEnabled().includes(EwcNotPackaging));
});

test('subject.id is the load index and falls back to "unknown operator" in the label', () => {
  const findings = EwcNotPackaging.evaluate(
    loadsFrom({ ewcCode: '15 01 04' }, { ewcCode: '20 03 01' }),
    ctx(),
  );
  assert.equal(findings[0].subject.id, 1); // index 0 passed; the flagged one is index 1
  assert.match(findings[0].subject.label, /unknown operator/);
});

test('empty / missing data.loads yields no findings (never throws)', () => {
  assert.deepEqual(EwcNotPackaging.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(EwcNotPackaging.evaluate({}, ctx()), []);
  assert.deepEqual(EwcNotPackaging.evaluate(undefined, ctx()), []);
});
