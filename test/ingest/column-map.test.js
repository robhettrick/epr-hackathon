'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  COLUMN_MAP,
  MACHINE_HEADERS,
  CANONICAL_FIELDS,
  toCanonicalRow,
} = require('../../src/ingest/column-map');
const { makeLoad } = require('../../src/model/load');

test('toCanonicalRow maps a sample machine-header row to canonical field names', () => {
  // A representative row keyed by template v5.1 machine headers (values taken
  // from the fixtures' Example row), plus two unmapped helper columns.
  const rawRow = {
    DATE_RECEIVED_FOR_EXPORT: '2025-05-28T00:00:00.000Z',
    EWC_CODE: '01 01 01',
    DESCRIPTION_WASTE: 'Plastic - PET bottles',
    GROSS_WEIGHT: 45,
    TARE_WEIGHT: 10,
    PALLET_WEIGHT: 5,
    NET_WEIGHT: 30,
    WEIGHT_OF_NON_TARGET_MATERIALS: 1.5,
    RECYCLABLE_PROPORTION_PERCENTAGE: 0.9,
    TONNAGE_RECEIVED_FOR_EXPORT: 22.46625,
    TONNAGE_OF_UK_PACKAGING_WASTE_EXPORTED: 22.47,
    TONNAGE_RECEIVED_BY_OSR: 5,
    TONNAGE_PASSED_INTERIM_SITE_RECEIVED_BY_OSR: 5,
    OSR_COUNTRY: 'Vietnam-VN',
    OSR_NAME: 'International ABC Waste Limited',
    WAS_THE_WASTE_REFUSED: 'No',
    SUPPLIER_NAME: 'Joe Blogs Refinery',
    SUPPLIER_POSTCODE: 'LA12 3CD',
    CARRIER_VEHICLE_REGISTRATION_NUMBER: 'FG25HIJ',
    // unmapped columns must be dropped, not carried through:
    ROW_ID: 999,
    __EPR_SKIP_COLUMN: null,
  };

  const canonical = toCanonicalRow(rawRow);

  assert.equal(canonical.receivedForExport, '2025-05-28T00:00:00.000Z');
  assert.equal(canonical.ewcCode, '01 01 01');
  assert.equal(canonical.descriptionWaste, 'Plastic - PET bottles');
  assert.equal(canonical.gross, 45);
  assert.equal(canonical.tare, 10);
  assert.equal(canonical.pallet, 5);
  assert.equal(canonical.net, 30);
  assert.equal(canonical.nonTargetWeight, 1.5);
  assert.equal(canonical.recyclableProportion, 0.9);
  assert.equal(canonical.tonnageReceivedForExport, 22.46625);
  assert.equal(canonical.tonnageExported, 22.47);
  assert.equal(canonical.tonnageReceivedByOsr, 5);
  assert.equal(canonical.interimHandling, 5);
  assert.equal(canonical.osrCountry, 'Vietnam-VN');
  assert.equal(canonical.osrName, 'International ABC Waste Limited');
  assert.equal(canonical.refused, 'No');
  assert.equal(canonical.supplierName, 'Joe Blogs Refinery');
  assert.equal(canonical.supplierPostcode, 'LA12 3CD');
  assert.equal(canonical.carrierVehicleReg, 'FG25HIJ');

  // unmapped headers dropped
  assert.ok(!('ROW_ID' in canonical));
  assert.ok(!('__EPR_SKIP_COLUMN' in canonical));
  assert.ok(!('999' in canonical));
});

test('the map covers every data-derived canonical Load field (and only those)', () => {
  // makeLoad() with no args yields the full canonical field set. The two
  // Cover-sheet-tagged fields are not read from a data column, so the column map
  // must cover exactly the rest — guards against the model gaining a data field
  // the map forgets, or the map mapping to a non-existent field.
  const COVER_TAGGED = ['operatorId', 'material'];
  const dataFields = Object.keys(makeLoad()).filter((k) => !COVER_TAGGED.includes(k));

  assert.deepEqual(new Set(CANONICAL_FIELDS), new Set(dataFields));
  assert.equal(CANONICAL_FIELDS.length, dataFields.length, 'no duplicate target fields');
});

test('the map excludes Cover-derived fields (operatorId, material)', () => {
  assert.ok(!CANONICAL_FIELDS.includes('operatorId'));
  assert.ok(!CANONICAL_FIELDS.includes('material'));
});

test('a canonical row from the map feeds makeLoad into a typed Load', () => {
  const load = makeLoad(
    toCanonicalRow({
      EWC_CODE: '15 01 04',
      DESCRIPTION_WASTE: 'AAIG aluminium cans (97.5%)',
      NET_WEIGHT: '253.7',
      RECYCLABLE_PROPORTION_PERCENTAGE: '0.8',
      OSR_COUNTRY: 'Germany',
      WAS_THE_WASTE_REFUSED: 'No',
      CARRIER_VEHICLE_REGISTRATION_NUMBER: 'AB12 CDE',
    }),
  );

  assert.equal(load.ewcCode, '15 01 04');
  assert.equal(load.net, 253.7); // coerced string → number by makeLoad
  assert.equal(load.recyclableProportion, 0.8);
  assert.equal(load.refused, false); // 'No' → boolean by makeLoad
  assert.equal(load.carrierVehicleReg, 'AB12 CDE');
  // fields absent from the input default to null, never throw
  assert.equal(load.supplierName, null);
  assert.ok(Object.isFrozen(load));
});

test('COLUMN_MAP and MACHINE_HEADERS are frozen reference data', () => {
  assert.ok(Object.isFrozen(COLUMN_MAP));
  assert.ok(Object.isFrozen(MACHINE_HEADERS));
  assert.equal(MACHINE_HEADERS.length, CANONICAL_FIELDS.length);
});
