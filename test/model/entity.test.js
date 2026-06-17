'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ENTITY_TYPE, identityKey, makeEntity, addOccurrence } = require('../../src/model/entity');

test('identityKey normalises case/whitespace so variants resolve to one key (ADR C5)', () => {
  // the plan's done-when: trimmed/cased variants of the same name are one entity
  assert.equal(identityKey(' Acme Ltd '), identityKey('acme ltd'));
  // internal whitespace is collapsed, not just trimmed
  assert.equal(identityKey('Acme   Metals\tLtd'), 'acme metals ltd');
  // coerces non-strings rather than throwing
  assert.equal(identityKey(12345), '12345');
});

test('identityKey returns null for empty/blank/absent input', () => {
  assert.equal(identityKey(''), null);
  assert.equal(identityKey('   '), null);
  assert.equal(identityKey(null), null);
  assert.equal(identityKey(undefined), null);
});

test('makeEntity keys on the label by default and preserves display case', () => {
  const e = makeEntity({ type: ENTITY_TYPE.SUPPLIER, label: ' Acme Metals Ltd ' });
  assert.equal(e.type, 'supplier');
  assert.equal(e.id, 'acme metals ltd'); // normalised identity key
  assert.equal(e.label, 'Acme Metals Ltd'); // trimmed but original case kept
  assert.ok(e.loadIndexes instanceof Set);
  assert.ok(e.operatorIds instanceof Set);
  assert.equal(e.loadIndexes.size, 0);
  assert.equal(e.operatorIds.size, 0);
});

test('makeEntity keys on an explicit key (e.g. postcode) when given, distinct from the label', () => {
  // suppliers can key on postcode while still showing the name (entity-derivation choice)
  const e = makeEntity({ type: ENTITY_TYPE.SUPPLIER, label: 'Acme Metals Ltd', key: 'M1 2AB' });
  assert.equal(e.id, 'm1 2ab');
  assert.equal(e.label, 'Acme Metals Ltd');
});

test('makeEntity with no spec yields an empty, mutable accumulator (not frozen)', () => {
  const e = makeEntity();
  assert.equal(e.type, null);
  assert.equal(e.id, null);
  assert.equal(e.label, null);
  // unlike Load, entities accumulate during derivation, so must not be frozen
  assert.equal(Object.isFrozen(e), false);
});

test('addOccurrence accumulates load + operator back-refs and dedupes', () => {
  const e = makeEntity({ type: ENTITY_TYPE.SUPPLIER, label: 'Acme' });

  addOccurrence(e, { loadIndex: 0, operatorId: 'E-ACC1AL' });
  addOccurrence(e, { loadIndex: 5, operatorId: 'E-ACC1AL' }); // same operator, new load
  addOccurrence(e, { loadIndex: 0, operatorId: 'E-ACC2FB' }); // dup load, new operator

  assert.deepEqual([...e.loadIndexes].sort(), [0, 5]);
  // a supplier under two operators is exactly what the network detector keys on
  assert.deepEqual([...e.operatorIds].sort(), ['E-ACC1AL', 'E-ACC2FB']);
});

test('addOccurrence ignores null/blank operatorId and non-integer load indexes', () => {
  const e = makeEntity({ label: 'Acme' });
  addOccurrence(e, { loadIndex: 1, operatorId: null });
  addOccurrence(e, { loadIndex: undefined, operatorId: '' });
  addOccurrence(e, {});

  assert.deepEqual([...e.loadIndexes], [1]);
  assert.equal(e.operatorIds.size, 0);
});
