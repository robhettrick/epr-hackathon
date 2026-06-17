'use strict';

/**
 * Detector list view (golden-path step 4) — `GET /detectors`.
 *
 * Drives the real wired server via `server.inject` (no port bind) against the
 * fixtures, so this exercises the actual boot path: detectors self-register,
 * both fixtures ingest, the engine runs once, and the list view renders from that
 * in-memory read model (ADR-002, DB-free). The done-when is the regulator's entry
 * point: every surfaced detector shown with a *non-zero* finding count and a link
 * into its own ranked list.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { build } = require('../../src/web/server');

describe('web: detector list view (GET /detectors)', () => {
  let server;
  let result;

  before(async () => {
    ({ server, result } = await build());
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('returns a 200 govuk-styled page', async () => {
    const res = await server.inject('/detectors');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.payload, /govuk-template/); // base layout rendered
    assert.match(res.payload, /<h1[^>]*>\s*Detectors\s*<\/h1>/);
  });

  test('lists each surfaced detector with a link to its per-detector list', async () => {
    const res = await server.inject('/detectors');
    const surfaced = result.detectors.filter((d) => d.surfaced);
    assert.ok(surfaced.length >= 2, 'fixtures should surface the two implemented detectors');

    for (const d of surfaced) {
      assert.match(res.payload, new RegExp(d.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `detector "${d.title}" should appear in the list`);
      assert.match(res.payload, new RegExp(`href="/detectors/${d.id}"`),
        `detector "${d.id}" should link to its per-detector list`);
    }
  });

  test('shows a non-zero finding count for the two implemented detectors', async () => {
    const res = await server.inject('/detectors');

    for (const id of ['ewc-not-packaging', 'chain-mass-balance']) {
      const count = (result.byDetector[id] || []).length;
      assert.ok(count > 0, `${id} should produce findings on the fixtures`);
      assert.match(res.payload, new RegExp(String(count)),
        `the count ${count} for ${id} should be rendered`);
    }
  });

  test('excludes shadow detectors from the list (ADR-008)', async () => {
    const res = await server.inject('/detectors');
    const shadow = result.detectors.filter((d) => !d.surfaced);
    for (const d of shadow) {
      assert.doesNotMatch(res.payload, new RegExp(`href="/detectors/${d.id}"`),
        `shadow detector "${d.id}" must not surface in the list`);
    }
  });
});
