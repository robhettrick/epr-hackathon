'use strict';

/**
 * model/entity.js — derived network entities + naive identity resolution.
 *
 * An `Entity` is a thing that recurs across loads and that the network detectors
 * reason over: an operator, a supplier, an overseas reprocessor (OSR), a carrier
 * vehicle, or a destination country. Entities are not present in the raw data —
 * they are *derived* from `Load[]` by `src/ingest/entity-derivation.js` (next
 * item), which groups loads by a stable identity key and accumulates back-refs.
 *
 * Like `Load`, this is an innermost domain type (ADR C4): pure data + factories,
 * no dependencies on other `src/` modules.
 *
 * Identity resolution is deliberately NAIVE (ADR C5): an entity is keyed on a
 * single normalised string — a lowercased/trimmed name, or a postcode where the
 * caller has one. There is no fuzzy or graph matching; that is out of scope. The
 * caller (entity-derivation) decides *which* value to key on (e.g. prefer a
 * supplier postcode over a free-text name); `identityKey` only normalises it.
 */

/** The kinds of entity the ★ / network detectors reason over (item C / G). */
const ENTITY_TYPE = Object.freeze({
  OPERATOR: 'operator', // submitting accredited exporter (Cover sheet)
  SUPPLIER: 'supplier', // who the waste was received from (AH / AJ)
  OSR: 'osr', // overseas reprocessor / "customer" (BI / BJ)
  VEHICLE: 'vehicle', // carrier vehicle registration (BE)
  COUNTRY: 'country', // destination country (BJ)
});

/**
 * Normalise a name or postcode to a stable identity key (ADR C5).
 * Lowercases, trims, and collapses internal whitespace so that cosmetic
 * variants of the same string resolve to the same entity. Returns `null` for
 * empty/blank input so callers can skip un-keyable loads rather than minting a
 * bogus "" entity.
 *
 * @param {*} value raw name/postcode (any coercible value).
 * @returns {string|null} the identity key, or null when there is nothing to key on.
 */
function identityKey(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  return key === '' ? null : key;
}

/**
 * Build a derived `Entity` accumulator.
 *
 * Unlike `Load`, an Entity is NOT frozen: entity-derivation mutates its back-ref
 * sets as it folds over the loads (use `addOccurrence`). The factory seeds the
 * identity (`id`) and a human-readable `label`; the back-refs start empty.
 *
 * @param {object} [spec]
 * @param {string} [spec.type] one of `ENTITY_TYPE`.
 * @param {*} [spec.label] human-readable display name (first value seen wins).
 * @param {*} [spec.key] value to key on; defaults to `label` when omitted (the
 *   common case is name === key; suppliers may pass a postcode here instead).
 * @returns {object} an Entity record: `{ type, id, label, loadIndexes, operatorIds }`.
 */
function makeEntity({ type = null, label = null, key = undefined } = {}) {
  const id = identityKey(key === undefined ? label : key);
  return {
    type,
    id,
    label: cleanLabel(label),
    loadIndexes: new Set(), // indexes into the ingested Load[] that mention this entity
    operatorIds: new Set(), // distinct operators this entity appears under (network detectors)
  };
}

/**
 * Record that `entity` was seen on one load. Idempotent per (loadIndex) and per
 * (operatorId); a null operatorId is ignored. This is the single place that
 * maintains the Entity back-ref invariants so entity-derivation stays simple.
 *
 * @param {object} entity an Entity from `makeEntity`.
 * @param {object} occurrence
 * @param {number} [occurrence.loadIndex] index of the contributing load.
 * @param {string} [occurrence.operatorId] operator the load belongs to.
 * @returns {object} the same entity, for chaining.
 */
function addOccurrence(entity, { loadIndex, operatorId } = {}) {
  if (Number.isInteger(loadIndex)) entity.loadIndexes.add(loadIndex);
  if (operatorId !== null && operatorId !== undefined && operatorId !== '') {
    entity.operatorIds.add(operatorId);
  }
  return entity;
}

/** Trim a label, preserving its original case; blank → null. */
function cleanLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

module.exports = { ENTITY_TYPE, identityKey, makeEntity, addOccurrence };
