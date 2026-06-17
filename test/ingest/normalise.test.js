'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseFile } = require('../../src/ingest/parser');
const { normalise } = require('../../src/ingest/normalise');

const AL_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'exporter_E-ACC12245AL_E25SR500020912AL-b3c87758.xlsx',
);

// The headline behaviour of this item: parsed AL rows → Load[] with operatorId
// set on every load. Parse the real fixture once and share across assertions.
let parsed;
let result;
test('normalise the AL fixture (setup)', async () => {
  parsed = await parseFile(AL_FIXTURE);
  result = normalise(parsed);
  assert.ok(result, 'normalise returned a result');
});

test('produces one canonical Load per parsed row', () => {
  assert.equal(result.loads.length, parsed.rows.length);
  assert.equal(result.loads.length, 1000);
});

test('every load is tagged with the file operatorId and material from Cover', () => {
  for (const load of result.loads) {
    assert.equal(load.operatorId, 'E-ACC12245AL');
    assert.equal(load.material, 'Aluminium');
  }
});

test('loads are typed and frozen (column map + makeLoad applied)', () => {
  const first = result.loads[0];
  assert.equal(first.ewcCode, '02 06 03');
  assert.equal(typeof first.net, 'number');
  assert.ok(first.receivedForExport instanceof Date);
  assert.ok(Object.isFrozen(first));
});

test('parser warnings are carried through unchanged (clean fixture → none)', () => {
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
});

test('Cover provenance wins over any same-named data column', () => {
  // Even if a row carried its own operatorId/material, the submission-level
  // Cover identity must be authoritative for cross-operator detection.
  const { loads } = normalise({
    cover: { operatorId: 'E-ACC9999XX', material: 'Glass' },
    rows: [{ EWC_CODE: '15 01 07', SUPPLIER_NAME: 'Acme Ltd' }],
  });
  assert.equal(loads.length, 1);
  assert.equal(loads[0].operatorId, 'E-ACC9999XX');
  assert.equal(loads[0].material, 'Glass');
  assert.equal(loads[0].ewcCode, '15 01 07');
  assert.equal(loads[0].supplierName, 'Acme Ltd');
});

test('a missing Cover operatorId/material degrades to null, never throws', () => {
  const { loads } = normalise({ rows: [{ EWC_CODE: '20 03 01' }] });
  assert.equal(loads.length, 1);
  assert.equal(loads[0].operatorId, null);
  assert.equal(loads[0].material, null);
  assert.equal(loads[0].ewcCode, '20 03 01');
});

test('empty / missing input yields an empty Load list', () => {
  assert.deepEqual(normalise().loads, []);
  assert.deepEqual(normalise({}).loads, []);
  assert.deepEqual(normalise({ rows: [] }).loads, []);
});
