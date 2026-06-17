'use strict';

/**
 * Per-detector findings list view (golden-path steps 3–4) — `GET /detectors/{id}`.
 *
 * Drives the real wired server via `server.inject` against the fixtures, so this
 * exercises the actual boot path: detectors self-register, both fixtures ingest,
 * the engine runs once, and the per-detector view renders that detector's findings
 * from the in-memory read model (ADR-002, DB-free). The done-when is the regulator
 * opening a detector and seeing a ranked list with the top hit first, each finding
 * linking to its detail page.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { build } = require('../../src/web/server');
const { triage } = require('../../src/engine/triage');

describe('web: per-detector findings list (GET /detectors/{id})', () => {
  let server;
  let result;

  before(async () => {
    ({ server, result } = await build());
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('returns a 200 govuk-styled page titled with the detector', async () => {
    const res = await server.inject('/detectors/ewc-not-packaging');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.payload, /govuk-template/); // base layout rendered
    // The detector's own title heads the page.
    const record = result.detectors.find((d) => d.id === 'ewc-not-packaging');
    assert.match(res.payload, new RegExp(`<h1[^>]*>\\s*${record.title}\\s*</h1>`));
  });

  test('renders findings ranked highest score first, each linking to detail', async () => {
    const res = await server.inject('/detectors/ewc-not-packaging');

    // The expected ranked order is exactly the engine's triage of this detector's
    // findings (score desc). The rendered detail links must appear in that order.
    const ranked = triage(result.byDetector['ewc-not-packaging']).surfaced;
    const expectedIds = ranked.map((f) => String(f.subject.id));
    assert.ok(expectedIds.length > 1, 'fixtures should produce multiple findings to rank');

    const renderedIds = [...res.payload.matchAll(
      /\/detectors\/ewc-not-packaging\/findings\/([^"]+)"/g,
    )].map((m) => m[1]);

    assert.deepStrictEqual(renderedIds, expectedIds,
      'rendered findings must be in score-desc order, each linking to its detail page');
  });

  test('shows the severity as a coloured govuk tag (critical → red)', async () => {
    const res = await server.inject('/detectors/ewc-not-packaging');
    // ewc-not-packaging flags hazardous codes as critical on the fixtures.
    const hasCritical = result.byDetector['ewc-not-packaging']
      .some((f) => f.severity === 'critical');
    assert.ok(hasCritical, 'fixtures should include a critical (hazardous) finding');
    assert.match(res.payload, /govuk-tag govuk-tag--red/);
  });

  test('the second implemented detector also renders its ranked list', async () => {
    const res = await server.inject('/detectors/chain-mass-balance');
    assert.strictEqual(res.statusCode, 200);
    const renderedIds = [...res.payload.matchAll(
      /\/detectors\/chain-mass-balance\/findings\/([^"]+)"/g,
    )];
    assert.ok(renderedIds.length > 0, 'chain-mass-balance should render its findings');
  });

  test('an unknown detector id answers 404 (not a 500)', async () => {
    const res = await server.inject('/detectors/does-not-exist');
    assert.strictEqual(res.statusCode, 404);
  });
});
