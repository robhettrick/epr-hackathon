'use strict';

/**
 * ingest/entity-derivation.js — fold a canonical `Load[]` into derived entities.
 *
 * Fourth step of the ingest pipeline (ADR-003), after the normaliser and before
 * the ingest entrypoint concatenates files:
 *
 *   parseFile()        → { rows (machine-keyed), reference, cover, warnings }
 *   normalise()        → { loads (canonical Load[]), warnings }
 *   deriveEntities()   → { operators, suppliers, osrs, vehicles, countries }   ← here
 *   ingest()           → { loads, entities, reference, warnings }
 *
 * Entities are not present in the raw data — they are the recurring *things* the
 * network detectors reason over (an operator, a supplier, an overseas reprocessor,
 * a carrier vehicle, a destination country). This module groups loads by a stable
 * identity key (ADR C5, naive: a normalised string) and accumulates back-refs on
 * each entity: which loads mention it (`loadIndexes`) and which distinct operators
 * it appears under (`operatorIds`). The latter is exactly what the multi-operator
 * detector `single-supplier→many-operators` (item G) keys on.
 *
 * Identity choices per field (ADR C5, "name, or postcode where present"):
 *   operator  — operatorId (Cover provenance; the submission's own identity)
 *   supplier  — supplierPostcode where present, else supplierName (AJ → AH). The
 *               committed Entity model intends suppliers to prefer postcode over a
 *               free-text name; the name is kept as the display `label`.
 *   osr       — osrName (BI); no postcode field exists for the reprocessor
 *   vehicle   — carrierVehicleReg (BE)
 *   country   — osrCountry (BJ)
 *
 * A field with nothing to key on (blank → `identityKey` returns null) contributes
 * no entity for that load; the load still counts toward the other entity types.
 * This is pure and never throws: it only reads frozen Loads and builds Maps.
 */

const { ENTITY_TYPE, identityKey, makeEntity, addOccurrence } = require('../model/entity');

/**
 * Find-or-create the entity for one (field) occurrence and record the back-ref.
 *
 * Dedup is by `identityKey(key)`: the first load to mention an identity mints the
 * entity (and fixes its display `label`); later loads with the same key fold their
 * loadIndex/operatorId into it. An un-keyable value (blank) is skipped.
 *
 * @param {Map<string, object>} group the per-type Map<id, Entity>.
 * @param {string} type one of `ENTITY_TYPE`.
 * @param {{label: *, key: *}} ident display label + value to key on.
 * @param {number} loadIndex index of the contributing load in the `Load[]`.
 * @param {*} operatorId operator the load belongs to (null ⇒ not counted).
 * @returns {object|null} the entity, or null when there was nothing to key on.
 */
function upsert(group, type, { label, key }, loadIndex, operatorId) {
  const id = identityKey(key);
  if (id === null) return null; // nothing to key on — skip this field for this load
  let entity = group.get(id);
  if (entity === undefined) {
    entity = makeEntity({ type, label, key });
    group.set(id, entity);
  }
  addOccurrence(entity, { loadIndex, operatorId });
  return entity;
}

/**
 * Pick the first non-null/non-undefined value (a null-tolerant `??` over a list).
 * Loads use `null` for unset fields, so this prefers the leading present value.
 */
function firstPresent(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/**
 * Derive the network entities from a canonical `Load[]`.
 *
 * @param {object[]} [loads] canonical Loads (from `normalise`, possibly across files).
 * @returns {{operators: Map, suppliers: Map, osrs: Map, vehicles: Map, countries: Map}}
 *   one `Map<id, Entity>` per entity type, deduped by identity key. Iterate with
 *   `[...entities.suppliers.values()]`; look up with `entities.suppliers.get(id)`.
 */
function deriveEntities(loads = []) {
  const entities = {
    operators: new Map(),
    suppliers: new Map(),
    osrs: new Map(),
    vehicles: new Map(),
    countries: new Map(),
  };

  if (!Array.isArray(loads)) return entities;

  loads.forEach((load, index) => {
    if (!load) return; // a null/undefined slot contributes nothing
    const operatorId = load.operatorId;

    // operator — the submitting accredited exporter (Cover provenance)
    upsert(
      entities.operators,
      ENTITY_TYPE.OPERATOR,
      { label: operatorId, key: operatorId },
      index,
      operatorId,
    );

    // supplier — prefer postcode (AJ) as the key, fall back to name (AH); the name
    // (or postcode when no name) is the human-readable label.
    upsert(
      entities.suppliers,
      ENTITY_TYPE.SUPPLIER,
      {
        label: firstPresent(load.supplierName, load.supplierPostcode),
        key: firstPresent(load.supplierPostcode, load.supplierName),
      },
      index,
      operatorId,
    );

    // overseas reprocessor (OSR / "customer") — keyed on name (BI)
    upsert(
      entities.osrs,
      ENTITY_TYPE.OSR,
      { label: load.osrName, key: load.osrName },
      index,
      operatorId,
    );

    // carrier vehicle registration (BE)
    upsert(
      entities.vehicles,
      ENTITY_TYPE.VEHICLE,
      { label: load.carrierVehicleReg, key: load.carrierVehicleReg },
      index,
      operatorId,
    );

    // destination country (BJ)
    upsert(
      entities.countries,
      ENTITY_TYPE.COUNTRY,
      { label: load.osrCountry, key: load.osrCountry },
      index,
      operatorId,
    );
  });

  return entities;
}

module.exports = { deriveEntities };
