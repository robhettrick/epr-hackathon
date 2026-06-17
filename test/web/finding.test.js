'use strict';

/**
 * Finding detail view (golden-path step 5) — `GET /detectors/{id}/findings/{findingId}`.
 *
 * Drives the real wired server via `server.inject` against the fixtures, so this
 * exercises the actual boot path (detectors self-register, both fixtures ingest, the
 * engine runs once) and renders a real finding's detail from the in-memory read model
 * (ADR-002, DB-free). The done-when is a finding detail page rendering the reason +
 * the evidence object (the figures that tripped it) + the thresholds used.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { build } = require('../../src/web/server');
const { triage } = require('../../src/engine/triage');

describe('web: finding detail (GET /detectors/{id}/findings/{findingId})', () => {
  let server;
  let result;

  before(async () => {
    ({ server, result } = await build());
  });

  after(async () => {
    if (server) await server.stop();
  });

  // The top-ranked ewc finding — what a regulator clicks first from the list.
  function topEwcFinding() {
    return triage(result.byDetector['ewc-not-packaging']).surfaced[0];
  }

  test('renders a 200 govuk page with the reason for a real fixture finding', async () => {
    const finding = topEwcFinding();
    const res = await server.inject(
      `/detectors/ewc-not-packaging/findings/${encodeURIComponent(finding.subject.id)}`,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.payload, /govuk-template/); // base layout rendered
    // The plain-English reason (the explain-layer stub) is shown verbatim.
    assert.ok(finding.reason, 'fixture finding should carry a reason');
    assert.ok(res.payload.includes(finding.reason), 'the reason must render on the page');
  });

  test('renders the evidence object — the figures that tripped the detector', async () => {
    const finding = topEwcFinding();
    const res = await server.inject(
      `/detectors/ewc-not-packaging/findings/${encodeURIComponent(finding.subject.id)}`,
    );

    // Every evidence key/value appears on the page (ewc evidence: ewcCode, material,
    // category). The detail view renders any evidence shape generically.
    for (const [key, value] of Object.entries(finding.evidence)) {
      assert.ok(res.payload.includes(key), `evidence key "${key}" must render`);
      if (value !== null && value !== undefined) {
        assert.ok(res.payload.includes(String(value)), `evidence value "${value}" must render`);
      }
    }
  });

  test('renders the thresholdsUsed echo and the severity tag', async () => {
    const finding = topEwcFinding();
    const res = await server.inject(
      `/detectors/ewc-not-packaging/findings/${encodeURIComponent(finding.subject.id)}`,
    );

    // thresholdsUsed is shown for auditability (ewc echoes `scores`).
    for (const key of Object.keys(finding.evidence)) {
      assert.ok(res.payload.includes(key));
    }
    assert.ok(res.payload.includes('Thresholds used'));
    // Severity rendered as a coloured govuk tag (top ewc hit is hazardous → critical).
    assert.strictEqual(finding.severity, 'critical');
    assert.match(res.payload, /govuk-tag govuk-tag--red/);
  });

  test('links back to its own detector list', async () => {
    const finding = topEwcFinding();
    const res = await server.inject(
      `/detectors/ewc-not-packaging/findings/${encodeURIComponent(finding.subject.id)}`,
    );
    assert.match(res.payload, /href="\/detectors\/ewc-not-packaging"/);
  });

  test('a chain-mass-balance finding detail also renders (generic evidence shape)', async () => {
    const finding = triage(result.byDetector['chain-mass-balance']).surfaced[0];
    const res = await server.inject(
      `/detectors/chain-mass-balance/findings/${encodeURIComponent(finding.subject.id)}`,
    );
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.payload.includes(finding.reason));
  });

  test('an unknown finding id answers 404 (not a 500)', async () => {
    const res = await server.inject('/detectors/ewc-not-packaging/findings/does-not-exist');
    assert.strictEqual(res.statusCode, 404);
  });

  test('an unknown detector id answers 404', async () => {
    const res = await server.inject('/detectors/no-such-detector/findings/0');
    assert.strictEqual(res.statusCode, 404);
  });
});
