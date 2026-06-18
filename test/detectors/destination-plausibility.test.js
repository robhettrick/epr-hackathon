'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const DestinationPlausibility = require('../../src/detectors/destination-plausibility');
const { makeLoad } = require('../../src/model/load');
const { SEVERITY, SUBJECT_TYPE } = require('../../src/model/finding');

/**
 * The detector flags loads whose OSR_COUNTRY (col BJ) is an implausible reprocessing
 * destination for the load's material family (a reviewed list in
 * destination-profiles.json, keyed per material), aggregating all such loads to one
 * destination into a single country-scoped finding. We craft real frozen Loads via
 * `makeLoad` (mirrors the engine path) and feed thresholds through `ctx.config` so
 * the test exercises the ADR-006 wiring, not literals. Cases mirror
 * docs/anomaly-scenarios-from-sample.md E2 and fixtures/demo/README.md.
 */
function ctx(config) {
  return config ? { config } : {};
}

function loadsFrom(...rows) {
  return { loads: rows.map((r) => makeLoad(r)) };
}

const AL_CANS = 'Aluminium - AAIG aluminium cans and associated packaging (97.5%)';
const FB_CARTONS = 'Fibre-based composite - drink cartons';

test('flags a Tuvalu aluminium destination as a country-scoped finding with evidence', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({
      descriptionWaste: AL_CANS,
      osrCountry: 'Tuvalu-TV',
      tonnageExported: 93.208,
      operatorId: 'E-ACC10001AL',
      osrName: 'Reprocessor 9',
    }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.detectorId, 'destination-plausibility');
  assert.equal(f.subject.type, SUBJECT_TYPE.COUNTRY);
  assert.equal(f.subject.id, 'tuvalu-tv'); // normalised country identity key
  assert.equal(f.subject.label, 'Tuvalu-TV');
  assert.equal(f.severity, SEVERITY.HIGH); // E2 is a high-severity profile check
  assert.equal(f.evidence.country, 'Tuvalu-TV');
  assert.deepEqual(f.evidence.materials, ['Aluminium']);
  assert.equal(f.evidence.loadCount, 1);
  assert.equal(f.evidence.tonnage, 93.208);
  assert.deepEqual(f.evidence.operatorIds, ['E-ACC10001AL']);
  assert.match(f.reason, /Tuvalu-TV/);
});

test('a plausible destination produces no finding', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({ descriptionWaste: AL_CANS, osrCountry: 'Germany-DE', tonnageExported: 100 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('keys on material: a fibre material to Lesotho flags via its family list', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({
      descriptionWaste: FB_CARTONS,
      osrCountry: 'Lesotho-LS',
      tonnageExported: 71.699,
      operatorId: 'E-ACC10002FB',
    }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'lesotho-ls');
  assert.deepEqual(findings[0].evidence.materials, ['Fibre-based composite']);
});

test('resolves the family from the Cover material when descriptionWaste is blank', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({ material: 'Fibre_based_composite', osrCountry: 'Nauru-NR', tonnageExported: 10 }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'nauru-nr');
});

test('aggregates multiple implausible loads to one destination into a single finding', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom(
      { descriptionWaste: AL_CANS, osrCountry: 'Tuvalu-TV', tonnageExported: 50, operatorId: 'A' },
      { descriptionWaste: AL_CANS, osrCountry: 'Tuvalu-TV', tonnageExported: 30, operatorId: 'B' },
    ),
    ctx(),
  );
  assert.equal(findings.length, 1, 'one finding per destination, not per load');
  assert.equal(findings[0].evidence.loadCount, 2);
  assert.equal(findings[0].evidence.tonnage, 80);
  assert.deepEqual(findings[0].evidence.operatorIds.sort(), ['A', 'B']);
});

test('score scales with the tonnage concentrated on a destination (heavier ranks higher)', () => {
  const light = DestinationPlausibility.evaluate(
    loadsFrom({ descriptionWaste: AL_CANS, osrCountry: 'Tuvalu-TV', tonnageExported: 10 }),
    ctx(),
  )[0];
  const heavy = DestinationPlausibility.evaluate(
    loadsFrom({ descriptionWaste: AL_CANS, osrCountry: 'Tuvalu-TV', tonnageExported: 400 }),
    ctx(),
  )[0];
  assert.ok(heavy.score > light.score);
  assert.ok(light.score >= 70); // floored at baseScore
  assert.ok(heavy.score <= 100);
});

test('country matching is format-insensitive (normalised like the country entity key)', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({ descriptionWaste: AL_CANS, osrCountry: '  tuvalu-tv ', tonnageExported: 5 }),
    ctx(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, 'tuvalu-tv');
});

test('thresholds come from ctx.config (ADR-006), and override lists take effect', () => {
  // A config override of the per-family list can flag an otherwise-plausible country.
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({ descriptionWaste: AL_CANS, osrCountry: 'Germany-DE', tonnageExported: 1000 }),
    ctx({
      baseScore: 80,
      concentrationTonnage: 1000,
      implausibleByFamily: { aluminium: { implausible: ['Germany-DE'] } },
    }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].score, 100); // 80 + (1000/1000)*20
  assert.deepEqual(findings[0].thresholdsUsed, { baseScore: 80, concentrationTonnage: 1000 });
});

test('a missing destination country is skipped (data-quality gap, not an anomaly)', () => {
  const findings = DestinationPlausibility.evaluate(
    loadsFrom({ descriptionWaste: AL_CANS, osrCountry: null, tonnageExported: 50 }),
    ctx(),
  );
  assert.equal(findings.length, 0);
});

test('self-registers under its meta id', () => {
  const { get } = require('../../src/detectors/registry');
  assert.equal(get('destination-plausibility'), DestinationPlausibility);
});

test('empty / missing data returns no findings (never throws)', () => {
  assert.deepEqual(DestinationPlausibility.evaluate({ loads: [] }, ctx()), []);
  assert.deepEqual(DestinationPlausibility.evaluate({}, ctx()), []);
  assert.deepEqual(DestinationPlausibility.evaluate(undefined, ctx()), []);
});
