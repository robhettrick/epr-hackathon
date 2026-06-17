# engine/

Orchestration over the detector registry.

- `orchestrator.js` — `run(data, ctx)` fans out over every enabled detector's `evaluate`,
  returns `{ detectorId → Finding[] }`. `shadow` detectors run but are marked not-surfaced;
  one detector throwing must not abort the run.
- `triage.js` — pure sort-by-score + severity tagging + threshold-driven surfacing, re-runnable
  per request for live re-rank (ADR-005/009).

Dependency rule (ADR C4): `engine → detectors → model`.
