'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const VehiclePlateFormat = require('../../src/detectors/vehicle-plate-format');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector flags loads whose carrier vehicle registration (BE) is not a
 * plausible UK number plate. We craft real frozen Loads through `makeLoad` (mirrors
 * the engine path) and feed thresholds via `ctx.config` so the test exercises the
 * ADR-006 wiring, not literals. Mirrors the demo fixture's seeded anomaly
 * (fixtures/demo/README.md: "one AL load with reg NOTAPLATE — not a valid UK plate").
 */
function ctx(config) {
  return config ? { config } : {};
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

test('flags a load whose registration matches no UK plate format', () => {
  const findings = VehiclePlateFormat.evaluate(
    loadsFrom({ carrierVehicleReg: 'NOTAPLATE', operatorId: 'E-ACC10001AL' }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'vehicle-plate-format');
  assert.equal(f.subject.type, SUBJECT_TYPE.LOAD);
  assert.equal(f.subject.id, 0);
  assert.equal(f.severity, SEVERITY.MEDIUM);
  assert.equal(f.evidence.vehicleReg, 'NOTAPLATE');
  assert.equal(f.evidence.normalised, 'NOTAPLATE');
});

test('passes plausible UK plates across every recognised format', () => {
  const valid = [
    'AB12CDE', // current 2001+
    'AB12 CDE', // current with the usual space
    'sh24red', // current, lower-case + the fixture-style seed
    'A123BCD', // prefix 1983–2001
    'ABC123D', // suffix 1963–1983
    'ABC1234', // dateless / NI
    '1234AB', // dateless reversed
  ];
  for (const reg of valid) {
    assert.equal(
      VehiclePlateFormat.evaluate(loadsFrom({ carrierVehicleReg: reg }), ctx()).length,
      0,
      `${reg} should be plausible`,
    );
  }
});

test('the synthetic fixture plate style (AL00REG / FB99REG) is plausible', () => {
  // 2 letters + 2 digits + 3 letters is the current format — these must NOT flag,
  // or the clean fixture rows would all light up alongside the seeded NOTAPLATE.
  const findings = VehiclePlateFormat.evaluate(
    loadsFrom(
      { carrierVehicleReg: 'AL00REG' },
      { carrierVehicleReg: 'FB99REG' },
      { carrierVehicleReg: 'SH24RED' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('a load with no registration is skipped (coverage gap, not a bad plate)', () => {
  assert.equal(
    VehiclePlateFormat.evaluate(loadsFrom({ carrierVehicleReg: null }, {}), ctx()).length,
    0,
  );
});

test('score comes from ctx.config (ADR-006) and is echoed in thresholdsUsed', () => {
  const findings = VehiclePlateFormat.evaluate(
    loadsFrom({ carrierVehicleReg: 'NOTAPLATE' }),
    ctx({ baseScore: 85 }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].score, 85);
  assert.equal(findings[0].thresholdsUsed.baseScore, 85);
});

test('only the offending load is flagged among a mix', () => {
  const findings = VehiclePlateFormat.evaluate(
    loadsFrom(
      { carrierVehicleReg: 'AB12CDE' },
      { carrierVehicleReg: 'JUNK!' },
      { carrierVehicleReg: 'A1BCD' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 1);
  assert.equal(findings[0].evidence.vehicleReg, 'JUNK!');
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('vehicle-plate-format'), VehiclePlateFormat);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(VehiclePlateFormat.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(VehiclePlateFormat.evaluate({}, ctx()), []);
  assert.deepEqual(VehiclePlateFormat.evaluate(undefined, ctx()), []);
});

test('fires exactly once on the demo fixtures (the seeded AL load, reg NOTAPLATE)', async () => {
  const { ingest } = require('../../src/ingest');
  const dir = 'fixtures/demo';
  const files = ['demo_exporter_AL.xlsx', 'demo_exporter_FB.xlsx'].map((f) => `${dir}/${f}`);
  const { loads } = await ingest(files);
  const findings = VehiclePlateFormat.evaluate({ loads }, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.label.includes('E-ACC10001AL'), true);
  assert.equal(findings[0].evidence.vehicleReg, 'NOTAPLATE');
});
