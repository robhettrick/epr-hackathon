'use strict';

/**
 * ingest/normalise.js — turn one parsed submission into a canonical `Load[]`.
 *
 * This is the third step of the ingest pipeline (ADR-003), sitting between the
 * parser and entity derivation:
 *
 *   parseFile()  → { rows (machine-keyed), reference, cover, warnings }
 *   normalise()  → { loads (canonical Load[]), warnings }          ← here
 *   deriveEntities() / ingest() …
 *
 * For each parsed row it: (1) translates machine headers → canonical field names
 * via the column map, (2) tags on the file-level `operatorId` and `material` read
 * from the Cover sheet (these are NOT data columns — see column-map.js), and
 * (3) coerces every value to a typed, frozen `Load` via `makeLoad`. The Cover
 * tags are what let downstream network detectors attribute a load to its operator
 * (single-supplier→many-operators) and the material-profile detector key on the
 * operator's declared material.
 *
 * Robustness (CLAUDE.md hard rule, ADR C3): a malformed row must never crash
 * ingestion. `makeLoad`/`toCanonicalRow` are written not to throw, but the row
 * loop is still guarded so any unforeseen failure on one row becomes a warning
 * and the run continues with the remaining loads. Parser warnings are carried
 * through unchanged so the caller sees a single, complete warning list.
 */

const { toCanonicalRow } = require('./column-map');
const { makeLoad } = require('../model/load');

/**
 * Normalise one parsed submission into canonical Loads.
 *
 * @param {{rows?: object[], cover?: object, warnings?: object[]}} parsed
 *   the output of `parseFile` for a single file. `rows` are machine-header-keyed;
 *   `cover` carries `operatorId`/`material`; `warnings` (if any) are forwarded.
 * @returns {{loads: object[], warnings: object[]}} `loads` is a canonical
 *   `Load[]`, each tagged with the file's operatorId/material; `warnings`
 *   combines the parser's warnings with any row-level normalisation warnings.
 */
function normalise(parsed = {}) {
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const cover = parsed.cover || {};
  // Clone the incoming warnings so we never mutate the parser's array.
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice() : [];

  const operatorId = cover.operatorId != null ? cover.operatorId : null;
  const material = cover.material != null ? cover.material : null;

  const loads = [];
  rows.forEach((row, index) => {
    try {
      const canonical = toCanonicalRow(row);
      // Tag the file-level provenance before coercion so `makeLoad` types them
      // alongside the data fields. Cover values win — a data column must never
      // overwrite the operator/material identity of the submission.
      canonical.operatorId = operatorId;
      canonical.material = material;
      loads.push(makeLoad(canonical));
    } catch (err) {
      // Should not happen (the model coerces rather than throws), but a bad row
      // is a warning, never a crash.
      warnings.push({
        scope: 'normalise',
        row: index,
        message: `failed to normalise row: ${err.message}`,
      });
    }
  });

  return { loads, warnings };
}

module.exports = { normalise };
