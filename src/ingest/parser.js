'use strict';

/**
 * ingest/parser.js — read ONE exporter submission (.xlsx) into raw rows +
 * reference lists + cover metadata, using `exceljs` (ADR-003).
 *
 * The exporter template v5.1 has a fixed three-sheet shape we care about:
 *
 *   - "Exported (sections 1, 2 and 3)" — the load data. Row 1 is the machine-name
 *     header (`EWC_CODE`, `NET_WEIGHT`, …), row 2 is the human header and row 3 is
 *     an "Example" row — BOTH skipped. Real data starts at row 4. The template
 *     ships with ~15k pre-formatted blank rows below the data: their dropdown
 *     cells read "Choose option" and their calc cells are formulas resolving to ""
 *     — these are NOT loads and are filtered out (see `isPlaceholder`).
 *   - "Sheet1" (hidden) — the authoritative reference lists. Row 1 = valid EWC
 *     codes, row 2 = valid materials, each prefixed by a "Choose option" dropdown
 *     placeholder that we drop.
 *   - "Cover" — operator/submission metadata in `__EPR_META_*` key cells, each
 *     with its value in the cell immediately to the right.
 *
 * This module only reads the sheet into raw, machine-header-keyed rows and pulls
 * the reference/cover data. Machine-header → canonical translation (`column-map`)
 * and type coercion (`model/load`) happen downstream in the normaliser (item D),
 * keeping each step single-purpose.
 *
 * Robustness (CLAUDE.md hard rule, ADR C3): a malformed *cell/row* must never
 * crash ingestion — per-row reads are guarded and surface a warning while the run
 * continues with partial data. A genuinely unreadable *file* (bad path, not an
 * xlsx) still rejects: that is the caller's (ingest entrypoint's) concern, not a
 * "bad row".
 */

const ExcelJS = require('exceljs');

const { MACHINE_HEADERS, OPTIONAL_HEADERS } = require('./column-map');

/** Sheet names in template v5.1. */
const DATA_SHEET = 'Exported (sections 1, 2 and 3)';
const REFERENCE_SHEET = 'Sheet1';
const COVER_SHEET = 'Cover';

/** Row 1 = machine headers; rows 2 (human header) and 3 (Example) are skipped;
 * data starts at row 4. */
const HEADER_ROW = 1;
const FIRST_DATA_ROW = 4;

/** Dropdown cells default to this label until an option is picked — it is a
 * placeholder, never real data, so it is treated as blank everywhere. */
const PLACEHOLDER = 'Choose option';

/** Cover-sheet metadata keys (template v5.1). The value sits in the cell to the
 * right of the key cell. */
const META_ACCREDITATION = '__EPR_META_ACCREDITATION_NUMBER';
const META_REGISTRATION = '__EPR_META_REGISTRATION_NUMBER';
const META_MATERIAL = '__EPR_META_MATERIAL';

/**
 * Flatten an exceljs cell value to a plain scalar, or `null` when the cell is
 * effectively blank. Dates are preserved as `Date` objects; formula cells yield
 * their cached `result`; rich-text / hyperlink cells yield their text. The
 * dropdown PLACEHOLDER and empty/whitespace strings collapse to `null` so neither
 * the "Choose option" label nor a formula-resolving-to-"" leaks into a Load.
 */
function readCell(cell) {
  let value = cell ? cell.value : null;
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'object') {
    // exceljs cell objects: formula ({formula,result}), rich text, hyperlink, error.
    if (value.error !== undefined) return null;
    if (value.result !== undefined && value.result !== null) value = value.result;
    else if (typeof value.text === 'string') value = value.text;
    else if (Array.isArray(value.richText)) value = value.richText.map((r) => r.text).join('');
    else return null; // formula with no cached result, or unknown shape → blank
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === PLACEHOLDER) return null;
    return value;
  }

  return value; // number, boolean, etc.
}

/** Build a machine-header → column-index map from the header row, trimming names.
 * Returns `{ headerIndex, missing }` where `missing` lists *required* mapped
 * headers absent from the sheet (so the normaliser/detectors degrade rather than
 * guess). Optional headers (column-map `OPTIONAL_HEADERS`) are excluded — a file
 * may legitimately omit them, so their absence is not worth a warning. */
function readHeaders(sheet) {
  const headerIndex = {};
  sheet.getRow(HEADER_ROW).eachCell((cell, colNumber) => {
    const name = readCell(cell);
    if (typeof name === 'string' && name.trim() !== '') {
      headerIndex[name.trim()] = colNumber;
    }
  });
  const missing = MACHINE_HEADERS.filter(
    (h) => !(h in headerIndex) && !OPTIONAL_HEADERS.includes(h),
  );
  return { headerIndex, missing };
}

/** Read Sheet1 row `rowNumber` into a de-placeholdered list of strings. */
function readReferenceRow(sheet, rowNumber) {
  const out = [];
  sheet.getRow(rowNumber).eachCell((cell) => {
    const value = readCell(cell);
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      out.push(String(value).trim());
    }
  });
  return out;
}

/**
 * Read the Cover sheet metadata. Scans every cell for the `__EPR_META_*` key
 * strings and takes the value from the cell immediately to the right (the
 * key→value horizontal offset varies between rows in the template).
 */
function readCover(sheet, warnings) {
  const meta = {};
  sheet.eachRow((row) => {
    row.eachCell((cell, colNumber) => {
      const value = readCell(cell);
      if (typeof value === 'string' && value.startsWith('__EPR_META_')) {
        const next = readCell(row.getCell(colNumber + 1));
        meta[value.trim()] = next === null ? null : String(next).trim();
      }
    });
  });

  const accreditationNumber = meta[META_ACCREDITATION] || null;
  const registrationNumber = meta[META_REGISTRATION] || null;
  const material = meta[META_MATERIAL] || null;
  // operatorId keys cross-operator detection; the accreditation number is the
  // stable per-operator identifier, falling back to registration if absent.
  const operatorId = accreditationNumber || registrationNumber || null;

  if (!operatorId) {
    warnings.push({ scope: 'cover', message: 'no operator id (accreditation/registration) found on Cover sheet' });
  }
  if (!material) {
    warnings.push({ scope: 'cover', message: 'no material found on Cover sheet' });
  }

  return { operatorId, accreditationNumber, registrationNumber, material };
}

/**
 * Parse one submission file.
 *
 * @param {string} filePath path to an .xlsx exporter submission.
 * @returns {Promise<{rows: object[], reference: {allowedEwc: string[], allowedMaterials: string[]}, cover: object, warnings: object[]}>}
 *   `rows` are machine-header-keyed raw rows (one per real load), `reference`
 *   holds the file's own allowed lists, `cover` holds operator/material metadata,
 *   and `warnings` records anything skipped or missing (never thrown).
 */
async function parseFile(filePath) {
  const warnings = [];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath); // genuine I/O / not-xlsx errors reject here

  // --- data rows ---
  const rows = [];
  const dataSheet = workbook.getWorksheet(DATA_SHEET);
  if (!dataSheet) {
    warnings.push({ scope: 'data', message: `data sheet "${DATA_SHEET}" not found` });
  } else {
    const { headerIndex, missing } = readHeaders(dataSheet);
    if (missing.length) {
      warnings.push({ scope: 'header', message: `mapped headers not found in sheet: ${missing.join(', ')}` });
    }
    const headerNames = Object.keys(headerIndex);

    for (let rowNumber = FIRST_DATA_ROW; rowNumber <= dataSheet.rowCount; rowNumber += 1) {
      try {
        const sheetRow = dataSheet.getRow(rowNumber);
        const raw = {};
        for (const name of headerNames) {
          const value = readCell(sheetRow.getCell(headerIndex[name]));
          if (value !== null) raw[name] = value;
        }
        // A real load has at least one mapped (canonical) value; fully-blank
        // template rows (all dropdowns "Choose option", calc cells empty) are
        // skipped silently — they are not bad rows, just unfilled.
        if (MACHINE_HEADERS.some((h) => h in raw)) {
          rows.push(raw);
        }
      } catch (err) {
        warnings.push({ scope: 'row', row: rowNumber, message: `failed to read row: ${err.message}` });
      }
    }
  }

  // --- reference lists (Sheet1) ---
  let reference = { allowedEwc: [], allowedMaterials: [] };
  const referenceSheet = workbook.getWorksheet(REFERENCE_SHEET);
  if (!referenceSheet) {
    warnings.push({ scope: 'reference', message: `reference sheet "${REFERENCE_SHEET}" not found` });
  } else {
    reference = {
      allowedEwc: readReferenceRow(referenceSheet, 1),
      allowedMaterials: readReferenceRow(referenceSheet, 2),
    };
    if (reference.allowedEwc.length === 0) {
      warnings.push({ scope: 'reference', message: 'no allowed EWC codes found on Sheet1 row 1' });
    }
    if (reference.allowedMaterials.length === 0) {
      warnings.push({ scope: 'reference', message: 'no allowed materials found on Sheet1 row 2' });
    }
  }

  // --- cover metadata ---
  let cover = { operatorId: null, accreditationNumber: null, registrationNumber: null, material: null };
  const coverSheet = workbook.getWorksheet(COVER_SHEET);
  if (!coverSheet) {
    warnings.push({ scope: 'cover', message: `cover sheet "${COVER_SHEET}" not found` });
  } else {
    cover = readCover(coverSheet, warnings);
  }

  return { rows, reference, cover, warnings };
}

module.exports = {
  parseFile,
  readCell,
  DATA_SHEET,
  REFERENCE_SHEET,
  COVER_SHEET,
  FIRST_DATA_ROW,
  PLACEHOLDER,
};
