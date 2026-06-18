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

## Add a detector = one file + `register()`

1. Create `src/detectors/<your-id>.js` from the skeleton below.
2. (Optional) add a `"<your-id>"` threshold namespace to `config.json`.
3. That's it — `server.js` scans this folder at boot, so the detector self-registers, the
   orchestrator fans out to it, and it appears as a new ranked list in the UI. No edits to the
   engine, web, or any other file.

```js
'use strict';

const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

const MyDetector = {
  meta: {
    id: 'my-detector',                 // unique; also the config.json namespace + URL segment
    title: 'Human-readable detector title',
    scope: SUBJECT_TYPE.LOAD,          // LOAD | OPERATOR | SUPPLIER | OSR | VEHICLE | COUNTRY
    version: '1.0.0',                  // bump on any logic/threshold change (feeds runMeta)
    enabled: true,
    shadow: false,                     // true = runs + logs but never surfaces (shadow → live)
    config: { threshold: 0 },          // defaults; overridden by config.json at runtime
  },

  // Pure & deterministic: read frozen loads/entities + ctx, return Finding[]. No I/O, no LLM
  // (the explainer owns reasons), no mutation. ctx = { config, reference }.
  evaluate(data, ctx = {}) {
    const cfg = ctx.config || MyDetector.meta.config;
    const findings = [];
    data.loads.forEach((load, i) => {
      if (/* your condition using cfg.threshold */ false) {
        findings.push(makeFinding({
          detectorId: MyDetector.meta.id,
          version: MyDetector.meta.version,
          subject: { type: SUBJECT_TYPE.LOAD, id: i, label: `Load #${i}` },
          score: 80,                   // detector-local 0–100, monotonic within this detector
          severity: SEVERITY.HIGH,
          reason: 'Plain-English fallback (the explainer may override this).',
          evidence: { /* the figures that justify it — drives the detail view */ },
          thresholdsUsed: { threshold: cfg.threshold },
        }));
      }
    });
    return findings;
  },
};

module.exports = register(MyDetector);
```

Notes:
- **Entity-scoped detectors** read `data.entities` (Maps of derived entities); `operatorIds` and
  `loadIndexes` are `Set`s — use `.size`, not `.length`.
- **Scores are detector-local** — they only need to rank *within* this detector (ADR-005).
- Add a unit test in `test/detectors/<your-id>.test.js`; extend `test/golden-path.test.js`'s
  `EXPECTED` table if it should be covered end-to-end.
- Promote a shadow detector by flipping `shadow: false` — nothing else changes.
