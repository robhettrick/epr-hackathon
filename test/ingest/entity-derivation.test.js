'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeLoad } = require('../../src/model/load');
const { identityKey } = require('../../src/model/entity');
const { deriveEntities } = require('../../src/ingest/entity-derivation');

// A small, hand-crafted Load array exercising dedup, cosmetic-variant merging,
// cross-operator accumulation, and postcode-vs-name keying. Built through
// `makeLoad` so the fields are typed exactly as ingest produces them.
const LOADS = [
  makeLoad({
    operatorId: 'OP-A',
    supplierName: 'Acme Ltd',
    supplierPostcode: 'AB1 2CD',
    osrName: 'Reprocessor One',
    osrCountry: 'Germany',
    carrierVehicleReg: 'AB12 CDE',
  }),
  makeLoad({
    // same supplier (cosmetic name variant + same postcode) under the SAME operator
    operatorId: 'OP-A',
    supplierName: '  acme   ltd ',
    supplierPostcode: 'AB1 2CD',
    osrName: 'Reprocessor One',
    osrCountry: 'germany', // case variant of the same country
    carrierVehicleReg: 'AB12 CDE',
  }),
  makeLoad({
    // same supplier postcode under a DIFFERENT operator → spans two operators
    operatorId: 'OP-B',
    supplierName: 'Acme Limited', // different free text, same postcode → still merges
    supplierPostcode: 'ab1 2cd',
    osrName: 'Reprocessor Two',
    osrCountry: 'Turkey',
    carrierVehicleReg: null, // no vehicle on this load
  }),
];

test('derives one Map per entity type', () => {
  const e = deriveEntities(LOADS);
  for (const k of ['operators', 'suppliers', 'osrs', 'vehicles', 'countries']) {
    assert.ok(e[k] instanceof Map, `${k} is a Map`);
  }
});

test('suppliers dedup by identity key (postcode preferred, cosmetic variants merge)', () => {
  const { suppliers } = deriveEntities(LOADS);
  // All three loads share postcode "AB1 2CD" (modulo case/space) → one supplier.
  assert.equal(suppliers.size, 1);
  const supplier = suppliers.get(identityKey('AB1 2CD'));
  assert.ok(supplier, 'supplier keyed on normalised postcode');
  assert.equal(supplier.type, 'supplier');
  assert.equal(supplier.label, 'Acme Ltd'); // first-seen name wins as display label
});

test('countries dedup by identity key (case-insensitive)', () => {
  const { countries } = deriveEntities(LOADS);
  // Germany (×2, one lower-cased) + Turkey → two distinct countries.
  assert.equal(countries.size, 2);
  assert.ok(countries.has(identityKey('Germany')));
  assert.ok(countries.has(identityKey('Turkey')));
});

test('back-refs record contributing load indexes', () => {
  const { suppliers, countries } = deriveEntities(LOADS);
  const supplier = suppliers.get(identityKey('AB1 2CD'));
  assert.deepEqual([...supplier.loadIndexes].sort(), [0, 1, 2]);
  const germany = countries.get(identityKey('Germany'));
  assert.deepEqual([...germany.loadIndexes].sort(), [0, 1]);
});

test('operatorIds accumulate across files (the network-detector signal)', () => {
  const { suppliers } = deriveEntities(LOADS);
  const supplier = suppliers.get(identityKey('AB1 2CD'));
  // Same supplier identity appears under OP-A and OP-B → spans two operators.
  assert.deepEqual([...supplier.operatorIds].sort(), ['OP-A', 'OP-B']);
});

test('operators, OSRs and vehicles are derived and deduped', () => {
  const e = deriveEntities(LOADS);
  assert.deepEqual([...e.operators.keys()].sort(), [identityKey('OP-A'), identityKey('OP-B')].sort());
  assert.equal(e.osrs.size, 2); // Reprocessor One (×2) + Reprocessor Two
  assert.equal(e.vehicles.size, 1); // one reg, shared on two loads; third load has none
  const vehicle = e.vehicles.get(identityKey('AB12 CDE'));
  assert.deepEqual([...vehicle.loadIndexes].sort(), [0, 1]);
});

test('supplier falls back to name when no postcode is present', () => {
  const loads = [
    makeLoad({ operatorId: 'OP-A', supplierName: 'No Postcode Co', supplierPostcode: null }),
    makeLoad({ operatorId: 'OP-A', supplierName: 'no postcode co' }),
  ];
  const { suppliers } = deriveEntities(loads);
  assert.equal(suppliers.size, 1);
  const supplier = suppliers.get(identityKey('No Postcode Co'));
  assert.ok(supplier);
  assert.equal(supplier.label, 'No Postcode Co');
});

test('a field with nothing to key on contributes no entity, never throws', () => {
  const loads = [
    // no supplier, no osr, no vehicle, no country — only an operator
    makeLoad({ operatorId: 'OP-A' }),
  ];
  const e = deriveEntities(loads);
  assert.equal(e.operators.size, 1);
  assert.equal(e.suppliers.size, 0);
  assert.equal(e.osrs.size, 0);
  assert.equal(e.vehicles.size, 0);
  assert.equal(e.countries.size, 0);
});

test('a missing operatorId is not counted in operatorIds, and mints no operator', () => {
  const loads = [makeLoad({ operatorId: null, osrCountry: 'Spain' })];
  const e = deriveEntities(loads);
  assert.equal(e.operators.size, 0);
  const spain = e.countries.get(identityKey('Spain'));
  assert.equal(spain.operatorIds.size, 0);
  assert.deepEqual([...spain.loadIndexes], [0]);
});

test('empty / non-array input yields empty entity Maps', () => {
  for (const bad of [undefined, [], null, 'nope']) {
    const e = deriveEntities(bad);
    assert.equal(e.suppliers.size, 0);
    assert.equal(e.countries.size, 0);
  }
});
