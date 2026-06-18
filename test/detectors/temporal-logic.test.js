'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const TemporalLogic = require('../../src/detectors/temporal-logic');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector enforces the forward ordering of the three chain dates
 * received-for-export (G) ≤ exported (U) ≤ received-by-OSR (Y). We craft real
 * frozen Loads through `makeLoad` (mirrors the engine path; date strings coerce to
 * Date objects) and feed thresholds via `ctx.config` so the test exercises the
 * ADR-006 wiring, not literals. Mirrors the demo fixture's seeded temporal anomaly
 * (fixtures/demo/README.md: "one AL load exported before it was received").
 */
function ctx(config) {
  return config ? { config } : {};
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

// A clean, strictly forward-ordered chain.
const FORWARD = {
  receivedForExport: '2026-02-07',
  exported: '2026-02-10',
  receivedByOsr: '2026-02-16',
  operatorId: 'E-ACC10001AL',
};

test('flags a load exported before it was received (export-before-received leg)', () => {
  const findings = TemporalLogic.evaluate(
    loadsFrom({ ...FORWARD, receivedForExport: '2026-02-07', exported: '2026-02-04' }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'temporal-logic');
  assert.equal(f.subject.type, SUBJECT_TYPE.LOAD);
  assert.equal(f.subject.id, 0);
  assert.equal(f.severity, SEVERITY.CRITICAL); // an impossible ordering is always critical
  assert.equal(f.evidence.violations.length, 1);
  assert.equal(f.evidence.violations[0].id, 'export-before-received');
  assert.equal(f.evidence.violations[0].gapDays, 3); // received the 7th, exported the 4th
  assert.equal(f.evidence.receivedForExport, '2026-02-07');
  assert.equal(f.evidence.exported, '2026-02-04');
});

test('flags a load received by the OSR before it was exported (osr-before-export leg)', () => {
  const findings = TemporalLogic.evaluate(
    loadsFrom({ ...FORWARD, exported: '2026-02-10', receivedByOsr: '2026-02-08' }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const v = findings[0].evidence.violations;
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'osr-before-export');
  assert.equal(v[0].gapDays, 2);
});

test('a strictly forward-ordered chain produces no finding', () => {
  assert.equal(TemporalLogic.evaluate(loadsFrom(FORWARD), ctx()).length, 0);
});

test('equal dates on a leg are not "backwards" (same-day is allowed)', () => {
  const findings = TemporalLogic.evaluate(
    loadsFrom({ ...FORWARD, receivedForExport: '2026-02-10', exported: '2026-02-10' }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('one load can break both legs (two violations, worst gap drives the score)', () => {
  const findings = TemporalLogic.evaluate(
    loadsFrom({
      receivedForExport: '2026-02-20',
      exported: '2026-02-10', // 10 days before received
      receivedByOsr: '2026-02-05', // 5 days before exported
      operatorId: 'E-ACC10001AL',
    }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const ids = findings[0].evidence.violations.map((v) => v.id).sort();
  assert.deepEqual(ids, ['export-before-received', 'osr-before-export']);
});

test('a leg with a missing date is skipped (coverage gap, not an anomaly)', () => {
  // No exported date → neither leg can be assessed.
  const findings = TemporalLogic.evaluate(
    loadsFrom({ receivedForExport: '2026-02-07', exported: null, receivedByOsr: '2026-02-16' }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('score scales with the backwards gap (bigger reversal ranks higher)', () => {
  const small = TemporalLogic.evaluate(
    loadsFrom({ receivedForExport: '2026-02-07', exported: '2026-02-04' }),
    ctx(),
  )[0];
  const big = TemporalLogic.evaluate(
    loadsFrom({ receivedForExport: '2026-04-01', exported: '2026-02-01' }),
    ctx(),
  )[0];
  assert.ok(big.score > small.score);
  assert.ok(small.score >= 80); // floored at baseScore
  assert.ok(big.score <= 100);
});

test('thresholds come from ctx.config (ADR-006): a day tolerance suppresses a small reversal', () => {
  const rows = loadsFrom({ receivedForExport: '2026-02-07', exported: '2026-02-04' }); // 3-day reversal
  // A 5-day tolerance absorbs the 3-day reversal → no finding...
  assert.equal(
    TemporalLogic.evaluate(rows, ctx({ toleranceDays: 5, baseScore: 80, highGapDays: 30 })).length,
    0,
  );
  // ...and the applied thresholds are echoed when it does fire.
  const fired = TemporalLogic.evaluate(rows, ctx({ toleranceDays: 1, baseScore: 80, highGapDays: 30 }));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].thresholdsUsed.toleranceDays, 1);
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('temporal-logic'), TemporalLogic);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(TemporalLogic.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(TemporalLogic.evaluate({}, ctx()), []);
  assert.deepEqual(TemporalLogic.evaluate(undefined, ctx()), []);
});

test('fires exactly once on the demo fixtures (the seeded AL load)', async () => {
  const { ingest } = require('../../src/ingest');
  const dir = 'fixtures/demo';
  const files = ['demo_exporter_AL.xlsx', 'demo_exporter_FB.xlsx'].map((f) => `${dir}/${f}`);
  const { loads } = await ingest(files);
  const findings = TemporalLogic.evaluate({ loads }, ctx());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.label.includes('E-ACC10001AL'), true);
  assert.equal(findings[0].evidence.violations[0].id, 'export-before-received');
});
