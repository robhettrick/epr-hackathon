# explain/

LLM explainer that fills `Finding.reason`, cached and stubbed so the golden path runs with no
network or keys (ADR-007).

- `stubs.json` — per-detector fallback reason strings.
- `cache/` — on-disk JSON keyed per finding (git-ignored).
- `llm.js` — temperature-0 call, invoked **only** when a feature flag is on; default path returns
  stub/cache. Output is structure-validated; submitted free-text is treated as data, never
  instructions.
- `index.js` — the layer `Finding.reason` is wired through.

Dependency rule (ADR C4): `explain → model` (consumed by `web`/`engine`, never the reverse).
