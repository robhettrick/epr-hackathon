'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeLoad, toNumber, toDate, toBool, toEwc, toText } = require('../../src/model/load');

test('makeLoad builds a fully typed Load from a raw canonical row', () => {
  const load = makeLoad({
    operatorId: 'E-ACC12245AL',
    material: 'Aluminium',
    receivedForExport: '2026-02-16',
    exported: new Date('2026-02-20T00:00:00Z'),
    receivedByOsr: '2026-03-01',
    ewcCode: '15 01 04',
    descriptionWaste: 'AAIG aluminium cans (97.5%)',
    gross: '367',
    tare: 10,
    pallet: '5',
    net: '253.7',
    nonTargetWeight: '1.2',
    recyclableProportion: 0.8,
    tonnageReceivedForExport: '253.7',
    tonnageExported: '4.7',
    tonnageReceivedByOsr: '1.9',
    interimSite: 'Yes',
    interimHandling: 'No',
    osrCountry: 'Germany',
    osrName: 'Rhein Metall Recycling',
    refused: 'No',
    supplierName: 'Acme Metals Ltd',
    supplierPostcode: 'M1 2AB',
    carrierVehicleReg: 'AB12 CDE',
  });

  // text / classification
  assert.equal(load.operatorId, 'E-ACC12245AL');
  assert.equal(load.material, 'Aluminium');
  assert.equal(load.ewcCode, '15 01 04');
  assert.equal(load.descriptionWaste, 'AAIG aluminium cans (97.5%)');
  assert.equal(load.osrCountry, 'Germany');
  assert.equal(load.supplierName, 'Acme Metals Ltd');

  // numerics are real numbers, not strings
  assert.equal(load.net, 253.7);
  assert.equal(typeof load.net, 'number');
  // recompute inputs (K/L/M/Q) used by arithmetic-integrity, coerced to numbers
  assert.equal(load.gross, 367);
  assert.equal(load.tare, 10);
  assert.equal(load.pallet, 5);
  assert.equal(load.nonTargetWeight, 1.2);
  assert.equal(load.recyclableProportion, 0.8);
  assert.equal(load.tonnageReceivedForExport, 253.7);
  assert.equal(load.tonnageExported, 4.7);
  assert.equal(load.tonnageReceivedByOsr, 1.9);

  // dates are Date instances
  assert.ok(load.receivedForExport instanceof Date);
  assert.equal(load.receivedForExport.getUTCFullYear(), 2026);
  assert.ok(load.exported instanceof Date);
  assert.ok(load.receivedByOsr instanceof Date);

  // booleans — the AA interim-site flag (Yes/No → boolean), distinct from the
  // AC interim tonnage in `interimHandling` (here the text "No").
  assert.equal(load.refused, false);
  assert.equal(load.interimSite, true);
  assert.equal(load.interimHandling, 'No');

  // immutable (detectors are pure — Loads must not be mutated)
  assert.ok(Object.isFrozen(load));
});

test('makeLoad coerces blanks/garbage to null and never throws', () => {
  const load = makeLoad({
    operatorId: '  ',
    net: '',
    recyclableProportion: 'n/a',
    tonnageExported: undefined,
    receivedForExport: 'not-a-date',
    refused: '',
  });

  assert.equal(load.operatorId, null);
  assert.equal(load.net, null);
  assert.equal(load.recyclableProportion, null);
  assert.equal(load.tonnageExported, null);
  assert.equal(load.receivedForExport, null);
  assert.equal(load.refused, null);
});

test('interimSite (AA flag) is independent of interimHandling (AC tonnage)', () => {
  // A load can be declared interim (AA = Yes) with no interim OSR tonnage (AC
  // blank) — the boolean flag captures what the tonnage proxy cannot.
  const interimNoTonnage = makeLoad({ interimSite: 'Yes', interimHandling: '' });
  assert.equal(interimNoTonnage.interimSite, true);
  assert.equal(interimNoTonnage.interimHandling, null);

  // Not declared interim, ambiguous/blank flag → null (never throws).
  const notInterim = makeLoad({ interimSite: 'No' });
  assert.equal(notInterim.interimSite, false);
  assert.equal(makeLoad({ interimSite: '' }).interimSite, null);
  assert.equal(makeLoad().interimSite, null);
});

test('makeLoad with no argument yields an all-null Load', () => {
  const load = makeLoad();
  assert.equal(load.operatorId, null);
  assert.equal(load.ewcCode, null);
  assert.equal(load.net, null);
  assert.equal(load.gross, null);
  assert.equal(load.tare, null);
  assert.equal(load.pallet, null);
  assert.equal(load.nonTargetWeight, null);
  assert.equal(load.exported, null);
});

test('toNumber tolerates thousands separators and rejects non-numerics', () => {
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber('  78  '), 78);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(true), null);
});

test('toEwc collapses whitespace and preserves the hazardous marker', () => {
  assert.equal(toEwc('15  01   04'), '15 01 04');
  assert.equal(toEwc(' 10 03 21* '), '10 03 21*');
  assert.equal(toEwc(''), null);
});

test('toBool maps Yes/No variants and leaves ambiguity null', () => {
  assert.equal(toBool('Yes'), true);
  assert.equal(toBool('no'), false);
  assert.equal(toBool(true), true);
  assert.equal(toBool('maybe'), null);
  assert.equal(toBool(''), null);
});

test('toDate parses strings, passes Dates, and rejects bare numbers', () => {
  assert.ok(toDate('2026-02-16') instanceof Date);
  const d = new Date('2026-01-01T00:00:00Z');
  assert.equal(toDate(d), d);
  assert.equal(toDate(45000), null);
  assert.equal(toDate('garbage'), null);
});

test('toText flattens exceljs rich/hyperlink/formula cell objects', () => {
  assert.equal(toText({ text: 'Germany', hyperlink: 'mailto:x' }), 'Germany');
  assert.equal(toText({ result: 78.2 }), '78.2');
  assert.equal(toText({ richText: [{ text: 'AAIG ' }, { text: 'cans' }] }), 'AAIG cans');
  assert.equal(toText({}), null);
});
