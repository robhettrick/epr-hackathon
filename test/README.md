# test/

Run with `npm test` (`node --test`).

- `golden-path.test.js` — end-to-end smoke: ingest both fixtures → run engine → assert each ★
  detector returns its expected top finding, DB-free (PRD §4/§10).
- `*.test.js` — per-detector and per-module unit tests colocated by concern.
