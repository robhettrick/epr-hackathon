'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ChainMassBalance = require('../../src/detectors/chain-mass-balance');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector checks the chain inequality recv ≥ exp ≥ osr (S/T/BK) per load.
 * We craft real frozen Loads through `makeLoad` (mirrors the engine path) and
 * feed thresholds via `ctx.config` so the test exercises the ADR-006 wiring, not
 * literals. Cases mirror docs/anomaly-scenarios-from-sample.md B1.
 */
function ctx(config) {
  return config ? { config } : {};
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

test('flags a row where exported exceeds received for export (impossible) — critical', () => {
  const findings = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 30, tonnageExported: 50, tonnageReceivedByOsr: 10, operatorId: 'OP1' }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'chain-mass-balance');
  assert.equal(f.severity, SEVERITY.CRITICAL);
  assert.equal(f.subject.type, SUBJECT_TYPE.LOAD);
  assert.deepEqual(f.evidence.violations, [{ leg: 'export', delta: 20 }]);
  assert.equal(f.evidence.recv, 30);
  assert.equal(f.evidence.exp, 50);
});

test('a reconciling row (recv ≥ exp ≥ osr) produces no finding', () => {
  const findings = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100, tonnageExported: 80, tonnageReceivedByOsr: 75 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('a row exactly equal across the chain reconciles (no finding)', () => {
  const findings = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 50, tonnageExported: 50, tonnageReceivedByOsr: 50 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('flags the osr leg when the OSR receives more than was exported', () => {
  const findings = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100, tonnageExported: 80, tonnageReceivedByOsr: 90 }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].evidence.violations, [{ leg: 'osr', delta: 10 }]);
});

test('both legs can break on one row', () => {
  const findings = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 30, tonnageExported: 50, tonnageReceivedByOsr: 60 }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const legs = findings[0].evidence.violations.map((v) => v.leg).sort();
  assert.deepEqual(legs, ['export', 'osr']);
});

test('a gap within tolerance does not flag; just over tolerance does', () => {
  const within = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100, tonnageExported: 100.01 }),
    ctx({ tolerance: 0.01 }),
  );
  assert.equal(within.length, 0); // exp - recv = 0.01, not > tolerance

  const over = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100, tonnageExported: 100.02 }),
    ctx({ tolerance: 0.01 }),
  );
  assert.equal(over.length, 1);
});

test('tolerance is read from ctx.config (ADR-006): a wider tolerance suppresses the flag', () => {
  const row = { tonnageReceivedForExport: 100, tonnageExported: 105 };
  assert.equal(ChainMassBalance.evaluate(loadsFrom(row), ctx({ tolerance: 0.01 })).length, 1);
  assert.equal(ChainMassBalance.evaluate(loadsFrom(row), ctx({ tolerance: 10 })).length, 0);
});

test('interim-site handling relaxes the osr leg but NOT the export leg', () => {
  // osr (90) > exp (80) but waste passed through an interim site → osr leg relaxed.
  const relaxed = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100, tonnageExported: 80, tonnageReceivedByOsr: 90, interimHandling: '12.5' }),
    ctx(),
  );
  assert.equal(relaxed.length, 0);

  // exp (50) > recv (30): interim never excuses exporting more than received.
  const stillFlagged = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 30, tonnageExported: 50, tonnageReceivedByOsr: 90, interimHandling: '12.5' }),
    ctx(),
  );
  assert.equal(stillFlagged.length, 1);
  assert.deepEqual(stillFlagged[0].evidence.violations, [{ leg: 'export', delta: 20 }]);
});

test('a bigger relative overflow scores higher than a smaller one (drives ranking)', () => {
  const big = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 10, tonnageExported: 100 }),
    ctx(),
  )[0];
  const small = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100, tonnageExported: 101 }),
    ctx(),
  )[0];
  assert.ok(big.score > small.score);
  // every impossible chain ranks at or above the configured floor
  assert.ok(small.score >= 70);
  assert.ok(big.score <= 100);
});

test('a leg with a missing tonnage is not assessed (data-quality gap, not this detector)', () => {
  // recv present, exp null → export leg unassessable; osr null too → no finding.
  const findings = ChainMassBalance.evaluate(
    loadsFrom({ tonnageReceivedForExport: 100 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('the detector self-registered under its meta id', () => {
  const registry = require('../../src/detectors/registry');
  assert.equal(registry.get('chain-mass-balance'), ChainMassBalance);
  assert.ok(registry.getEnabled().includes(ChainMassBalance));
});

test('thresholdsUsed echoes the effective config, and subject.id is the load index', () => {
  const findings = ChainMassBalance.evaluate(
    loadsFrom(
      { tonnageReceivedForExport: 100, tonnageExported: 80 }, // index 0 reconciles
      { tonnageReceivedForExport: 30, tonnageExported: 50 }, // index 1 flags
    ),
    ctx({ tolerance: 0.5, baseScore: 60 }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 1);
  assert.deepEqual(findings[0].thresholdsUsed, { tolerance: 0.5, baseScore: 60 });
});

test('empty / missing data.loads yields no findings (never throws)', () => {
  assert.deepEqual(ChainMassBalance.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(ChainMassBalance.evaluate({}, ctx()), []);
  assert.deepEqual(ChainMassBalance.evaluate(undefined, ctx()), []);
});
