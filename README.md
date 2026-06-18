# Spot the Anomaly

A compliance tool that ingests EPR packaging-waste submission spreadsheets, fans them out across
a registry of anomaly detectors, and presents **each detector's findings as its own scored,
triaged list** — with plain-English reasons — so a regulator investigates the highest-value cases
instead of comparing spreadsheets by eye.

Built for the Defra EPR hackathon (Brief 2). Node.js 20 · Hapi · GOV.UK Frontend · DB-free demo.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000  (boots on the curated demo fixtures, ~2s)
npm test           # 232 tests (node:test)
```

- `npm run dev` loads the **curated demo set** (`fixtures/demo/`, 100 loads, fast, legible).
- `FIXTURES=raw npm run dev` loads the **full real submissions** (`fixtures/*.xlsx`, ~2,000 loads)
  to show it scales.

## What it does (the golden path)

1. **Ingest** ≥2 submission spreadsheets → a canonical in-memory `Load[]` + derived entities
   (operators, suppliers, OSRs, vehicles, countries).
2. **Fan out** over every registered detector (no per-detector branching).
3. Each detector emits its own **ranked, severity-tagged list** of findings.
4. **Browse** the detectors and their findings; **drill into** a finding for its reason + evidence.
5. **Tune a threshold** and the list re-ranks live (server-side, shareable URLs).

## Architecture

Dependency direction points inward (`ingest → model → detectors → engine → web`):

```
.xlsx ─► ingest/ (parse → normalise → derive entities)
              │  canonical model (model/: Load, Entity, Finding)
              ▼
        detectors/ (self-registering Strategy plugins + runtime config)
              │
        engine/ (orchestrator fan-out → triage: rank + threshold)
              │
        web/ (Hapi + @hapi/vision Nunjucks + govuk-frontend; @hapi/inert assets)
```

Key decisions (full set in `specs/architecture-and-adrs.md`):

- **Single Hapi monolith, server-rendered GOV.UK Frontend** (ADR-001).
- **In-memory detection pipeline; no DB on the golden path.** PostgreSQL is reserved for optional
  durable state (analyst decisions, audit) behind a flag that is off by default (ADR-002).
- **Detectors are pure, deterministic, self-registering** with one `evaluate(data, ctx) → Finding[]`
  interface and a uniform `Finding` contract (ADR-004/005). Thresholds live in runtime config
  (ADR-006).
- **The LLM is a cached explainer only**, never a detector (ADR-007).

## The detector model — add one in one file

Every detector implements the same contract and self-registers; the orchestrator and UI are
generic, so a new detector automatically appears as a new list:

```js
const { register } = require('./registry');
const { makeFinding, SEVERITY, SUBJECT_TYPE } = require('../model/finding');

const MyDetector = {
  meta: { id: 'my-detector', title: '…', scope: SUBJECT_TYPE.LOAD,
          version: '1.0.0', enabled: true, shadow: false, config: { /* thresholds */ } },
  evaluate(data, ctx) {
    return data.loads.flatMap((load, i) => /* … */ [] );
  },
};
module.exports = register(MyDetector);
```

Drop the file in `src/detectors/` — `server.js` scans and imports the folder at boot, so there's
no wiring to change.

### Detectors — all five ★ are live

- `ewc-not-packaging` — EWC not a `15 01 xx` packaging code / off-list / hazardous
- `chain-mass-balance` — received ≥ exported ≥ received-by-OSR must reconcile
- `material-profile` — declared recyclable-% vs the material grade (keyed on material)
- `destination-plausibility` — implausible reprocessing destinations (country-scoped)
- `single-supplier→many-operators` — one supplier spanning multiple operators (network)

A **cached LLM explainer** (`src/explain/`) writes each finding's investigator-facing reason,
behind a flag that is **off by default** (per-detector stubs are used otherwise, keeping the demo
deterministic). Every finding is stamped with `runMeta` (detector + config version, data snapshot)
for reproducibility, and detectors carry a `shadow` flag for safe `shadow → live` promotion.
Further detectors (temporal, vehicle, refusal-rate, year-on-year, Companies House) are backlogged
in `IMPLEMENTATION_PLAN.md`.

## Data

- `fixtures/demo/` — curated demo set (2 operators × 50 loads) with one seeded anomaly cluster per
  ★ detector; expected counts in `fixtures/demo/README.md`.
- `fixtures/*.xlsx` — two real submissions (Aluminium + Fibre-based composite, 1,000 loads each).
- `reference/allowed-codes.json` — valid EWC codes (842), packaging subset (10), materials (41),
  extracted from the template's `Sheet1`.

## Layout

```
specs/   PRD + architecture/ADRs (what + how)
docs/    research, data scenarios, whiteboard mapping, this write-up set
src/     ingest · model · detectors · engine · web
test/    per-module unit tests + golden-path end-to-end smoke test
fixtures/ reference/
```

## Tests

`npm test` runs 232 tests (`node:test`), including `test/golden-path.test.js` — an end-to-end
smoke test that ingests the demo fixtures, runs the engine, and asserts **all five** ★ detectors'
top finding is their seeded headline anomaly.
