# detectors/

Self-registering Strategy plugins, one file per check, plus the registry and runtime config.

- `registry.js` — `register(DetectorClass)` / `getEnabled()`; detectors self-register on import
  (ADR-004). No per-detector branching anywhere else.
- `config.json` + `config.js` — runtime thresholds merged over each detector's `meta.config`,
  namespaced per detector (ADR-006). Thresholds reach detectors via `ctx`, never hard-coded.
- `<detector>.js` — each exposes `static meta {id,title,scope,version,enabled,shadow,config}`
  and `async evaluate(data, ctx) → Finding[]`.

★ set first (PRD §6): `ewc-not-packaging`, `chain-mass-balance`, `material-profile`,
`destination-plausibility`, `single-supplier→many-operators`. Adding a detector = one file +
`register()`.

Dependency rule (ADR C4): `detectors → model`.
