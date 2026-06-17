'use strict';

/**
 * Live threshold re-render (golden-path step 6) — `GET /detectors/{id}?minScore=…`.
 *
 * The regulator tunes how many findings surface without any code change: the filter
 * form submits its thresholds as GET query params, the server overlays them onto the
 * engine's pure `triage` and re-renders the re-ranked/filtered list (ADR-009). These
 * tests drive the real wired server via `server.inject` and use `triage` itself as
 * the oracle, so they assert the route honours exactly the engine's surfacing —
 * independent of which fixture set boots — and that a changed param visibly changes
 * which findings appear.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { build } = require('../../src/web/server');
const { triage } = require('../../src/engine/triage');

const DETECTOR = 'ewc-not-packaging';

/** The finding ids rendered (in order) as detail links on the per-detector page. */
function renderedIds(payload, detectorId) {
  const re = new RegExp(`/detectors/${detectorId}/findings/([^"]+)"`, 'g');
  return [...payload.matchAll(re)].map((m) => m[1]);
}

describe('web: live threshold re-render (GET /detectors/{id} query params)', () => {
  let server;
  let result;

  before(async () => {
    ({ server, result } = await build());
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('renders a GET filter form with the three threshold controls', async () => {
    const res = await server.inject(`/detectors/${DETECTOR}`);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.payload, /<form[^>]*method="get"/);
    assert.match(res.payload, /name="minScore"/);
    assert.match(res.payload, /name="minSeverity"/);
    assert.match(res.payload, /name="limit"/);
  });

  test('a limit param caps the surfaced findings, keeping the top-ranked ones', async () => {
    const all = renderedIds((await server.inject(`/detectors/${DETECTOR}`)).payload, DETECTOR);
    assert.ok(all.length > 1, 'fixtures should produce multiple findings to cap');

    const res = await server.inject(`/detectors/${DETECTOR}?limit=1`);
    const capped = renderedIds(res.payload, DETECTOR);
    assert.strictEqual(capped.length, 1, 'limit=1 must surface exactly one finding');
    assert.deepStrictEqual(capped, all.slice(0, 1), 'the retained finding is the top-ranked one');
  });

  test('a minScore param filters/re-ranks exactly as the engine triage (oracle)', async () => {
    const res = await server.inject(`/detectors/${DETECTOR}?minScore=100`);
    const expected = triage(result.byDetector[DETECTOR], { minScore: '100' })
      .surfaced.map((f) => String(f.subject.id));
    assert.deepStrictEqual(renderedIds(res.payload, DETECTOR), expected);
  });

  test('raising minScore visibly drops lower-scoring findings (no code change)', async () => {
    const findings = result.byDetector[DETECTOR];
    const scores = findings.map((f) => f.score);
    const top = Math.max(...scores);
    // Only meaningful when the detector's scores actually vary; ewc-not-packaging
    // scores hazardous/off-list/non-packaging differently, so this holds on the
    // fixtures. Guarded so the test stays honest if a fixture ever flattens scores.
    if (Math.min(...scores) < top) {
      const res = await server.inject(`/detectors/${DETECTOR}?minScore=${top}`);
      const surfaced = renderedIds(res.payload, DETECTOR);
      const oracle = triage(findings, { minScore: String(top) }).surfacedCount;
      assert.strictEqual(surfaced.length, oracle);
      assert.ok(surfaced.length < findings.length,
        'a higher minScore must surface fewer findings than the unfiltered list');
    }
  });

  test('a minSeverity param gates by severity exactly as triage (oracle)', async () => {
    const res = await server.inject(`/detectors/${DETECTOR}?minSeverity=critical`);
    const expected = triage(result.byDetector[DETECTOR], { minSeverity: 'critical' })
      .surfaced.map((f) => String(f.subject.id));
    assert.deepStrictEqual(renderedIds(res.payload, DETECTOR), expected);
    // The applied severity is reflected back as the selected option.
    assert.match(res.payload, /value="critical"[^>]*selected/);
  });

  test('a malformed param degrades to no threshold (does not 500)', async () => {
    const res = await server.inject(`/detectors/${DETECTOR}?minScore=not-a-number`);
    assert.strictEqual(res.statusCode, 200);
    const rendered = renderedIds(res.payload, DETECTOR);
    const unfiltered = renderedIds((await server.inject(`/detectors/${DETECTOR}`)).payload, DETECTOR);
    assert.deepStrictEqual(rendered, unfiltered, 'a bad minScore must behave as no floor');
  });
});
