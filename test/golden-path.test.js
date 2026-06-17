'use strict';

/**
 * golden-path.test.js — the end-to-end smoke test (PRD §4, §10).
 *
 * This is the ONE test that proves the demo works start to finish, DB-free:
 *
 *   1. ingest ≥2 fixtures               (golden-path step 1)
 *   2. fan out over the detector registry (golden-path step 2)
 *   3. triage each detector's list into its own ranked findings (steps 3–4)
 *   4. assert each implemented ★ detector fires and its TOP finding is the
 *      expected seeded anomaly                                  (step 5)
 *
 * It deliberately targets the curated `fixtures/demo/` set, NOT the full
 * submissions: the demo files carry one small, documented anomaly cluster per ★
 * detector (see `fixtures/demo/README.md`), so the counts and top findings are
 * stable and legible. Pointing at the 1,000-load real files would make these
 * assertions large and brittle for no extra coverage of the golden path.
 *
 * Determinism (CLAUDE.md): fixed fixture order, no live network, no DB. The same
 * run always yields the same per-detector lists.
 *
 * Only the two ★ detectors built so far are asserted here; the remaining three
 * (`material-profile`, `destination-plausibility`, `single-supplier→many-operators`)
 * are added to EXPECTED by the dedicated "extend the smoke test" plan item once
 * each detector lands.
 */

const Path = require('path');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { ingest } = require('../src/ingest');
const { run } = require('../src/engine/orchestrator');
const { triage } = require('../src/engine/triage');
const { registerDetectors } = require('../src/web/server');

const ROOT = Path.join(__dirname, '..');
const DEMO_FIXTURES = [
  Path.join(ROOT, 'fixtures', 'demo', 'demo_exporter_AL.xlsx'),
  Path.join(ROOT, 'fixtures', 'demo', 'demo_exporter_FB.xlsx'),
];

/**
 * Per-detector expectations, verified against the seeds in `fixtures/demo/README.md`.
 * `topMatches(finding)` asserts the highest-ranked finding IS the headline seeded
 * anomaly for that detector — not just that *some* finding exists.
 */
const EXPECTED = [
  {
    id: 'ewc-not-packaging',
    count: 5, // 2 hazardous (critical) + 2 non-packaging + 1 off-list (high)
    topMatches(top) {
      // Hazardous (*) outranks everything (score 100, critical) — it must be the top hit.
      assert.equal(top.severity, 'critical', 'top ewc finding is critical (hazardous)');
      assert.equal(top.score, 100, 'hazardous EWC scores the maximum');
      assert.equal(top.evidence.category, 'hazardous', 'top hit is flagged hazardous');
      assert.match(top.evidence.ewcCode, /\*$/, 'hazardous EWC code carries the * marker');
    },
  },
  {
    id: 'chain-mass-balance',
    count: 8, // 5 export-leg + 3 osr-leg, all physically impossible → critical
    topMatches(top) {
      assert.equal(top.severity, 'critical', 'an impossible chain is always critical');
      assert.ok(
        Array.isArray(top.evidence.violations) && top.evidence.violations.length >= 1,
        'top chain finding records at least one broken leg',
      );
      // The reconciliation figures that tripped it are all present as evidence.
      for (const k of ['recv', 'exp', 'osr']) {
        assert.ok(k in top.evidence, `evidence carries the ${k} tonnage`);
      }
    },
  },
];

let result;
let data;

before(async () => {
  // Register every detector the same way the server boots (directory scan →
  // self-register, ADR-004), so the fan-out covers exactly the demo's registry.
  registerDetectors();

  const dataset = await ingest(DEMO_FIXTURES);
  data = dataset;

  // Mirror the server boot: enrich the dataset's Sheet1 reference union with the
  // reviewed allow-lists so `ewc-not-packaging` gets the explicit `15 01 xx`
  // packaging subset (`packagingEwcCodes`) rather than re-deriving it by prefix.
  const allowedCodes = require('../reference/allowed-codes.json');
  const enriched = {
    ...dataset,
    reference: {
      ...dataset.reference,
      ewcCodes: allowedCodes.ewcCodes,
      packagingEwcCodes: allowedCodes.packagingEwcCodes,
      materials: allowedCodes.materials,
    },
  };

  result = await run(enriched);
});

test('ingest reads ≥2 fixtures into one DB-free dataset (step 1)', () => {
  assert.equal(data.loads.length, 100, 'demo set is 50 AL + 50 FB loads');
  assert.equal(data.warnings.length, 0, 'the curated demo fixtures parse cleanly');

  const operators = new Set(data.loads.map((l) => l.operatorId));
  assert.deepEqual(
    [...operators].sort(),
    ['E-ACC10001AL', 'E-ACC10002FB'],
    'loads span the two distinct operators (≥2 files)',
  );
});

test('the engine fans out over the registry without aborting (step 2)', () => {
  assert.deepEqual(result.errors, [], 'no detector threw during the run');
  for (const { id } of EXPECTED) {
    assert.ok(
      Array.isArray(result.byDetector[id]),
      `${id} ran and produced a findings list`,
    );
  }
});

for (const expected of EXPECTED) {
  test(`★ ${expected.id} surfaces its seeded anomaly as the top finding (steps 3–5)`, () => {
    const findings = result.byDetector[expected.id];
    assert.ok(findings.length >= 1, `${expected.id} returns at least one finding`);
    assert.equal(findings.length, expected.count, `${expected.id} finds the seeded cluster`);

    // Triage ranks the detector's own list high→low — the same seam the
    // per-detector web view re-runs per request (golden-path steps 3–4).
    const { surfaced } = triage(findings);
    assert.ok(surfaced.length >= 1, `${expected.id} surfaces at least one finding by default`);

    const top = surfaced[0];
    assert.equal(top.detectorId, expected.id, 'top finding belongs to this detector');
    expected.topMatches(top);
  });
}
