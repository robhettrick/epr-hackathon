'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { makeLoad } = require('../../src/model/load');
const { deriveEntities } = require('../../src/ingest/entity-derivation');
const {
  applyNetworkSeed,
  SHARED_SUPPLIER,
  SHARED_VEHICLE,
  DEFAULTS,
} = require('../../src/ingest/seed-overlay');
const { ingest } = require('../../src/ingest/index');

// A tiny two-operator dataset whose suppliers/vehicles deliberately do NOT overlap
// (mirrors the synthetic fixtures: distinct postcodes/regs per operator). Two
// operators, three loads each, so DEFAULTS.loadsPerOperator (3) seeds them all.
function makeDataset() {
  const rows = [];
  for (const op of ['OP-A', 'OP-B']) {
    for (let i = 0; i < 3; i += 1) {
      rows.push(makeLoad({
        operatorId: op,
        ewcCode: '15 01 04',
        descriptionWaste: `widget ${op}-${i}`,
        receivedForExport: new Date('2025-01-02T00:00:00Z'),
        net: 10 + i,
        supplierName: `${op} Supplier ${i}`,
        supplierPostcode: `${op === 'OP-A' ? 'AA1' : 'BB2'} ${i}XX`,
        carrierVehicleReg: `${op}${i}REG`,
      }));
    }
  }
  return rows;
}

const supplierKey = SHARED_SUPPLIER.postcode.toLowerCase();
const vehicleKey = SHARED_VEHICLE.reg.toLowerCase();

test('seeds the shared supplier across ≥2 operators (postcode-keyed)', () => {
  const seeded = applyNetworkSeed(makeDataset());
  const { suppliers } = deriveEntities(seeded);
  const shared = suppliers.get(supplierKey);
  assert.ok(shared, 'the shared supplier entity exists, keyed on its postcode');
  assert.equal(shared.operatorIds.size, 2, 'shared supplier spans both operators');
  assert.equal(shared.label, SHARED_SUPPLIER.name, 'display label is the shared name');
  // 3 loads per operator × 2 operators = 6 loads re-pointed at the shared supplier.
  assert.equal(shared.loadIndexes.size, 6);
});

test('seeds the shared vehicle across ≥2 operators', () => {
  const seeded = applyNetworkSeed(makeDataset());
  const { vehicles } = deriveEntities(seeded);
  const shared = vehicles.get(vehicleKey);
  assert.ok(shared, 'the shared vehicle entity exists');
  assert.equal(shared.operatorIds.size, 2, 'shared vehicle spans both operators');
});

test('is pure — returns a new array and never mutates the frozen inputs', () => {
  const input = makeDataset();
  const snapshot = input.map((l) => ({ ...l }));
  const seeded = applyNetworkSeed(input);
  assert.notEqual(seeded, input, 'a new array is returned');
  assert.equal(seeded.length, input.length, 'same length');
  // Originals are untouched: their supplier/vehicle still differ per operator.
  input.forEach((load, i) => {
    assert.equal(load.supplierPostcode, snapshot[i].supplierPostcode);
    assert.equal(load.carrierVehicleReg, snapshot[i].carrierVehicleReg);
  });
  // No natural overlap before seeding — proves the seed is what makes it span.
  const before = deriveEntities(input).suppliers;
  assert.equal([...before.values()].filter((e) => e.operatorIds.size > 1).length, 0);
});

test('preserves order and every non-seeded field on seeded loads', () => {
  const input = makeDataset();
  const seeded = applyNetworkSeed(input);
  seeded.forEach((load, i) => {
    assert.equal(load.operatorId, input[i].operatorId, 'operatorId preserved (order intact)');
    assert.equal(load.ewcCode, input[i].ewcCode, 'ewcCode untouched');
    assert.equal(load.descriptionWaste, input[i].descriptionWaste, 'description untouched');
    assert.equal(load.net, input[i].net, 'net weight untouched');
    assert.deepEqual(load.receivedForExport, input[i].receivedForExport, 'date round-trips');
    assert.ok(Object.isFrozen(load), 'seeded loads stay frozen');
  });
});

test('loadsPerOperator bounds how many loads per operator are seeded', () => {
  const seeded = applyNetworkSeed(makeDataset(), { loadsPerOperator: 2 });
  const shared = deriveEntities(seeded).suppliers.get(supplierKey);
  // 2 per operator × 2 operators = 4 (the 3rd load of each operator keeps its own).
  assert.equal(shared.loadIndexes.size, 4);
  assert.equal(shared.operatorIds.size, 2);
});

test('supplier:false / vehicle:false seed only the requested entity', () => {
  const onlyVehicle = applyNetworkSeed(makeDataset(), { supplier: false });
  const sv = deriveEntities(onlyVehicle);
  assert.ok(!sv.suppliers.get(supplierKey), 'supplier left untouched');
  assert.equal(sv.vehicles.get(vehicleKey).operatorIds.size, 2, 'vehicle still seeded');

  const onlySupplier = applyNetworkSeed(makeDataset(), { vehicle: false });
  const ss = deriveEntities(onlySupplier);
  assert.ok(!ss.vehicles.get(vehicleKey), 'vehicle left untouched');
  assert.equal(ss.suppliers.get(supplierKey).operatorIds.size, 2, 'supplier still seeded');
});

test('a single operator yields no false cross-operator span', () => {
  const oneOp = makeDataset().filter((l) => l.operatorId === 'OP-A');
  const shared = deriveEntities(applyNetworkSeed(oneOp)).suppliers.get(supplierKey);
  assert.ok(shared, 'shared supplier still created');
  assert.equal(shared.operatorIds.size, 1, 'but it spans only the one operator present');
});

test('empty / non-array input is handled safely', () => {
  assert.deepEqual(applyNetworkSeed([]), []);
  assert.deepEqual(applyNetworkSeed(null), []);
  assert.deepEqual(applyNetworkSeed(undefined), []);
});

test('exposes the seeded entity constants and defaults', () => {
  assert.equal(SHARED_SUPPLIER.postcode, 'LS1 4AB');
  assert.equal(SHARED_VEHICLE.reg, 'SH24RED');
  assert.equal(DEFAULTS.loadsPerOperator, 3);
});

// Integration: the done-when. The full fixtures do not overlap naturally, so
// `ingest(..., { seedNetwork: true })` is what gives the network detector a
// cross-operator entity to fire on. (Heavy — parses both 1,000-row sheets once.)
test('ingest with seedNetwork makes a supplier span ≥2 operators on the full fixtures', async () => {
  const dir = path.join(__dirname, '..', '..', 'fixtures');
  const files = [
    path.join(dir, 'exporter_E-ACC12245AL_E25SR500020912AL-b3c87758.xlsx'),
    path.join(dir, 'exporter_E-ACC12245FB_E25SR500020912FB.xlsx'),
  ];
  const { loads, entities } = await ingest(files, { seedNetwork: true });
  assert.equal(loads.length, 2000, 'all loads still present (seed re-points, never drops)');

  const crossOperatorSuppliers = [...entities.suppliers.values()]
    .filter((e) => e.operatorIds.size > 1);
  assert.ok(
    crossOperatorSuppliers.length >= 1,
    'at least one supplier identity appears under ≥2 distinct operatorIds (done-when)',
  );
  const shared = entities.suppliers.get(supplierKey);
  assert.ok(shared && shared.operatorIds.size === 2, 'the seeded shared supplier spans both');
  assert.equal(entities.vehicles.get(vehicleKey).operatorIds.size, 2, 'shared vehicle spans both');
});
