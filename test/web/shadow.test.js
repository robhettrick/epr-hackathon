'use strict';

/**
 * Honour the `shadow` flag end-to-end (ADR-008, IMPLEMENTATION_PLAN item H).
 *
 * A shadow detector must RUN (and be logged) but never surface in the web
 * UI/counts; promotion to live is a one-line `shadow:false` edit with no change to
 * the engine/triage/web layers. The sibling `detectors.test.js` only proves the
 * *absence* loop holds when there are no shadow detectors (vacuous on the real
 * set — nothing in `src/detectors/` ships `shadow:true`). This test INJECTS a real
 * shadow detector before boot so the run-but-hidden contract is exercised against
 * the actual wired server (`server.inject`, DB-free) — the item's done-when: "a
 * detector marked `shadow:true` runs in tests but is absent from the detector list
 * view."
 *
 * The detector is registered through the same generic `register()` seam the real
 * detectors use, so the engine/web layers special-case nothing — the only thing
 * that hides it is the `shadow` flag flowing through `surfaced`.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { register, clear } = require('../../src/detectors/registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');
const { buildSummary } = require('../../src/web/routes');
const { build } = require('../../src/web/server');

const SHADOW_ID = 'test-shadow-only';

// A shadow detector that always emits one finding for the first load, so we can
// prove it RAN (non-empty list) yet still stays out of every surfaced view/count.
const ShadowDetector = {
  meta: {
    id: SHADOW_ID,
    title: 'Shadow Only Detector',
    scope: SUBJECT_TYPE.LOAD,
    version: '1.0.0',
    shadow: true,
  },
  evaluate(data) {
    const loads = data && Array.isArray(data.loads) ? data.loads : [];
    if (loads.length === 0) return [];
    return [
      makeFinding({
        detectorId: SHADOW_ID,
        version: '1.0.0',
        subject: { type: SUBJECT_TYPE.LOAD, id: 0, label: 'Shadow load #0' },
        score: 100,
        severity: SEVERITY.CRITICAL,
        reason: 'shadow finding',
        evidence: { shadow: true },
      }),
    ];
  },
};

describe('web: shadow flag honoured end-to-end (ADR-008)', () => {
  let server;
  let data;
  let result;

  before(async () => {
    // Register the shadow detector BEFORE build() scans the real detectors, so it
    // joins the run via the same path — no engine/web special-casing.
    register(ShadowDetector);
    ({ server, data, result } = await build());
  });

  after(async () => {
    if (server) await server.stop();
    // The registry is process-wide singleton state; clear so this dummy can't bleed
    // into a sibling test file sharing the worker (node --test isolates files, but
    // be defensive — the real detectors re-register on the next build()).
    clear();
  });

  test('the shadow detector RAN: it has a run record and produced findings', () => {
    const rec = result.detectors.find((d) => d.id === SHADOW_ID);
    assert.ok(rec, 'shadow detector should appear in the engine run record');
    assert.equal(rec.shadow, true);
    assert.equal(rec.surfaced, false, 'shadow detector is marked not-surfaced');
    assert.ok(
      (result.byDetector[SHADOW_ID] || []).length >= 1,
      'shadow detector still evaluates and emits findings',
    );
  });

  test('it is ABSENT from the detector list view (the done-when)', async () => {
    const res = await server.inject('/detectors');
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.payload, new RegExp(SHADOW_ID), 'shadow id must not appear in the list');
    assert.doesNotMatch(res.payload, /Shadow Only Detector/, 'shadow title must not appear');
    // The real surfaced detectors are still listed — exclusion is scoped to shadow.
    assert.match(res.payload, /href="\/detectors\/ewc-not-packaging"/);
  });

  test('its findings are NOT counted in the overview totals', () => {
    const summary = buildSummary(data, result);
    const surfaced = result.detectors.filter((d) => d.surfaced);
    const shadowCount = (result.byDetector[SHADOW_ID] || []).length;
    const allFindings = result.detectors.reduce((t, d) => t + d.count, 0);

    assert.equal(summary.detectors, surfaced.length, 'detector count excludes the shadow detector');
    assert.equal(
      summary.findings,
      allFindings - shadowCount,
      'findings total excludes the shadow detector’s findings',
    );
    assert.ok(shadowCount >= 1, 'sanity: the shadow detector did contribute findings to exclude');
  });

  test('its per-detector and finding routes 404 (not surfaced)', async () => {
    const list = await server.inject(`/detectors/${SHADOW_ID}`);
    assert.equal(list.statusCode, 404, 'a shadow detector’s ranked-list route is not reachable');
    const finding = await server.inject(`/detectors/${SHADOW_ID}/findings/0`);
    assert.equal(finding.statusCode, 404, 'a shadow detector’s finding detail is not reachable');
  });
});
