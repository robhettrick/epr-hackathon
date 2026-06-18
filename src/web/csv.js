'use strict';

/**
 * web/csv.js — a tiny, pure RFC-4180 CSV serialiser for the flagged-cases export
 * (PRD §11 stretch: "export a flagged-cases CSV").
 *
 * Deliberately knows NOTHING about findings — it serialises a list of plain
 * records against a column spec. The findings → records mapping lives in
 * `routes.js` alongside the other view-model builders (it reuses `describeValue`
 * to flatten detector-specific evidence), so this module stays a generic,
 * dependency-free seam that any future export can reuse.
 *
 * Escaping (RFC 4180): a field is wrapped in double quotes iff it contains a
 * quote, comma, CR or LF; embedded quotes are doubled. Rows are joined with CRLF
 * (the spec's line ending, and what Excel expects), with a trailing CRLF so the
 * file ends on a clean record boundary. `null`/`undefined` render as an empty
 * field — submission free-text is data, never markup, so nothing here interprets
 * a value, it only quotes it safely.
 *
 * Dependency rule (ADR C4): outermost `web` layer; depends on nothing.
 */

/**
 * Escape a single CSV field per RFC 4180. Non-string values stringify first;
 * `null`/`undefined` become an empty field.
 * @param {*} value
 * @returns {string}
 */
function escapeField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise `rows` to a CSV string against a column spec.
 *
 * @param {Array<{key: string, header: string}>} columns ordered columns; `header`
 *   is the column title, `key` the property read from each row.
 * @param {object[]} rows the records to serialise (a non-array degrades to none).
 * @returns {string} the CSV text — a header line, one line per row, CRLF-joined,
 *   with a trailing CRLF.
 */
function toCsv(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];

  const header = cols.map((c) => escapeField(c.header)).join(',');
  const lines = list.map((row) => cols.map((c) => escapeField(row[c.key])).join(','));

  return [header, ...lines].join('\r\n') + '\r\n';
}

module.exports = { toCsv, escapeField };
