'use strict';

/**
 * detectors/destination-plausibility.js — the fourth real ★ detector (PRD §6).
 *
 * UK packaging waste plausibly goes to overseas reprocessors in a relatively small
 * set of countries with the relevant reprocessing capacity. A load declared to a
 * small-island or least-developed state with no known capacity to reprocess that
 * material is implausible and Basel-relevant (docs/anomaly-scenarios-from-sample.md
 * E2: "Destination Tuvalu-TV has no known aluminium reprocessing capacity; … loads
 * were declared to small-island states with no OSR infrastructure").
 *
 * Plausibility is **per material**: a reviewed list of destinations with no known
 * reprocessing capacity is kept per material family in `destination-profiles.json`
 * (ADR-007 reviewed data table). A load's family is resolved from its own data
 * (the part of `descriptionWaste` (col I) before the ' - ' grade separator, or the
 * Cover-tagged `material`) and normalised, so the check keys on material and is
 * never hard-coded to aluminium — the fixtures carry aluminium AND fibre-based
 * composite. A family with no specific entry falls back to the `default` list.
 *
 * Findings are scoped to the **country** (the destination entity), not the
 * individual load: a regulator investigates "everything we sent to Tuvalu", so the
 * implausible loads to one destination are aggregated into a single finding. The
 * score scales with the total exported tonnage concentrated on that destination
 * (heavier shipments rank higher); severity is `high` (E2 is a high-severity
 * profile check). Evidence carries the country, the material family/families, the
 * implausible-load count, the total tonnage and the operators involved.
 *
 * Thresholds reach the detector via `ctx.config` (ADR-006), never hard-coded:
 *   baseScore            score floor for any implausible destination (default 70).
 *   concentrationTonnage exported tonnage to one destination at which the score
 *                        saturates to 100 (default 500).
 *   implausibleDefault   optional override of the JSON `default` list (analyst tuning).
 *   implausibleByFamily  optional override of the JSON per-family lists.
 *
 * Pure & deterministic (ADR-004): reads frozen Loads + a static reviewed table,
 * emits Findings, no I/O at evaluate time. Self-registers on import. Dependency
 * rule (ADR C4): detectors → model.
 */

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');
const { identityKey } = require('../model/entity');
const PROFILE_TABLE = require('./destination-profiles.json');

/** A usable number for tonnage/thresholds is finite; anything else is "unknown". */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Round to 3 dp for stable, human-readable evidence/reason tonnages. */
function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * Resolve a load's material *family* — the substance, not the per-load grade.
 * Prefer the part of `descriptionWaste` before the ' - '/' – ' grade separator
 * (e.g. "Aluminium - AAIG cans (97.5%)" → "Aluminium"), else the Cover `material`
 * (e.g. "Fibre_based_composite"). Returned raw; `familyKey` normalises it.
 */
function familyOf(load) {
  if (typeof load.descriptionWaste === 'string' && load.descriptionWaste.trim()) {
    return load.descriptionWaste.split(/\s+[-–]\s+/)[0];
  }
  if (typeof load.material === 'string' && load.material.trim()) return load.material;
  return null;
}

/**
 * Normalise a material family to a stable lookup key: lowercase, hyphens/en-dashes/
 * underscores → spaces, whitespace collapsed. So "Fibre-based composite" and the
 * Cover "Fibre_based_composite" both key to "fibre based composite".
 */
function familyKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.toLowerCase().replace(/[_–-]/g, ' ').replace(/\s+/g, ' ').trim();
  return key || null;
}

/** Build a Set of normalised country identity keys from a list of country strings. */
function toCountrySet(list) {
  const set = new Set();
  if (!Array.isArray(list)) return set;
  for (const c of list) {
    const k = identityKey(c);
    if (k) set.add(k);
  }
  return set;
}

const DestinationPlausibility = {
  meta: {
    id: 'destination-plausibility',
    title: 'Implausible reprocessing destination for the material',
    description: "Flags loads sent to overseas destinations with no known reprocessing capacity for that material, for example aluminium declared to a country with no aluminium reprocessor.",
    scope: SUBJECT_TYPE.COUNTRY,
    version: '1.0.0',
    enabled: true,
    shadow: false,
    // Tunable at runtime via config.json (ADR-006); read from ctx.config.
    config: {
      baseScore: 70, // score floor for any implausible destination
      concentrationTonnage: 500, // exported tonnage to one destination at which score saturates to 100
      implausibleDefault: null, // optional override of destination-profiles.json `default` list
      implausibleByFamily: null, // optional override of destination-profiles.json per-family lists
    },
  },

  /**
   * @param {{loads: object[]}} data ingested dataset (uses `data.loads`).
   * @param {{config?: object}} [ctx] engine context: effective config (ADR-006).
   * @returns {object[]} one Finding per destination country receiving implausible loads.
   */
  evaluate(data, ctx = {}) {
    const loads = (data && Array.isArray(data.loads)) ? data.loads : [];
    const cfg = ctx.config || DestinationPlausibility.meta.config;
    const defaults = DestinationPlausibility.meta.config;
    const baseScore = isNumber(cfg.baseScore) ? cfg.baseScore : defaults.baseScore;
    const concentrationTonnage = isNumber(cfg.concentrationTonnage) && cfg.concentrationTonnage > 0
      ? cfg.concentrationTonnage
      : defaults.concentrationTonnage;

    // The reviewed lists default to the JSON data table; ctx.config may override
    // either the default list or the per-family lists for analyst tuning (ADR-006).
    const defaultList = Array.isArray(cfg.implausibleDefault)
      ? cfg.implausibleDefault
      : ((PROFILE_TABLE.default && PROFILE_TABLE.default.implausible) || []);
    const familyLists = (cfg.implausibleByFamily && typeof cfg.implausibleByFamily === 'object')
      ? cfg.implausibleByFamily
      : (PROFILE_TABLE.families || {});

    // Resolve the implausible-country Set for a family, memoised per family key.
    const setCache = new Map();
    const defaultSet = toCountrySet(defaultList);
    function implausibleSetFor(fkey) {
      if (!fkey) return defaultSet;
      if (setCache.has(fkey)) return setCache.get(fkey);
      const entry = familyLists[fkey];
      const list = (entry && Array.isArray(entry.implausible)) ? entry.implausible : null;
      const set = list ? toCountrySet(list) : defaultSet;
      setCache.set(fkey, set);
      return set;
    }

    // Aggregate the implausible loads by destination country (the finding subject).
    const byCountry = new Map();
    for (let i = 0; i < loads.length; i += 1) {
      const load = loads[i];
      if (!load) continue;

      const country = load.osrCountry;
      const countryKey = identityKey(country);
      if (!countryKey) continue; // no destination recorded — data-quality gap, not this detector

      const fkey = familyKey(familyOf(load));
      if (!implausibleSetFor(fkey).has(countryKey)) continue; // plausible for this material → fine

      let agg = byCountry.get(countryKey);
      if (!agg) {
        agg = {
          country, // display value, first seen
          loadCount: 0,
          tonnage: 0,
          families: new Set(),
          operatorIds: new Set(),
          osrNames: new Set(),
        };
        byCountry.set(countryKey, agg);
      }
      agg.loadCount += 1;
      if (isNumber(load.tonnageExported)) agg.tonnage += load.tonnageExported;
      const famLabel = familyOf(load);
      if (famLabel) agg.families.add(famLabel.trim());
      if (load.operatorId) agg.operatorIds.add(load.operatorId);
      if (load.osrName) agg.osrNames.add(load.osrName);
    }

    const findings = [];
    for (const [countryKey, agg] of byCountry) {
      const tonnage = round3(agg.tonnage);
      // Score floored at baseScore, scaling with the tonnage concentrated on this
      // destination so heavier (more material at risk) shipments rank higher.
      const score = Math.min(
        100,
        Math.round(baseScore + Math.min(tonnage / concentrationTonnage, 1) * (100 - baseScore)),
      );
      const families = [...agg.families];
      const familyText = families.length ? families.join(', ') : 'this material';

      findings.push(
        makeFinding({
          detectorId: DestinationPlausibility.meta.id,
          version: DestinationPlausibility.meta.version,
          subject: {
            type: SUBJECT_TYPE.COUNTRY,
            id: countryKey,
            label: agg.country,
          },
          score,
          severity: SEVERITY.HIGH,
          reason: `Destination ${agg.country} has no known reprocessing capacity for ${familyText}; ${agg.loadCount} load(s) totalling ${tonnage} t were declared to a destination with no OSR infrastructure for this material.`,
          evidence: {
            country: agg.country,
            materials: families,
            loadCount: agg.loadCount,
            tonnage,
            operatorIds: [...agg.operatorIds],
            osrNames: [...agg.osrNames],
          },
          thresholdsUsed: { baseScore, concentrationTonnage },
        }),
      );
    }

    return findings;
  },
};

module.exports = register(DestinationPlausibility);
