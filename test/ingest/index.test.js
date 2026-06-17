'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ingest } = require('../../src/ingest/index');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');
const AL_FIXTURE = path.join(FIXTURES, 'exporter_E-ACC12245AL_E25SR500020912AL-b3c87758.xlsx');
const FB_FIXTURE = path.join(FIXTURES, 'exporter_E-ACC12245FB_E25SR500020912FB.xlsx');

// Ingesting both real fixtures is the heart of this item (golden-path step 1):
// it must concatenate loads across files, span operators in the entities, and
// merge the reference lists. Do the (slow) ingest once and share the result.
let result;
test('ingest both fixtures (setup)', async () => {
  result = await ingest([AL_FIXTURE, FB_FIXTURE]);
  assert.ok(result, 'ingest returned a result');
});

test('returns the golden-path dataset shape', () => {
  assert.ok(Array.isArray(result.loads), 'loads is an array');
  assert.ok(result.entities && typeof result.entities === 'object', 'entities present');
  assert.ok(Array.isArray(result.reference.allowedEwc), 'reference.allowedEwc is an array');
  assert.ok(Array.isArray(result.warnings), 'warnings is an array');
});

test('loads from two distinct operators are concatenated', () => {
  // ~1000 real loads per fixture (see parser.test.js).
  assert.equal(result.loads.length, 2000);
  const operatorIds = new Set(result.loads.map((l) => l.operatorId));
  assert.deepEqual([...operatorIds].sort(), ['E-ACC12245AL', 'E-ACC12245FB']);
  // Every load is tagged with its file's operator — nothing slips through untagged.
  assert.ok(result.loads.every((l) => l.operatorId != null), 'every load has an operatorId');
});

test('entities span both operators', () => {
  // Both submissions derive their own operator entity → two distinct operators.
  assert.equal(result.entities.operators.size, 2);
  for (const id of ['e-acc12245al', 'e-acc12245fb']) {
    assert.ok(result.entities.operators.has(id), `operator ${id} derived`);
  }
  // The other entity types are populated from loads across both files.
  for (const k of ['suppliers', 'osrs', 'countries']) {
    assert.ok(result.entities[k] instanceof Map && result.entities[k].size > 0, `${k} non-empty`);
  }
  // A derived load index reaches into the concatenated array (across both files).
  const maxIndex = Math.max(
    ...[...result.entities.operators.values()].flatMap((e) => [...e.loadIndexes]),
  );
  assert.ok(maxIndex >= 1000, 'entity back-refs index into the second file too');
});

test('reference lists are merged (shared Sheet1 → de-duplicated union)', () => {
  // Both fixtures carry the same template Sheet1, so the union stays 842 / 41.
  assert.equal(result.reference.allowedEwc.length, 842);
  assert.equal(result.reference.allowedMaterials.length, 41);
  assert.ok(result.reference.allowedEwc.includes('15 01 04'));
  assert.equal(new Set(result.reference.allowedEwc).size, result.reference.allowedEwc.length, 'no dupes');
});

test('clean fixtures ingest with no warnings', () => {
  assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
});

test('a single string path is tolerated', async () => {
  const one = await ingest(AL_FIXTURE);
  assert.equal(one.loads.length, 1000);
  assert.equal(one.entities.operators.size, 1);
});

test('an unreadable file becomes a warning, never a crash (partial data is fine)', async () => {
  const missing = path.join(FIXTURES, 'does-not-exist.xlsx');
  const partial = await ingest([AL_FIXTURE, missing]);
  // The good file still ingests fully; the bad file contributes a tagged warning.
  assert.equal(partial.loads.length, 1000);
  const fileWarnings = partial.warnings.filter((w) => w.scope === 'file');
  assert.equal(fileWarnings.length, 1);
  assert.equal(fileWarnings[0].file, missing);
});

test('no files supplied → empty dataset with a warning, not a throw', async () => {
  const empty = await ingest([]);
  assert.equal(empty.loads.length, 0);
  assert.equal(empty.entities.operators.size, 0);
  assert.ok(empty.warnings.some((w) => w.scope === 'ingest'));
});
