'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SingleSupplierManyOperators = require('../../src/detectors/single-supplier-many-operators');
const { makeLoad } = require('../../src/model/load');
const { deriveEntities } = require('../../src/ingest/entity-derivation');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector reasons over the DERIVED supplier entities (not loads): it flags a
 * supplier whose `operatorIds` span more than `maxOperatorsPerSupplier` distinct
 * operators across the ingested files. The headline cases build real frozen Loads
 * via `makeLoad` and run them through the production `deriveEntities` so the test
 * exercises the real entity shape (a `Map<id, Entity>` with `Set` back-refs, keyed
 * on postcode then name) — the same path the engine feeds in. Thresholds go through
 * `ctx.config` so the test covers the ADR-006 wiring, not literals. Mirrors
 * docs/anomaly-scenarios-from-sample.md and fixtures/demo/README.md ("Shared Metals
 * Recovery Ltd" across both operators).
 */
function ctx(config) {
  return config ? { config } : {};
}

/** Build the ingested-dataset shape the detector reads: `{ entities }`. */
function dataFrom(...rows) {
  const loads = rows.map((r) => makeLoad(r));
  return { entities: deriveEntities(loads) };
}

const SHARED = { supplierName: 'Shared Metals Recovery Ltd', supplierPostcode: 'LS1 4AB' };

test('flags a supplier feeding two distinct operators across files', () => {
  const findings = SingleSupplierManyOperators.evaluate(
    dataFrom(
      { ...SHARED, operatorId: 'E-ACC10001AL' },
      { ...SHARED, operatorId: 'E-ACC10002FB' },
      { ...SHARED, operatorId: 'E-ACC10001AL' }, // a third contributing load, same operator
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'single-supplier-many-operators');
  assert.equal(f.subject.type, SUBJECT_TYPE.SUPPLIER);
  assert.equal(f.subject.id, 'ls1 4ab'); // keyed on postcode (AJ) then normalised
  assert.equal(f.subject.label, 'Shared Metals Recovery Ltd');
  assert.equal(f.severity, SEVERITY.MEDIUM); // 2 operators < highOperators (3)
  assert.equal(f.evidence.operatorCount, 2);
  assert.deepEqual(f.evidence.operatorIds.sort(), ['E-ACC10001AL', 'E-ACC10002FB']);
  assert.equal(f.evidence.loadCount, 3);
  assert.match(f.reason, /two|2 distinct operators|2 distinct/);
});

test('passes a supplier feeding a single operator', () => {
  const findings = SingleSupplierManyOperators.evaluate(
    dataFrom(
      { supplierName: 'Solo Supplies Ltd', supplierPostcode: 'AB1 2CD', operatorId: 'E-ACC10001AL' },
      { supplierName: 'Solo Supplies Ltd', supplierPostcode: 'AB1 2CD', operatorId: 'E-ACC10001AL' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('flags only the cross-operator supplier when both kinds are present', () => {
  const findings = SingleSupplierManyOperators.evaluate(
    dataFrom(
      { ...SHARED, operatorId: 'E-ACC10001AL' },
      { ...SHARED, operatorId: 'E-ACC10002FB' },
      { supplierName: 'Solo Supplies Ltd', supplierPostcode: 'AB1 2CD', operatorId: 'E-ACC10001AL' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'ls1 4ab');
});

test('score scales with the number of operators the supplier spans', () => {
  // Craft supplier entities directly so we can vary the operator spread precisely.
  const supplier = (id, operatorIds) => ({
    type: SUBJECT_TYPE.SUPPLIER,
    id,
    label: id,
    operatorIds: new Set(operatorIds),
    loadIndexes: new Set(operatorIds.map((_, i) => i)),
  });
  const two = SingleSupplierManyOperators.evaluate(
    { entities: { suppliers: [supplier('s2', ['A', 'B'])] } },
    ctx(),
  )[0];
  const four = SingleSupplierManyOperators.evaluate(
    { entities: { suppliers: [supplier('s4', ['A', 'B', 'C', 'D'])] } },
    ctx(),
  )[0];
  assert.ok(four.score > two.score);
  assert.ok(two.score >= 60); // floored at baseScore
  assert.ok(four.score <= 100);
});

test('severity escalates to high once the spread reaches highOperators', () => {
  const supplier = {
    type: SUBJECT_TYPE.SUPPLIER,
    id: 'wide',
    label: 'Wide Reach Ltd',
    operatorIds: new Set(['A', 'B', 'C']),
    loadIndexes: new Set([0, 1, 2]),
  };
  const findings = SingleSupplierManyOperators.evaluate(
    { entities: { suppliers: [supplier] } },
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.HIGH); // 3 >= highOperators (3)
});

test('thresholds come from ctx.config (ADR-006): raising the limit suppresses a finding', () => {
  const data = dataFrom(
    { ...SHARED, operatorId: 'E-ACC10001AL' },
    { ...SHARED, operatorId: 'E-ACC10002FB' },
  );
  // With the default (1) a 2-operator supplier flags; lifting the limit to 2 clears it.
  assert.equal(SingleSupplierManyOperators.evaluate(data, ctx()).length, 1);
  const findings = SingleSupplierManyOperators.evaluate(
    data,
    ctx({ maxOperatorsPerSupplier: 2, baseScore: 60, saturationOperators: 5, highOperators: 3 }),
  );
  assert.equal(findings.length, 0);
});

test('thresholdsUsed echoes the applied config (auditability)', () => {
  const findings = SingleSupplierManyOperators.evaluate(
    dataFrom(
      { ...SHARED, operatorId: 'A' },
      { ...SHARED, operatorId: 'B' },
    ),
    ctx({ maxOperatorsPerSupplier: 1, baseScore: 50, saturationOperators: 4, highOperators: 5 }),
  );
  assert.deepEqual(findings[0].thresholdsUsed, {
    maxOperatorsPerSupplier: 1,
    saturationOperators: 4,
    highOperators: 5,
  });
});

test('tolerates a Map of suppliers (the production entity shape)', () => {
  const suppliers = new Map([
    ['ls1 4ab', {
      type: SUBJECT_TYPE.SUPPLIER,
      id: 'ls1 4ab',
      label: 'Shared Metals Recovery Ltd',
      operatorIds: new Set(['A', 'B']),
      loadIndexes: new Set([0, 1]),
    }],
  ]);
  const findings = SingleSupplierManyOperators.evaluate({ entities: { suppliers } }, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'ls1 4ab');
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('single-supplier-many-operators'), SingleSupplierManyOperators);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(SingleSupplierManyOperators.evaluate({ entities: { suppliers: new Map() } }, ctx()), []);
  assert.deepEqual(SingleSupplierManyOperators.evaluate({ entities: {} }, ctx()), []);
  assert.deepEqual(SingleSupplierManyOperators.evaluate({}, ctx()), []);
  assert.deepEqual(SingleSupplierManyOperators.evaluate(undefined, ctx()), []);
});
