'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const YearOnYearSwing = require('../../src/detectors/year-on-year-swing');
const { makeLoad } = require('../../src/model/load');
const { ingest } = require('../../src/ingest');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector totals each operator's received-for-export tonnage (S) per calendar
 * year and compares each year against the operator's previous available year — so it
 * only fires once a PRIOR-period submission is ingested alongside the current one
 * (PRD §5.1 cross-period; fixtures/demo/README.md: the 2024 AL re-submission slice
 * paired with the 2026 AL file). Tests build real frozen Loads via `makeLoad` so the
 * date/tonnage coercion matches production, and thresholds go through `ctx.config`
 * (ADR-006), not literals. The headline case ingests the real demo fixture pair.
 */
function ctx(config) {
  return config ? { config } : {};
}

/** Build the dataset shape the detector reads: `{ loads }` from raw rows. */
function dataFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

/** A dated load contributing `s` tonnes of S for `operatorId` in calendar `year`. */
function load(operatorId, year, s) {
  return {
    operatorId,
    exported: new Date(Date.UTC(year, 1, 5)),
    receivedForExport: new Date(Date.UTC(year, 1, 1)),
    receivedByOsr: new Date(Date.UTC(year, 1, 10)),
    tonnageReceivedForExport: s,
  };
}

test('flags an operator whose received-for-export tonnage swings beyond the threshold', () => {
  // 1000 t in 2024 → 100 t in 2026: a 90% collapse, well over the 50% threshold.
  const findings = YearOnYearSwing.evaluate(
    dataFrom(load('E-ACC10001AL', 2024, 1000), load('E-ACC10001AL', 2026, 100)),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'year-on-year-swing');
  assert.equal(f.subject.type, SUBJECT_TYPE.PERIOD);
  assert.equal(f.subject.id, 'E-ACC10001AL:2024->2026'); // stable operator+pair id
  assert.equal(f.subject.label, 'E-ACC10001AL 2024→2026');
  assert.equal(f.evidence.priorYear, 2024);
  assert.equal(f.evidence.currentYear, 2026);
  assert.equal(f.evidence.priorTonnage, 1000);
  assert.equal(f.evidence.currentTonnage, 100);
  assert.equal(f.evidence.deltaTonnage, -900);
  assert.equal(f.evidence.relativeChangePct, -90);
  assert.equal(f.evidence.direction, 'decrease');
});

test('passes an operator whose tonnage is broadly stable year-on-year', () => {
  // 1000 t → 1200 t is a 20% move, within the 50% threshold.
  const findings = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 1000), load('OP-A', 2026, 1200)),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('does NOT fire for an operator with only one period (no prior to compare)', () => {
  // The default golden-path demo is 2026-only: each operator has a single year, so
  // the detector is silent and the five ★ counts stay undisturbed.
  const findings = YearOnYearSwing.evaluate(
    dataFrom(
      load('OP-A', 2026, 1000),
      load('OP-A', 2026, 500),
      load('OP-B', 2026, 800),
    ),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('compares against the previous AVAILABLE year across a gap (2024 → 2026)', () => {
  const findings = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 200), load('OP-A', 2026, 2000)),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.priorYear, 2024);
  assert.equal(findings[0].evidence.currentYear, 2026);
});

test('emits one finding per adjacent period pair for a three-year operator', () => {
  // 100 (2023) → 1000 (2024): +900%; 1000 (2024) → 1100 (2025): +10% (within); so
  // exactly one of the two adjacent pairs flags.
  const findings = YearOnYearSwing.evaluate(
    dataFrom(
      load('OP-A', 2023, 100),
      load('OP-A', 2024, 1000),
      load('OP-A', 2025, 1100),
    ),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'OP-A:2023->2024');
});

test('robustness floor: a big % swing on negligible volume is not flagged', () => {
  // 1 t → 5 t is a 400% move but neither period clears minTonnage (100 t) — noise.
  const findings = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 1), load('OP-A', 2026, 5)),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('a flow appearing from nothing is a maximal swing (Infinity → score 100/high)', () => {
  const findings = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 0), load('OP-A', 2026, 5000)),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.evidence.priorTonnage, 0);
  assert.equal(f.evidence.relativeChangePct, null); // Infinity isn't JSON-representable
  assert.equal(f.evidence.direction, 'increase');
  assert.equal(f.score, 100);
  assert.equal(f.severity, SEVERITY.HIGH);
  assert.match(f.reason, /from nothing/);
});

test('score scales with swing magnitude and severity escalates at highSwing', () => {
  // Just over threshold (60% move) → medium, floored near baseScore.
  const small = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 1000), load('OP-A', 2026, 1600)),
    ctx(),
  )[0];
  // A tripling (200% move) reaches highSwing → high, saturated to 100.
  const big = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 1000), load('OP-A', 2026, 3000)),
    ctx(),
  )[0];
  assert.equal(small.severity, SEVERITY.MEDIUM);
  assert.ok(small.score >= 60 && small.score < big.score);
  assert.equal(big.severity, SEVERITY.HIGH);
  assert.equal(big.score, 100);
});

test('thresholds come from ctx.config (ADR-006): raising maxRelSwing suppresses a finding', () => {
  const data = dataFrom(load('OP-A', 2024, 1000), load('OP-A', 2026, 1600)); // +60%
  assert.equal(YearOnYearSwing.evaluate(data, ctx()).length, 1);
  // Lifting the allowed swing above 60% clears it.
  assert.equal(
    YearOnYearSwing.evaluate(data, ctx({ maxRelSwing: 0.7, minTonnage: 100, baseScore: 60, highSwing: 2 })).length,
    0,
  );
  // Or raising the tonnage floor above the periods' volume clears it.
  assert.equal(
    YearOnYearSwing.evaluate(data, ctx({ maxRelSwing: 0.5, minTonnage: 5000, baseScore: 60, highSwing: 2 })).length,
    0,
  );
});

test('thresholdsUsed echoes the applied config (auditability)', () => {
  const findings = YearOnYearSwing.evaluate(
    dataFrom(load('OP-A', 2024, 1000), load('OP-A', 2026, 100)),
    ctx({ maxRelSwing: 0.3, minTonnage: 50, baseScore: 55, highSwing: 1.5 }),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].thresholdsUsed, { maxRelSwing: 0.3, minTonnage: 50, highSwing: 1.5 });
});

test('an undateable load is a coverage gap, skipped without crashing (ADR C3)', () => {
  const findings = YearOnYearSwing.evaluate(
    dataFrom(
      load('OP-A', 2024, 1000),
      { operatorId: 'OP-A', tonnageReceivedForExport: 9999 }, // no dates → no period
      load('OP-A', 2026, 100),
    ),
    ctx(),
  );
  // The undateable 9999 t load is excluded, so the 2024→2026 collapse still flags
  // and the dateless tonnage does not distort either period total.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.currentTonnage, 100);
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('year-on-year-swing'), YearOnYearSwing);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(YearOnYearSwing.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(YearOnYearSwing.evaluate({}, ctx()), []);
  assert.deepEqual(YearOnYearSwing.evaluate(undefined, ctx()), []);
});

test('fires on the seeded demo {AL_2024, AL} pair (fixtures/demo/README.md)', async () => {
  // The done-when: exercise YoY on the prior-year slice + current AL file. The 2024
  // re-submission (30 loads) and the 2026 file (50 loads) are the SAME operator, so a
  // single operator-pair finding surfaces the year-on-year tonnage swing.
  const data = await ingest([
    'fixtures/demo/demo_exporter_AL_2024.xlsx',
    'fixtures/demo/demo_exporter_AL.xlsx',
  ]);
  const findings = YearOnYearSwing.evaluate(data, ctx());
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.subject.type, SUBJECT_TYPE.PERIOD);
  assert.equal(f.evidence.operatorId, 'E-ACC10001AL');
  assert.equal(f.evidence.priorYear, 2024);
  assert.equal(f.evidence.currentYear, 2026);
  assert.ok(f.evidence.currentTonnage > f.evidence.priorTonnage); // a clear swing
  assert.ok(f.score >= 60);
});
