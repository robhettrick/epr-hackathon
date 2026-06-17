# web/

The Hapi monolith and server-rendered UI (ADR-001).

- `server.js` — Hapi on a fixed port with `@hapi/vision` (Nunjucks) + `@hapi/inert` (govuk-frontend
  static assets); ingests the fixtures and runs the engine once into an in-memory result at boot
  (ADR-002, DB-free).
- `routes.js` + `views/` — detector list → per-detector ranked findings → finding detail →
  live threshold re-render via GET query params (golden-path steps 4–6, ADR-009). No client state.

Outermost layer of the C4 dependency rule (ADR C4): `web → engine/explain → detectors → model`.
