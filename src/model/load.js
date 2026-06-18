'use strict';

/**
 * model/load.js — the canonical per-load record + `makeLoad(raw)` factory.
 *
 * One `Load` is one row of UK packaging waste received for export and sent to an
 * approved overseas reprocessor (OSR). It is the innermost domain type (ADR C4):
 * pure data, no dependencies on other `src/` modules.
 *
 * `makeLoad(raw)` takes a row object **already keyed by canonical field names**
 * (the ingest column map + normaliser do machine-header → canonical translation
 * upstream, ADR-003) and coerces each value to a safe, typed shape. Coercion
 * NEVER throws: a blank / unparseable value becomes `null` so a bad row degrades
 * to partial data rather than crashing ingestion (CLAUDE.md hard rule, ADR C3).
 *
 * Column-letter → canonical-field map (template v5.1, sheet
 * "Exported (sections 1, 2 and 3)"; see docs/anomaly-scenarios-from-sample.md
 * and fixtures/README.md). The letters are documentation of provenance only —
 * `makeLoad` reads canonical keys, not letters.
 *
 *   G   receivedForExport          date the waste was received for export
 *   U   exported                   date of export
 *   Y   receivedByOsr              date received by the overseas reprocessor
 *   H   ewcCode                    European Waste Catalogue code (e.g. "15 01 04")
 *   I   descriptionWaste           per-load material/grade description (carries the "(NN.N%)" grade)
 *   K   gross                      gross weight of the load (recompute input)
 *   L   tare                       tare weight of the container (recompute input)
 *   M   pallet                     pallet weight (recompute input)
 *   N   net                        net weight of the load (should equal gross − tare − pallet)
 *   Q   nonTargetWeight            weight of non-target (contaminant) materials
 *   R   recyclableProportion       declared recyclable proportion (0–1)
 *   S   tonnageReceivedForExport   chain tonnage: received for export
 *   T   tonnageExported            chain tonnage: exported
 *   BK  tonnageReceivedByOsr       chain tonnage: received by OSR
 *   AC  interimHandling            interim-site handling note (relaxes mass-balance)
 *   BJ  osrCountry                 destination country of the OSR
 *   BI  osrName                    name of the overseas reprocessor
 *   AN  refused                    load refused by the OSR (Yes/No → boolean)
 *   AH  supplierName               supplier the waste was received from
 *   AJ  supplierPostcode           supplier postcode
 *   BE  carrierVehicleReg          carrier vehicle registration
 *
 * Plus two values tagged on at ingest from the file's Cover sheet (not from a
 * data column), carried through `raw` by the normaliser:
 *   operatorId                     accreditation/registration of the submitting operator
 *   material                       operator-level material (__EPR_META_MATERIAL)
 */

/** Strip an Excel/string cell down to a plain string, or null if empty. */
function toText(value) {
  if (value === null || value === undefined) return null;
  // exceljs can hand back rich/hyperlink/formula cell objects; flatten them.
  if (typeof value === 'object' && !(value instanceof Date)) {
    if (typeof value.text === 'string') value = value.text;
    else if (value.result !== undefined && value.result !== null) value = value.result;
    else if (Array.isArray(value.richText)) value = value.richText.map((r) => r.text).join('');
    else return null;
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Coerce to a finite number, or null. Tolerates thousands separators and stray text. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;
  const text = String(value).trim().replace(/,/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Coerce to a valid Date, or null. Strings are parsed; bare numbers are NOT
 * treated as Excel serials (the parser yields real Date objects for date cells). */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Coerce a Yes/No-style cell to a boolean, or null when unset/ambiguous. */
function toBool(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const text = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(text)) return true;
  if (['no', 'n', 'false', '0'].includes(text)) return false;
  return null;
}

/** Normalise an EWC code: collapse internal whitespace, keep the hazardous "*". */
function toEwc(value) {
  const text = toText(value);
  return text === null ? null : text.replace(/\s+/g, ' ');
}

/**
 * Build a canonical `Load` from a raw, canonical-keyed row object.
 * @param {object} [raw] row keyed by canonical field names (see map above).
 * @returns {object} frozen Load record; every field present, unset → null.
 */
function makeLoad(raw = {}) {
  const load = {
    // provenance / tagging
    operatorId: toText(raw.operatorId),
    material: toText(raw.material),

    // dates (G, U, Y)
    receivedForExport: toDate(raw.receivedForExport),
    exported: toDate(raw.exported),
    receivedByOsr: toDate(raw.receivedByOsr),

    // classification (H, I)
    ewcCode: toEwc(raw.ewcCode),
    descriptionWaste: toText(raw.descriptionWaste),

    // weights: the recompute inputs (K, L, M), the declared net (N), the
    // non-target contaminant weight (Q), and the recyclable proportion (R).
    // `arithmetic-integrity` recomputes net = gross − tare − pallet and flags
    // any load whose declared `net` does not reconcile.
    gross: toNumber(raw.gross),
    tare: toNumber(raw.tare),
    pallet: toNumber(raw.pallet),
    net: toNumber(raw.net),
    nonTargetWeight: toNumber(raw.nonTargetWeight),
    recyclableProportion: toNumber(raw.recyclableProportion),

    // chain tonnages (S, T, BK)
    tonnageReceivedForExport: toNumber(raw.tonnageReceivedForExport),
    tonnageExported: toNumber(raw.tonnageExported),
    tonnageReceivedByOsr: toNumber(raw.tonnageReceivedByOsr),

    // handling + destination (AC, BJ, BI)
    interimHandling: toText(raw.interimHandling),
    osrCountry: toText(raw.osrCountry),
    osrName: toText(raw.osrName),

    // refusal (AN)
    refused: toBool(raw.refused),

    // network entities (AH, AJ, BE)
    supplierName: toText(raw.supplierName),
    supplierPostcode: toText(raw.supplierPostcode),
    carrierVehicleReg: toText(raw.carrierVehicleReg),
  };

  return Object.freeze(load);
}

module.exports = { makeLoad, toText, toNumber, toDate, toBool, toEwc };
