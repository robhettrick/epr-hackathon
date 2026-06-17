# CLAUDE.md — build guardrails

Operational guardrails Ralph reads on every iteration. Short and concrete.

## What we're building
**Spot the Anomaly** — ingest EPR packaging-waste submission spreadsheets, fan out to a registry
of anomaly detectors, and present each detector's findings as its own scored, triaged list for a
regulator to investigate.

- Full spec: `specs/prd-brief-2-spot-the-anomaly.md`
- Architecture & constraints (ADRs): `specs/architecture-and-adrs.md`
- The **golden path** (PRD §4) is the ONLY thing that must work for the demo.

## Hard rules
- **Ship the golden path first** (PRD §4): ingest ≥2 files → fan-out over the registry →
  per-detector ranked lists → finding detail (reason + evidence) → live threshold re-render.
  Get that working end-to-end before anything else. Ugly-but-working beats pretty-but-broken.
- **Build only the ★ detector set first** (PRD §6): `ewc-not-packaging`, `chain-mass-balance`,
  `material-profile`, `destination-plausibility`, `single-supplier→many-operators`. Any other
  detector is "later" in `IMPLEMENTATION_PLAN.md` — don't implement it yet.
- **No scope creep.** If it's not on the golden path or the ★ set, add it to the plan as "later".
- **Deterministic demo.** No live network on the golden path. The LLM is a *cached explainer only*
  (temperature 0) with a stubbed per-detector fallback string. External lookups (Companies House
  etc.) sit behind a cache + feature flag, OFF by default.
- **Ingestion must never crash on a bad row** — collect and surface parse warnings; partial data
  is fine.
- **Small, atomic commits** (one concern each — the `/commit` skill enforces this).

## Tech defaults (per ADRs — don't deviate without reason)
- **Node.js 20**, single **Hapi** monolith: `@hapi/hapi` + `@hapi/vision` (Nunjucks views) +
  `@hapi/inert` (static), rendering **govuk-frontend** server-side. No SPA, no client state.
- **Detection pipeline is in-memory.** **PostgreSQL** is used ONLY for optional durable state
  (analyst confirm/dismiss, saved runs/audit) behind a feature flag that is **OFF by default**
  (ADR-002). The golden-path demo runs **DB-free**.
- **Spreadsheet ingest** via `exceljs` (or SheetJS `xlsx`): a config-driven column map from the
  template's machine headers → a canonical `Load` model; skip rows 2–3; read `Sheet1` reference
  lists (ADR-003).
- **Detectors** are pure, deterministic, self-registering Strategy plugins with one
  `evaluate(data, ctx) → Finding[]` interface and a uniform `Finding` contract; thresholds live in
  runtime config (ADR-004/005/006). Adding a detector = one file + `register()`.

## Build/run commands
- Install: `npm install`
- Dev server: `npm run dev`  (fixed port, e.g. 3000; DB-free by default)
- Test: `npm test`  (golden-path smoke test + per-detector unit tests)

## Definition of done
The demo script (PRD §10) runs start to finish without a manual fix, on the fixtures, DB-free.

## Data
- Fixtures in `fixtures/` — two real submissions: an **Aluminium** operator
  (`...AL...-b3c87758.xlsx`, a re-submission) and a **Fibre-based composite** operator
  (`...FB...xlsx`). See `fixtures/README.md`. Two materials → the material-profile detector must
  key on material, not assume aluminium.
- Network detectors need a **seeded shared entity** (supplier/vehicle) across files — synthetic
  data won't overlap naturally (see `fixtures/README.md`).
- Reference lists in `reference/allowed-codes.json` (already generated from the template's
  `Sheet1`): `ewcCodes` (842), `packagingEwcCodes` (10 × `15 01 xx`), `materials` (41). Don't
  regenerate.

## Reference (context, NOT specs — read for detail, don't treat as scope)
- `docs/anomaly-scenarios-from-sample.md` — exact field→detector mappings, real counts, reason codes
- `docs/whiteboard-scenarios-vs-data.md` — the team's user scenarios mapped to data support
- `docs/anomaly-detection-research.md` — detection methods, scoring/triage, extensibility patterns
