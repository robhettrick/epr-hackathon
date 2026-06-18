'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OsrRefusalRate = require('../../src/detectors/osr-refusal-rate');
const { makeLoad } = require('../../src/model/load');
const { deriveEntities } = require('../../src/ingest/entity-derivation');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector reasons over the DERIVED OSR entities and reads each OSR's loads
 * back out of `data.loads` via the entity's `loadIndexes` to compute refused /
 * total. The headline cases build real frozen Loads via `makeLoad` and run them
 * through the production `deriveEntities`, so the test exercises the real entity
 * shape (a `Map<id, Entity>` with `Set` back-refs keyed on `osrName`) — the same
 * path the engine feeds in. Thresholds go through `ctx.config` so the test covers
 * the ADR-006 wiring, not literals. Mirrors fixtures/demo/README.md ("Global
 * Reprocessing Ltd" — 2 of 5 refused; other refused loads sit on single-load OSRs).
 */
function ctx(config) {
  return config ? { config } : {};
}

/** Build the ingested-dataset shape the detector reads: `{ loads, entities }`. */
function dataFrom(...rows) {
  const loads = rows.map((r) => makeLoad(r));
  return { loads, entities: deriveEntities(loads) };
}

/** Five loads to one OSR across two operators, two of them refused (40% > 25%). */
const BUSY = [
  { osrName: 'Busy Reprocessing Ltd', operatorId: 'E-ACC10001AL', refused: 'Yes' },
  { osrName: 'Busy Reprocessing Ltd', operatorId: 'E-ACC10001AL', refused: 'Yes' },
  { osrName: 'Busy Reprocessing Ltd', operatorId: 'E-ACC10001AL', refused: 'No' },
  { osrName: 'Busy Reprocessing Ltd', operatorId: 'E-ACC10002FB', refused: 'No' },
  { osrName: 'Busy Reprocessing Ltd', operatorId: 'E-ACC10002FB', refused: 'No' },
];

test('flags an OSR refusing a high share of its loads', () => {
  const findings = OsrRefusalRate.evaluate(dataFrom(...BUSY), ctx());
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'osr-refusal-rate');
  assert.equal(f.subject.type, SUBJECT_TYPE.OSR);
  assert.equal(f.subject.id, 'busy reprocessing ltd'); // keyed on osrName (BI), normalised
  assert.equal(f.subject.label, 'Busy Reprocessing Ltd');
  assert.equal(f.severity, SEVERITY.MEDIUM); // 0.40 < highRefusalRate (0.5)
  assert.equal(f.evidence.refusedLoads, 2);
  assert.equal(f.evidence.totalLoads, 5);
  assert.equal(f.evidence.refusalRate, 0.4);
  assert.deepEqual(f.evidence.operatorIds.sort(), ['E-ACC10001AL', 'E-ACC10002FB']);
  assert.match(f.reason, /refused 2 of 5/);
});

test('does NOT flag a single-load OSR that happens to be refused (sample of one)', () => {
  // The busy OSR (5 loads, 2 refused) flags; a 1-load 100%-refused OSR must not —
  // it is below minLoads, exactly the "other refused loads sit on single-load OSRs"
  // demo case. Only the genuine pattern survives.
  const findings = OsrRefusalRate.evaluate(
    dataFrom(
      ...BUSY,
      { osrName: 'Tiny One-Off OSR', operatorId: 'E-ACC10001AL', refused: 'Yes' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'busy reprocessing ltd');
});

test('passes an OSR whose refusal share is within the threshold', () => {
  const findings = OsrRefusalRate.evaluate(
    dataFrom(
      { osrName: 'Reliable OSR', operatorId: 'E-ACC10001AL', refused: 'Yes' },
      { osrName: 'Reliable OSR', operatorId: 'E-ACC10001AL', refused: 'No' },
      { osrName: 'Reliable OSR', operatorId: 'E-ACC10001AL', refused: 'No' },
      { osrName: 'Reliable OSR', operatorId: 'E-ACC10001AL', refused: 'No' },
      { osrName: 'Reliable OSR', operatorId: 'E-ACC10001AL', refused: 'No' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 0); // 1/5 = 0.20 ≤ maxRefusalRate (0.25)
});

test('severity escalates to high once the rate reaches highRefusalRate', () => {
  const findings = OsrRefusalRate.evaluate(
    dataFrom(
      { osrName: 'Rejecting OSR', operatorId: 'E-ACC10001AL', refused: 'Yes' },
      { osrName: 'Rejecting OSR', operatorId: 'E-ACC10001AL', refused: 'Yes' },
      { osrName: 'Rejecting OSR', operatorId: 'E-ACC10001AL', refused: 'Yes' },
      { osrName: 'Rejecting OSR', operatorId: 'E-ACC10001AL', refused: 'No' },
      { osrName: 'Rejecting OSR', operatorId: 'E-ACC10001AL', refused: 'No' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.HIGH); // 3/5 = 0.60 ≥ 0.5
  assert.equal(findings[0].evidence.refusalRate, 0.6);
});

test('score scales with how far the refusal rate exceeds the threshold', () => {
  const lower = OsrRefusalRate.evaluate(dataFrom(...BUSY), ctx())[0]; // 0.40
  const higher = OsrRefusalRate.evaluate(
    dataFrom(
      { osrName: 'Worse OSR', operatorId: 'A', refused: 'Yes' },
      { osrName: 'Worse OSR', operatorId: 'A', refused: 'Yes' },
      { osrName: 'Worse OSR', operatorId: 'A', refused: 'Yes' },
      { osrName: 'Worse OSR', operatorId: 'A', refused: 'Yes' },
      { osrName: 'Worse OSR', operatorId: 'A', refused: 'No' },
    ),
    ctx(),
  )[0]; // 0.80
  assert.ok(higher.score > lower.score);
  assert.ok(lower.score >= 60); // floored at baseScore
  assert.ok(higher.score <= 100);
});

test('thresholds come from ctx.config (ADR-006): raising the limit suppresses a finding', () => {
  const data = dataFrom(...BUSY);
  assert.equal(OsrRefusalRate.evaluate(data, ctx()).length, 1);
  // Lifting maxRefusalRate above the OSR's 0.40 share clears it.
  assert.equal(
    OsrRefusalRate.evaluate(data, ctx({ maxRefusalRate: 0.5, minLoads: 3, baseScore: 60, highRefusalRate: 0.5 })).length,
    0,
  );
  // Or demanding more consignments than the OSR has clears it.
  assert.equal(
    OsrRefusalRate.evaluate(data, ctx({ maxRefusalRate: 0.25, minLoads: 6, baseScore: 60, highRefusalRate: 0.5 })).length,
    0,
  );
});

test('thresholdsUsed echoes the applied config (auditability)', () => {
  const findings = OsrRefusalRate.evaluate(
    dataFrom(...BUSY),
    ctx({ maxRefusalRate: 0.3, minLoads: 4, baseScore: 50, highRefusalRate: 0.7 }),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].thresholdsUsed, {
    maxRefusalRate: 0.3,
    minLoads: 4,
    highRefusalRate: 0.7,
  });
});

test('tolerates a Map of OSRs reading loads via loadIndexes (the production shape)', () => {
  const loads = BUSY.map((r) => makeLoad(r));
  const osrs = new Map([
    ['busy reprocessing ltd', {
      type: SUBJECT_TYPE.OSR,
      id: 'busy reprocessing ltd',
      label: 'Busy Reprocessing Ltd',
      loadIndexes: new Set([0, 1, 2, 3, 4]),
      operatorIds: new Set(['E-ACC10001AL', 'E-ACC10002FB']),
    }],
  ]);
  const findings = OsrRefusalRate.evaluate({ loads, entities: { osrs } }, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'busy reprocessing ltd');
  assert.equal(findings[0].evidence.refusedLoads, 2);
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('osr-refusal-rate'), OsrRefusalRate);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(OsrRefusalRate.evaluate({ loads: [], entities: { osrs: new Map() } }, ctx()), []);
  assert.deepEqual(OsrRefusalRate.evaluate({ entities: {} }, ctx()), []);
  assert.deepEqual(OsrRefusalRate.evaluate({}, ctx()), []);
  assert.deepEqual(OsrRefusalRate.evaluate(undefined, ctx()), []);
});
