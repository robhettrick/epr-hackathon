# ingest/

Spreadsheet ingestion: `parser` → `normalise` → `entity-derivation`, fronted by `index.js`
(`ingest(filePaths[]) → { loads, entities, reference, warnings }`).

- Reads the `Exported (sections 1, 2 and 3)` sheet (row 1 = machine headers, skip rows 2–3),
  the `Sheet1` reference lists, and the `Cover` sheet metadata (ADR-003).
- Applies a declarative `column-map` to build canonical `Load` records from `../model`.
- Never throws on a bad row — collects parse warnings, partial data is fine (ADR C3).

Dependency rule (ADR C4): `ingest → model`. Depends inward only.
