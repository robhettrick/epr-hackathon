'use strict';

/**
 * ingest/column-map.js — declarative machine-header → canonical Load field map (ADR-003).
 *
 * The exporter template v5.1 sheet "Exported (sections 1, 2 and 3)" carries a
 * machine-name header row (row 1, e.g. `EWC_CODE`, `NET_WEIGHT`), a human header
 * (row 2) and an Example (row 3). The parser (item C, next) reads row 1 as keys
 * and yields data rows from row 4 keyed by those machine names; this map translates
 * each machine name to the canonical `Load` field consumed by `makeLoad`
 * (src/model/load.js). New template versions = edit this map, not the parser —
 * detectors stay decoupled from sheet layout (ADR-003).
 *
 * The mapping was derived by inspecting row 1 of BOTH fixtures
 * (`exporter_E-ACC12245AL_…` and `exporter_E-ACC12245FB_…`); the header names and
 * their column letters are identical across the two files. The column letters in
 * the comments are provenance only — translation keys on the machine name, never
 * the letter.
 *
 * NOT in this map (Cover-sheet derived, tagged on per-file by the normaliser, not
 * read from a data column): `operatorId` (`__EPR_META_ACCREDITATION_NUMBER` /
 * `__EPR_META_REGISTRATION_NUMBER`) and `material` (`__EPR_META_MATERIAL`).
 *
 * Note on `interimHandling` (column AC): the actual machine header is
 * `TONNAGE_PASSED_INTERIM_SITE_RECEIVED_BY_OSR` — the OSR-received tonnage *via an
 * interim site*, populated only when the load was routed through one. The Load
 * model coerces it as text, so a non-null `interimHandling` is a reliable proxy for
 * "this load went through an interim site" — which is what `chain-mass-balance`
 * needs to relax its inequality. The separate Yes/No flag
 * `DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE` (AA) is mapped to the canonical Load
 * field `interimSite` (a boolean): it is the explicit declaration of an interim
 * route, distinct from the AC tonnage proxy — a load can be flagged interim with
 * zero interim tonnage, which `interimSite` captures and `interimHandling` cannot.
 */

/**
 * Machine header name → canonical `Load` field name. Frozen: the map is reference
 * data, not mutable state. Every value here is a field produced by `makeLoad`.
 */
const COLUMN_MAP = Object.freeze({
  // dates
  DATE_RECEIVED_FOR_EXPORT: 'receivedForExport', // G
  DATE_OF_EXPORT: 'exported', // U
  DATE_RECEIVED_BY_OSR: 'receivedByOsr', // Y

  // classification
  EWC_CODE: 'ewcCode', // H
  DESCRIPTION_WASTE: 'descriptionWaste', // I

  // weights / proportion — gross/tare/pallet are the inputs `arithmetic-integrity`
  // recomputes net from (net should equal gross − tare − pallet); non-target is
  // the contaminant weight carried for completeness.
  GROSS_WEIGHT: 'gross', // K
  TARE_WEIGHT: 'tare', // L
  PALLET_WEIGHT: 'pallet', // M
  NET_WEIGHT: 'net', // N
  WEIGHT_OF_NON_TARGET_MATERIALS: 'nonTargetWeight', // Q
  RECYCLABLE_PROPORTION_PERCENTAGE: 'recyclableProportion', // R

  // chain tonnages
  TONNAGE_RECEIVED_FOR_EXPORT: 'tonnageReceivedForExport', // S
  TONNAGE_OF_UK_PACKAGING_WASTE_EXPORTED: 'tonnageExported', // T
  TONNAGE_RECEIVED_BY_OSR: 'tonnageReceivedByOsr', // BK

  // handling + destination
  DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE: 'interimSite', // AA
  TONNAGE_PASSED_INTERIM_SITE_RECEIVED_BY_OSR: 'interimHandling', // AC
  OSR_COUNTRY: 'osrCountry', // BJ
  OSR_NAME: 'osrName', // BI

  // refusal
  WAS_THE_WASTE_REFUSED: 'refused', // AN

  // network entities
  SUPPLIER_NAME: 'supplierName', // AH
  SUPPLIER_POSTCODE: 'supplierPostcode', // AJ
  CARRIER_VEHICLE_REGISTRATION_NUMBER: 'carrierVehicleReg', // BE
});

/** The machine header names this map understands (data columns only). */
const MACHINE_HEADERS = Object.freeze(Object.keys(COLUMN_MAP));

/**
 * Mapped headers that are optional enrichments rather than pipeline requirements:
 * a submission may legitimately omit them, so the parser does NOT warn when they
 * are absent (the "missing header" warning is reserved for columns the detectors
 * actually rely on). `DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE` (AA → `interimSite`)
 * is optional because `chain-mass-balance` already keys interim routing off the AC
 * tonnage proxy (`interimHandling`); no detector requires the explicit AA flag.
 * The full fixtures carry AA (so it populates where present); the curated demo set
 * omits it (so its absence must stay silent — see fixtures/demo/README.md).
 */
const OPTIONAL_HEADERS = Object.freeze(['DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE']);

/** The canonical Load field names populated from data columns (Cover-tagged
 * `operatorId`/`material` excluded — they are not in this map). */
const CANONICAL_FIELDS = Object.freeze(Object.values(COLUMN_MAP));

/**
 * Translate one machine-header-keyed row into a canonical-field-keyed row,
 * dropping any unmapped headers (skip columns, references, auto-calc helpers).
 * Pure: does not coerce types (that is `makeLoad`'s job) and never throws — an
 * unknown or missing header is simply absent from the output.
 *
 * @param {object} [rawRow] row keyed by machine header names (from the parser).
 * @returns {object} row keyed by canonical Load field names.
 */
function toCanonicalRow(rawRow = {}) {
  const canonical = {};
  for (const [header, field] of Object.entries(COLUMN_MAP)) {
    if (Object.prototype.hasOwnProperty.call(rawRow, header)) {
      canonical[field] = rawRow[header];
    }
  }
  return canonical;
}

module.exports = { COLUMN_MAP, MACHINE_HEADERS, OPTIONAL_HEADERS, CANONICAL_FIELDS, toCanonicalRow };
