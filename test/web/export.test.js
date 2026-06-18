'use strict';

/**
 * Flagged-cases CSV export (PRD §11 stretch) — `GET /export.csv` and
 * `GET /detectors/{id}/export.csv`.
 *
 * Drives the real wired server via `server.inject` against the fixtures, so this
 * exercises the actual boot path (detectors self-register, both fixtures ingest,
 * the engine runs once) and the export over that in-memory read model (ADR-002,
 * DB-free). The export must (a) be a well-formed downloadable CSV, (b) cover
 * exactly the surfaced findings — shadow detectors excluded (ADR-008) — and
 * (c) honour the same triage thresholds as the on-screen list.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { build } = require('../../src/web/server');
const { triage } = require('../../src/engine/triage');
const { toCsv } = require('../../src/web/csv');
const {
  buildExportRows,
  buildDetectorExportRows,
  FINDING_CSV_COLUMNS,
} = require('../../src/web/routes');

describe('web: flagged-cases CSV export', () => {
  let server;
  let result;

  before(async () => {
    ({ server, result } = await build());
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('GET /export.csv is a downloadable text/csv attachment', async () => {
    const res = await server.inject('/export.csv');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="flagged-cases\.csv"/);
  });

  test('GET /export.csv body equals toCsv over the export-row builder (route is a thin render)', async () => {
    const res = await server.inject('/export.csv');
    const expected = toCsv(FINDING_CSV_COLUMNS, buildExportRows(result, {}));
    assert.strictEqual(res.payload, expected);
  });

  test('the header row is the column spec', async () => {
    const res = await server.inject('/export.csv');
    const header = res.payload.split('\r\n')[0];
    assert.strictEqual(header, FINDING_CSV_COLUMNS.map((c) => c.header).join(','));
  });

  test('covers exactly every surfaced detector\'s surfaced findings (shadow excluded)', () => {
    const surfaced = result.detectors.filter((d) => d.surfaced);
    const expectedCount = surfaced.reduce(
      (total, d) => total + triage(result.byDetector[d.id] || []).surfaced.length,
      0,
    );
    const rows = buildExportRows(result, {});
    assert.strictEqual(rows.length, expectedCount);

    // Every exported row belongs to a surfaced detector — a shadow detector's
    // findings must never leak into the export (ADR-008).
    const surfacedIds = new Set(surfaced.map((d) => d.id));
    assert.ok(rows.every((r) => surfacedIds.has(r.detectorId)));
  });

  test('exported rows carry the audit stamp (reason + reproducibility metadata)', () => {
    const rows = buildExportRows(result, {});
    assert.ok(rows.length > 0, 'fixtures should produce flagged cases');
    for (const row of rows) {
      assert.ok(row.reason, 'every finding carries an explainer reason');
      assert.ok(row.snapshotId, 'every finding carries its dataset snapshot id (ADR-008)');
      assert.ok(row.detectorVersion, 'every finding carries its detector version');
    }
  });

  test('?minScore filters the export uniformly (same triage seam as the list)', () => {
    const all = buildExportRows(result, {});
    const filtered = buildExportRows(result, { minScore: 100 });
    assert.ok(filtered.length < all.length, 'a high score floor should drop some rows');
    assert.ok(filtered.every((r) => r.score >= 100));
  });

  test('GET /detectors/{id}/export.csv exports just that detector, ranked', async () => {
    const res = await server.inject('/detectors/ewc-not-packaging/export.csv');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-disposition'], /filename="ewc-not-packaging-findings\.csv"/);

    const rows = buildDetectorExportRows(result, 'ewc-not-packaging', {});
    const ranked = triage(result.byDetector['ewc-not-packaging']).surfaced;
    assert.strictEqual(rows.length, ranked.length);
    assert.deepStrictEqual(
      rows.map((r) => String(r.subjectId)),
      ranked.map((f) => String(f.subject.id)),
      'rows are in triage (score-desc) order',
    );
    assert.ok(rows.every((r) => r.detectorId === 'ewc-not-packaging'));
  });

  test('per-detector export honours the threshold query (limit caps the rows)', async () => {
    const res = await server.inject('/detectors/ewc-not-packaging/export.csv?limit=1');
    // header line + exactly one data line + trailing CRLF → 3 segments on split.
    const dataLines = res.payload.split('\r\n').slice(1).filter((l) => l !== '');
    assert.strictEqual(dataLines.length, 1);
  });

  test('an unknown detector export answers 404', async () => {
    const res = await server.inject('/detectors/does-not-exist/export.csv');
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(buildDetectorExportRows(result, 'does-not-exist', {}), null);
  });

  test('the download links are offered in the UI', async () => {
    const list = await server.inject('/detectors');
    assert.match(list.payload, /href="\/export\.csv"/);
    const detector = await server.inject('/detectors/ewc-not-packaging');
    assert.match(detector.payload, /href="\/detectors\/ewc-not-packaging\/export\.csv/);
  });
});
