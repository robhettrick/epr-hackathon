'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SharedVehicleAcrossOperators = require('../../src/detectors/shared-vehicle-across-operators');
const { makeLoad } = require('../../src/model/load');
const { deriveEntities } = require('../../src/ingest/entity-derivation');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The vehicle-network detector: it reasons over the DERIVED vehicle entities (keyed
 * on `carrierVehicleReg`, BE), reading each vehicle's loads back out of `data.loads`
 * to inspect their carriage dates. It flags a vehicle that appears under ≥2 distinct
 * operators ON OVERLAPPING DATES — physically a single truck cannot be in two
 * operators' chains at once. The date overlap is the gate that distinguishes it from
 * `single-supplier→many-operators` (pure spread); a carrier reused months apart is
 * NOT flagged. Headline cases build real frozen Loads via `makeLoad` and run them
 * through the production `deriveEntities` so the test exercises the real entity shape
 * (`Map<id, Entity>` with `Set` back-refs). Thresholds go through `ctx.config` so the
 * test covers the ADR-006 wiring. Mirrors fixtures/demo/README.md (reg `SH24RED`
 * across both operators, 4 loads, overlapping February windows).
 */
function ctx(config) {
  return config ? { config } : {};
}

/** Build the ingested-dataset shape the detector reads: `{ loads, entities }`. */
function dataFrom(...rows) {
  const loads = rows.map((r) => makeLoad(r));
  return { loads, entities: deriveEntities(loads) };
}

/** A carriage-window load: a reg + operator + an exported date drives the overlap. */
function carriage(reg, operatorId, recv, exp, osr) {
  return {
    carrierVehicleReg: reg,
    operatorId,
    receivedForExport: recv ? new Date(recv) : null,
    exported: exp ? new Date(exp) : null,
    receivedByOsr: osr ? new Date(osr) : null,
  };
}

test('flags a vehicle shared by two operators on overlapping dates', () => {
  const findings = SharedVehicleAcrossOperators.evaluate(
    dataFrom(
      carriage('SH24RED', 'E-ACC10001AL', '2026-02-14', '2026-02-18', '2026-02-23'),
      carriage('SH24RED', 'E-ACC10002FB', '2026-02-15', '2026-02-19', '2026-02-24'),
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'shared-vehicle-across-operators');
  assert.equal(f.subject.type, SUBJECT_TYPE.VEHICLE);
  assert.equal(f.subject.id, 'sh24red'); // keyed on carrierVehicleReg (BE), normalised
  assert.equal(f.subject.label, 'SH24RED');
  assert.equal(f.severity, SEVERITY.MEDIUM); // 2 operators < highOperators (3)
  assert.equal(f.evidence.operatorCount, 2);
  assert.deepEqual(f.evidence.operatorIds.sort(), ['E-ACC10001AL', 'E-ACC10002FB']);
  assert.equal(f.evidence.loadCount, 2);
  assert.ok(f.evidence.overlappingPairCount >= 1, 'a cross-operator window pair overlaps');
  assert.equal(f.evidence.overlap.sharedFrom, '2026-02-15'); // intersection start
  assert.equal(f.evidence.overlap.sharedTo, '2026-02-23'); // intersection end
  assert.match(f.reason, /overlapping dates/);
});

test('passes a vehicle shared across operators on NON-overlapping dates (gate)', () => {
  // Same reg, two operators, but the carriage windows are months apart — a carrier
  // legitimately sub-contracted at different times, not the same-time pattern.
  const findings = SharedVehicleAcrossOperators.evaluate(
    dataFrom(
      carriage('AB12CDE', 'E-ACC10001AL', '2026-01-05', '2026-01-09', '2026-01-14'),
      carriage('AB12CDE', 'E-ACC10002FB', '2026-06-05', '2026-06-09', '2026-06-14'),
    ),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('passes a vehicle used by a single operator (even with internal overlap)', () => {
  const findings = SharedVehicleAcrossOperators.evaluate(
    dataFrom(
      carriage('SOLO123', 'E-ACC10001AL', '2026-02-14', '2026-02-18', '2026-02-23'),
      carriage('SOLO123', 'E-ACC10001AL', '2026-02-15', '2026-02-19', '2026-02-24'),
    ),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('flags only the overlapping shared vehicle when several are present', () => {
  const findings = SharedVehicleAcrossOperators.evaluate(
    dataFrom(
      // overlapping shared vehicle → flagged
      carriage('SH24RED', 'E-ACC10001AL', '2026-02-14', '2026-02-18', '2026-02-23'),
      carriage('SH24RED', 'E-ACC10002FB', '2026-02-15', '2026-02-19', '2026-02-24'),
      // non-overlapping shared vehicle → not flagged
      carriage('AB12CDE', 'E-ACC10001AL', '2026-01-05', '2026-01-09', '2026-01-14'),
      carriage('AB12CDE', 'E-ACC10002FB', '2026-06-05', '2026-06-09', '2026-06-14'),
      // single-operator vehicle → not flagged
      carriage('SOLO123', 'E-ACC10001AL', '2026-03-01', '2026-03-05', '2026-03-10'),
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'sh24red');
});

test('requireOverlap:false degrades to pure cross-operator spread', () => {
  const data = dataFrom(
    carriage('AB12CDE', 'E-ACC10001AL', '2026-01-05', '2026-01-09', '2026-01-14'),
    carriage('AB12CDE', 'E-ACC10002FB', '2026-06-05', '2026-06-09', '2026-06-14'),
  );
  // Gate on by default → not flagged (months apart); gate off → flagged on spread alone.
  assert.equal(SharedVehicleAcrossOperators.evaluate(data, ctx()).length, 0);
  const findings = SharedVehicleAcrossOperators.evaluate(
    data,
    ctx({ maxOperatorsPerVehicle: 1, requireOverlap: false, toleranceDays: 0, baseScore: 60, saturationOperators: 5, highOperators: 3 }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.overlap, null, 'no overlapping window when the gate is off');
});

test('toleranceDays widens the window so near-misses overlap', () => {
  // AL ends 2026-02-20, FB starts 2026-02-23 — a 3-day gap, no overlap at tol 0.
  const data = dataFrom(
    carriage('SH24RED', 'E-ACC10001AL', '2026-02-16', '2026-02-18', '2026-02-20'),
    carriage('SH24RED', 'E-ACC10002FB', '2026-02-23', '2026-02-25', '2026-02-27'),
  );
  assert.equal(SharedVehicleAcrossOperators.evaluate(data, ctx()).length, 0);
  const findings = SharedVehicleAcrossOperators.evaluate(
    data,
    ctx({ maxOperatorsPerVehicle: 1, requireOverlap: true, toleranceDays: 5, baseScore: 60, saturationOperators: 5, highOperators: 3 }),
  );
  assert.equal(findings.length, 1, 'a 5-day tolerance bridges the 3-day gap');
});

test('score scales with the number of operators the vehicle spans', () => {
  // Craft vehicle entities directly + matching date-less loads; with requireOverlap
  // off the score depends only on the operator spread.
  const vehicle = (id, operatorIds) => ({
    type: SUBJECT_TYPE.VEHICLE,
    id,
    label: id,
    operatorIds: new Set(operatorIds),
    loadIndexes: new Set(),
  });
  const cfgNoGate = { maxOperatorsPerVehicle: 1, requireOverlap: false, toleranceDays: 0, baseScore: 60, saturationOperators: 5, highOperators: 3 };
  const two = SharedVehicleAcrossOperators.evaluate(
    { loads: [], entities: { vehicles: [vehicle('v2', ['A', 'B'])] } },
    ctx(cfgNoGate),
  )[0];
  const four = SharedVehicleAcrossOperators.evaluate(
    { loads: [], entities: { vehicles: [vehicle('v4', ['A', 'B', 'C', 'D'])] } },
    ctx(cfgNoGate),
  )[0];
  assert.ok(four.score > two.score);
  assert.ok(two.score >= 60); // floored at baseScore
  assert.ok(four.score <= 100);
});

test('severity escalates to high once the spread reaches highOperators', () => {
  const vehicle = {
    type: SUBJECT_TYPE.VEHICLE,
    id: 'wide',
    label: 'WIDE123',
    operatorIds: new Set(['A', 'B', 'C']),
    loadIndexes: new Set(),
  };
  const findings = SharedVehicleAcrossOperators.evaluate(
    { loads: [], entities: { vehicles: [vehicle] } },
    ctx({ maxOperatorsPerVehicle: 1, requireOverlap: false, toleranceDays: 0, baseScore: 60, saturationOperators: 5, highOperators: 3 }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, SEVERITY.HIGH); // 3 >= highOperators (3)
});

test('thresholds come from ctx.config (ADR-006): raising the limit suppresses a finding', () => {
  const data = dataFrom(
    carriage('SH24RED', 'E-ACC10001AL', '2026-02-14', '2026-02-18', '2026-02-23'),
    carriage('SH24RED', 'E-ACC10002FB', '2026-02-15', '2026-02-19', '2026-02-24'),
  );
  assert.equal(SharedVehicleAcrossOperators.evaluate(data, ctx()).length, 1);
  const findings = SharedVehicleAcrossOperators.evaluate(
    data,
    ctx({ maxOperatorsPerVehicle: 2, requireOverlap: true, toleranceDays: 0, baseScore: 60, saturationOperators: 5, highOperators: 3 }),
  );
  assert.equal(findings.length, 0);
});

test('thresholdsUsed echoes the applied config (auditability)', () => {
  const findings = SharedVehicleAcrossOperators.evaluate(
    dataFrom(
      carriage('SH24RED', 'A', '2026-02-14', '2026-02-18', '2026-02-23'),
      carriage('SH24RED', 'B', '2026-02-15', '2026-02-19', '2026-02-24'),
    ),
    ctx({ maxOperatorsPerVehicle: 1, requireOverlap: true, toleranceDays: 2, baseScore: 50, saturationOperators: 4, highOperators: 5 }),
  );
  assert.deepEqual(findings[0].thresholdsUsed, {
    maxOperatorsPerVehicle: 1,
    requireOverlap: true,
    toleranceDays: 2,
    saturationOperators: 4,
    highOperators: 5,
  });
});

test('tolerates a Map of vehicles (the production entity shape)', () => {
  const data = dataFrom(
    carriage('SH24RED', 'E-ACC10001AL', '2026-02-14', '2026-02-18', '2026-02-23'),
    carriage('SH24RED', 'E-ACC10002FB', '2026-02-15', '2026-02-19', '2026-02-24'),
  );
  assert.ok(data.entities.vehicles instanceof Map, 'deriveEntities yields a Map');
  const findings = SharedVehicleAcrossOperators.evaluate(data, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'sh24red');
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('shared-vehicle-across-operators'), SharedVehicleAcrossOperators);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(SharedVehicleAcrossOperators.evaluate({ entities: { vehicles: new Map() } }, ctx()), []);
  assert.deepEqual(SharedVehicleAcrossOperators.evaluate({ entities: {} }, ctx()), []);
  assert.deepEqual(SharedVehicleAcrossOperators.evaluate({}, ctx()), []);
  assert.deepEqual(SharedVehicleAcrossOperators.evaluate(undefined, ctx()), []);
});
