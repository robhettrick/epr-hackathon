'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseFile, readCell, PLACEHOLDER } = require('../../src/ingest/parser');
const { toCanonicalRow } = require('../../src/ingest/column-map');
const { makeLoad } = require('../../src/model/load');

const AL_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'exporter_E-ACC12245AL_E25SR500020912AL-b3c87758.xlsx',
);

// The curated demo fixture mirrors the template but omits the optional AA
// interim-site column — used to prove its absence is silent (no header warning).
const DEMO_AL_FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'demo', 'demo_exporter_AL.xlsx');

// Parsing the real fixture is the heart of this item; do it once and share.
let parsed;
test('parse the AL fixture (setup)', async () => {
  parsed = await parseFile(AL_FIXTURE);
  assert.ok(parsed, 'parseFile returned a result');
});

test('yields the real loads only — template/placeholder rows are filtered out', () => {
  // The sheet has ~15k pre-formatted blank rows below the 1000 real loads; only
  // the real ones must come through.
  assert.equal(parsed.rows.length, 1000);
  // No "Choose option" dropdown placeholder ever leaks into a row value.
  for (const row of parsed.rows) {
    for (const value of Object.values(row)) {
      assert.notEqual(value, PLACEHOLDER);
    }
  }
});

test('rows are keyed by machine header with typed cell values', () => {
  const first = parsed.rows[0];
  assert.equal(first.EWC_CODE, '02 06 03');
  assert.ok(first.DATE_RECEIVED_FOR_EXPORT instanceof Date, 'date cell preserved as Date');
  assert.equal(typeof first.NET_WEIGHT, 'number', 'numeric cell preserved as number');
  assert.equal(typeof first.SUPPLIER_NAME, 'string');
});

test('reference lists come from Sheet1 (placeholder stripped)', () => {
  // Matches reference/allowed-codes.json (842 EWC, 41 materials) generated from
  // the same Sheet1.
  assert.equal(parsed.reference.allowedEwc.length, 842);
  assert.equal(parsed.reference.allowedMaterials.length, 41);
  assert.ok(parsed.reference.allowedEwc.includes('01 01 01'));
  assert.ok(parsed.reference.allowedEwc.includes('15 01 04'));
  assert.ok(parsed.reference.allowedMaterials.includes('Aluminium - other'));
  assert.ok(!parsed.reference.allowedEwc.includes(PLACEHOLDER));
  assert.ok(!parsed.reference.allowedMaterials.includes(PLACEHOLDER));
});

test('cover metadata yields a non-null operatorId and material', () => {
  assert.equal(parsed.cover.operatorId, 'E-ACC12245AL');
  assert.equal(parsed.cover.accreditationNumber, 'E-ACC12245AL');
  assert.equal(parsed.cover.registrationNumber, 'E25SR500020912AL');
  assert.equal(parsed.cover.material, 'Aluminium');
});

test('a parsed row feeds the column map + makeLoad into a typed Load', () => {
  const load = makeLoad(toCanonicalRow(parsed.rows[0]));
  assert.equal(load.ewcCode, '02 06 03');
  assert.equal(typeof load.net, 'number');
  assert.ok(load.receivedForExport instanceof Date);
  assert.ok(Object.isFrozen(load));
});

test('warnings are collected as an array (clean fixture → none)', () => {
  assert.ok(Array.isArray(parsed.warnings));
  assert.equal(parsed.warnings.length, 0, JSON.stringify(parsed.warnings));
});

test('the AA interim-site flag is parsed and maps to a boolean interimSite', () => {
  // The full template carries DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE (AA); every
  // real row should set it, and it round-trips through the map into a boolean.
  const withFlag = parsed.rows.filter((r) => 'DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE' in r);
  assert.ok(withFlag.length > 0, 'fixture carries the AA interim-site column');
  const load = makeLoad(toCanonicalRow(withFlag[0]));
  assert.equal(typeof load.interimSite, 'boolean');
});

test('a fixture missing the optional AA header parses without a header warning', async () => {
  // The curated demo set omits AA; its absence must stay silent (the missing-
  // header warning is reserved for required columns) — see fixtures/demo/README.md.
  const demo = await parseFile(DEMO_AL_FIXTURE);
  const headerWarnings = demo.warnings.filter((w) => w.scope === 'header');
  assert.deepEqual(headerWarnings, [], JSON.stringify(demo.warnings));
  // ...and a load from that fixture simply carries interimSite = null (no column).
  assert.equal(makeLoad(toCanonicalRow(demo.rows[0])).interimSite, null);
});

test('readCell normalises placeholders, empty formulas and blanks to null', () => {
  assert.equal(readCell(null), null);
  assert.equal(readCell({ value: '   ' }), null);
  assert.equal(readCell({ value: PLACEHOLDER }), null);
  assert.equal(readCell({ value: { formula: 'IFERROR(A1,"")' } }), null); // no cached result
  assert.equal(readCell({ value: { formula: 'A1', result: 42 } }), 42);
  assert.equal(readCell({ value: { error: '#N/A' } }), null);
  assert.equal(readCell({ value: { richText: [{ text: 'Acme' }, { text: ' Ltd' }] } }), 'Acme Ltd');
  assert.equal(readCell({ value: 12.5 }), 12.5);
  const d = new Date('2026-02-16T00:00:00.000Z');
  assert.equal(readCell({ value: d }), d);
});
