# model/

Canonical domain types + factories, shared across layers:

- `load.js` — `Load` (one export load) + `makeLoad(raw)`.
- `entity.js` — `Entity` + `identityKey(value)` naive identity resolution (ADR C5).
- `finding.js` — the uniform `Finding` contract + `makeFinding({...})` (PRD §5.2).

Pure data and factories with no dependencies on other `src/` modules — the innermost layer
of the C4 dependency rule (ADR C4).
