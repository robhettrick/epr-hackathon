'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SingleCustomerManyOperators = require('../../src/detectors/single-customer-many-operators');
const { makeLoad } = require('../../src/model/load');
const { deriveEntities } = require('../../src/ingest/entity-derivation');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The downstream mirror of `single-supplier→many-operators`: it reasons over the
 * DERIVED OSR (customer) entities (not loads), flagging a reprocessor whose
 * `operatorIds` span more than `maxOperatorsPerCustomer` distinct operators across
 * the ingested files. The headline cases build real frozen Loads via `makeLoad`
 * and run them through the production `deriveEntities` so the test exercises the
 * real entity shape (a `Map<id, Entity>` with `Set` back-refs, keyed on `osrName`,
 * BI) — the same path the engine feeds in. Thresholds go through `ctx.config` so
 * the test covers the ADR-006 wiring, not literals. Mirrors
 * fixtures/demo/README.md ("Global Reprocessing Ltd" across both operators).
 */
function ctx(config) {
  return config ? { config } : {};
}

/** Build the ingested-dataset shape the detector reads: `{ entities }`. */
function dataFrom(...rows) {
  const loads = rows.map((r) => makeLoad(r));
  return { entities: deriveEntities(loads) };
}

const SHARED = { osrName: 'Global Reprocessing Ltd' };

test('flags a customer drawing from two distinct operators across files', () => {
  const findings = SingleCustomerManyOperators.evaluate(
    dataFrom(
      { ...SHARED, operatorId: 'E-ACC10001AL' },
      { ...SHARED, operatorId: 'E-ACC10002FB' },
      { ...SHARED, operatorId: 'E-ACC10001AL' }, // a third contributing load, same operator
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'single-customer-many-operators');
  assert.equal(f.subject.type, SUBJECT_TYPE.OSR);
  assert.equal(f.subject.id, 'global reprocessing ltd'); // keyed on osrName (BI), normalised
  assert.equal(f.subject.label, 'Global Reprocessing Ltd');
  assert.equal(f.severity, SEVERITY.MEDIUM); // 2 operators < highOperators (3)
  assert.equal(f.evidence.operatorCount, 2);
  assert.deepEqual(f.evidence.operatorIds.sort(), ['E-ACC10001AL', 'E-ACC10002FB']);
  assert.equal(f.evidence.loadCount, 3);
  assert.match(f.reason, /2 distinct operators/);
});

test('passes a customer fed by a single operator', () => {
  const findings = SingleCustomerManyOperators.evaluate(
    dataFrom(
      { osrName: 'Solo Reprocessing Ltd', operatorId: 'E-ACC10001AL' },
      { osrName: 'Solo Reprocessing Ltd', operatorId: 'E-ACC10001AL' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('flags only the cross-operator customer when both kinds are present', () => {
  const findings = SingleCustomerManyOperators.evaluate(
    dataFrom(
      { ...SHARED, operatorId: 'E-ACC10001AL' },
      { ...SHARED, operatorId: 'E-ACC10002FB' },
      { osrName: 'Solo Reprocessing Ltd', operatorId: 'E-ACC10001AL' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'global reprocessing ltd');
});

test('score scales with the number of operators the customer spans', () => {
  // Craft OSR entities directly so we can vary the operator spread precisely.
  const osr = (id, operatorIds) => ({
    type: SUBJECT_TYPE.OSR,
    id,
    label: id,
    operatorIds: new Set(operatorIds),
    loadIndexes: new Set(operatorIds.map((_, i) => i)),
  });
  const two = SingleCustomerManyOperators.evaluate(
    { entities: { osrs: [osr('o2', ['A', 'B'])] } },
    ctx(),
  )[0];
  const four = SingleCustomerManyOperators.evaluate(
    { entities: { osrs: [osr('o4', ['A', 'B', 'C', 'D'])] } },
    ctx(),
  )[0];
  assert.ok(four.score > two.score);
  assert.ok(two.score >= 60); // floored at baseScore
  assert.ok(four.score <= 100);
});

test('severity escalates to high once the spread reaches highOperators', () => {
  const osr = {
    type: SUBJECT_TYPE.OSR,
    id: 'wide',
    label: 'Wide Reach Reprocessing',
    operatorIds: new Set(['A', 'B', 'C']),
    loadIndexes: new Set([0, 1, 2]),
  };
  const findings = SingleCustomerManyOperators.evaluate(
    { entities: { osrs: [osr] } },
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
  // With the default (1) a 2-operator customer flags; lifting the limit to 2 clears it.
  assert.equal(SingleCustomerManyOperators.evaluate(data, ctx()).length, 1);
  const findings = SingleCustomerManyOperators.evaluate(
    data,
    ctx({ maxOperatorsPerCustomer: 2, baseScore: 60, saturationOperators: 5, highOperators: 3 }),
  );
  assert.equal(findings.length, 0);
});

test('thresholdsUsed echoes the applied config (auditability)', () => {
  const findings = SingleCustomerManyOperators.evaluate(
    dataFrom(
      { ...SHARED, operatorId: 'A' },
      { ...SHARED, operatorId: 'B' },
    ),
    ctx({ maxOperatorsPerCustomer: 1, baseScore: 50, saturationOperators: 4, highOperators: 5 }),
  );
  assert.deepEqual(findings[0].thresholdsUsed, {
    maxOperatorsPerCustomer: 1,
    saturationOperators: 4,
    highOperators: 5,
  });
});

test('tolerates a Map of OSRs (the production entity shape)', () => {
  const osrs = new Map([
    ['global reprocessing ltd', {
      type: SUBJECT_TYPE.OSR,
      id: 'global reprocessing ltd',
      label: 'Global Reprocessing Ltd',
      operatorIds: new Set(['A', 'B']),
      loadIndexes: new Set([0, 1]),
    }],
  ]);
  const findings = SingleCustomerManyOperators.evaluate({ entities: { osrs } }, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'global reprocessing ltd');
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('single-customer-many-operators'), SingleCustomerManyOperators);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(SingleCustomerManyOperators.evaluate({ entities: { osrs: new Map() } }, ctx()), []);
  assert.deepEqual(SingleCustomerManyOperators.evaluate({ entities: {} }, ctx()), []);
  assert.deepEqual(SingleCustomerManyOperators.evaluate({}, ctx()), []);
  assert.deepEqual(SingleCustomerManyOperators.evaluate(undefined, ctx()), []);
});
