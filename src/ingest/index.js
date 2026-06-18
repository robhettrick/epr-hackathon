'use strict';

/**
 * ingest/index.js — the ingest entrypoint (golden-path step 1, PRD §4).
 *
 * `ingest(filePaths[])` is the public face of the ingest pipeline: hand it the
 * submission spreadsheets and it returns the single in-memory dataset the engine
 * fans the detectors out over. It composes the per-file steps built earlier:
 *
 *   parseFile()      → { rows (machine-keyed), reference, cover, warnings }  (one file)
 *   normalise()      → { loads (canonical Load[]), warnings }                (one file)
 *   ── ingest() concatenates Loads across files, merges reference lists ──   ← here
 *   deriveEntities() → { operators, suppliers, osrs, vehicles, countries }   (all files)
 *
 * Why entities are derived ONCE over the concatenated array rather than per file:
 * each entity's `loadIndexes` are indexes into the returned `loads`, and the
 * network detectors (single-supplier→many-operators) need a supplier/vehicle that
 * appears under loads from *different* files to surface a cross-operator entity.
 * Deriving per file would index into the wrong array and never span operators.
 *
 * Determinism (CLAUDE.md): files are processed in the order given and Loads are
 * concatenated in that order, so the same inputs always yield the same dataset —
 * the demo is reproducible. No live network here.
 *
 * Robustness (CLAUDE.md hard rule, ADR C3): partial data is fine. A bad *row* is
 * already a warning (parser/normaliser), never a throw. This entrypoint extends
 * the same stance to a bad *file*: an unreadable/not-xlsx path becomes a
 * `scope: 'file'` warning and the remaining files still ingest, rather than
 * aborting the whole run. Every warning is tagged with its source `file` so the
 * caller can trace it.
 */

const { parseFile } = require('./parser');
const { normalise } = require('./normalise');
const { deriveEntities } = require('./entity-derivation');
const { applyNetworkSeed } = require('./seed-overlay');

/**
 * Ingest one file: parse → normalise, tagging warnings with their source path.
 * Never rejects — a file that cannot be read yields zero loads, empty reference
 * lists, and a single `file` warning so the rest of the run continues.
 *
 * @param {string} filePath path to an .xlsx submission.
 * @returns {Promise<{loads: object[], reference: {allowedEwc: string[], allowedMaterials: string[]}, warnings: object[]}>}
 */
async function ingestOne(filePath) {
  try {
    const parsed = await parseFile(filePath);
    const { loads, warnings } = normalise(parsed);
    return {
      loads,
      reference: parsed.reference,
      warnings: warnings.map((w) => ({ ...w, file: filePath })),
    };
  } catch (err) {
    return {
      loads: [],
      reference: { allowedEwc: [], allowedMaterials: [] },
      warnings: [{ scope: 'file', file: filePath, message: `failed to read file: ${err.message}` }],
    };
  }
}

/**
 * Union `items` into `set` (insertion order preserved, blanks skipped). Used to
 * merge the per-file reference lists: both fixtures share the same Sheet1, so the
 * union is the de-duplicated set of every allowed value seen across submissions.
 */
function unionInto(set, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item !== null && item !== undefined && String(item).trim() !== '') {
      set.add(item);
    }
  }
}

/**
 * Ingest one or more submission files into the golden-path dataset.
 *
 * @param {string[]|string} [filePaths] paths to .xlsx submissions (≥2 on the
 *   golden path). A bare string is tolerated as a single-element list.
 * @param {{seedNetwork?: boolean|object}} [options] when `seedNetwork` is truthy,
 *   apply the deterministic network seed overlay (a shared supplier + vehicle
 *   across operators) before entities are derived — needed so the cross-operator
 *   network detector can fire on the full fixtures, which do not overlap naturally
 *   (`seed-overlay.js`). Pass an object to override the overlay's defaults. OFF by
 *   default: the curated demo set has its shared entity baked in, so the golden
 *   path / smoke test never seed.
 * @returns {Promise<{loads: object[], entities: object, reference: {allowedEwc: string[], allowedMaterials: string[]}, warnings: object[]}>}
 *   `loads` are canonical Loads concatenated in file order (each tagged with its
 *   operatorId/material); `entities` is the `{operators, suppliers, osrs,
 *   vehicles, countries}` map-set derived over all loads; `reference` is the
 *   merged allowed-list union; `warnings` is every parse/normalise/file warning,
 *   each tagged with its source `file`.
 */
async function ingest(filePaths = [], options = {}) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const warnings = [];

  if (paths.length === 0) {
    warnings.push({ scope: 'ingest', message: 'no files supplied to ingest' });
    return {
      loads: [],
      entities: deriveEntities([]),
      reference: { allowedEwc: [], allowedMaterials: [] },
      warnings,
    };
  }

  // Files are independent — parse/normalise them concurrently. Promise.all
  // preserves array order, so Loads concatenate deterministically in file order.
  const perFile = await Promise.all(paths.map(ingestOne));

  const collected = [];
  const allowedEwc = new Set();
  const allowedMaterials = new Set();
  for (const file of perFile) {
    collected.push(...file.loads);
    unionInto(allowedEwc, file.reference.allowedEwc);
    unionInto(allowedMaterials, file.reference.allowedMaterials);
    warnings.push(...file.warnings);
  }

  // Opt-in network seed: re-point a few loads per operator at one shared
  // supplier/vehicle so a cross-operator entity exists for the network detector.
  // Applied to the concatenated array (so the seed spans files) and before
  // derivation (so the shared entity's back-refs index the returned `loads`).
  const loads = options.seedNetwork
    ? applyNetworkSeed(collected, options.seedNetwork === true ? {} : options.seedNetwork)
    : collected;

  // Entities derive from the fully concatenated array so loadIndexes are valid
  // across files and a supplier/vehicle can span operators (network detectors).
  const entities = deriveEntities(loads);

  return {
    loads,
    entities,
    reference: {
      allowedEwc: [...allowedEwc],
      allowedMaterials: [...allowedMaterials],
    },
    warnings,
  };
}

module.exports = { ingest };
