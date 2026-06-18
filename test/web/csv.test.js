'use strict';

/**
 * Unit tests for the pure CSV serialiser (`src/web/csv.js`) that backs the
 * flagged-cases export (PRD §11 stretch). The serialiser is the seam that must
 * never corrupt a regulator's spreadsheet, so the escaping rules (RFC 4180) are
 * pinned here independently of the wired routes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { toCsv, escapeField } = require('../../src/web/csv');

describe('web/csv: escapeField (RFC 4180)', () => {
  test('leaves a plain value untouched', () => {
    assert.strictEqual(escapeField('plain'), 'plain');
    assert.strictEqual(escapeField(42), '42');
  });

  test('renders null/undefined as an empty field', () => {
    assert.strictEqual(escapeField(null), '');
    assert.strictEqual(escapeField(undefined), '');
  });

  test('quotes a value containing a comma', () => {
    assert.strictEqual(escapeField('a,b'), '"a,b"');
  });

  test('quotes and doubles embedded double-quotes', () => {
    assert.strictEqual(escapeField('say "hi"'), '"say ""hi"""');
  });

  test('quotes a value containing CR or LF', () => {
    assert.strictEqual(escapeField('line1\nline2'), '"line1\nline2"');
    assert.strictEqual(escapeField('a\r\nb'), '"a\r\nb"');
  });
});

describe('web/csv: toCsv', () => {
  const columns = [
    { key: 'a', header: 'Col A' },
    { key: 'b', header: 'Col B' },
  ];

  test('emits a header line then one CRLF-joined line per row, trailing CRLF', () => {
    const csv = toCsv(columns, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    assert.strictEqual(csv, 'Col A,Col B\r\n1,2\r\n3,4\r\n');
  });

  test('reads only the column keys, in column order (extra row keys ignored)', () => {
    const csv = toCsv(columns, [{ b: '2', a: '1', c: 'ignored' }]);
    assert.strictEqual(csv, 'Col A,Col B\r\n1,2\r\n');
  });

  test('escapes per field so a comma in a value cannot shift columns', () => {
    const csv = toCsv(columns, [{ a: 'x,y', b: 'z' }]);
    assert.strictEqual(csv, 'Col A,Col B\r\n"x,y",z\r\n');
  });

  test('a missing row property becomes an empty field', () => {
    const csv = toCsv(columns, [{ a: '1' }]);
    assert.strictEqual(csv, 'Col A,Col B\r\n1,\r\n');
  });

  test('no rows still emits the header line', () => {
    assert.strictEqual(toCsv(columns, []), 'Col A,Col B\r\n');
  });

  test('non-array inputs degrade rather than throw', () => {
    assert.strictEqual(toCsv(null, null), '\r\n');
  });
});
