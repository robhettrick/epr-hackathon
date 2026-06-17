# Architecture & ADRs — Spot the Anomaly

> Architect's pass over `prd-brief-2-spot-the-anomaly.md`. Decisions are scoped for a
> 4-hour Ralph build **and** the regulator domain: pick the simple option, but leave the seam
> so the production-correct thing can slot in later. Drop alongside the PRD in `specs/`.

---

## 1. Component view

```
            ┌──────────────────────────────────────────────────────────┐
 .xlsx ──►  │  ingest/   parse → normalise → { loads[], entities{}, refs }│
 (n files)  └──────────────────────────────────────────────────────────┘
                                   │  canonical model (model/)
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  engine/   orchestrator: fan-out over registry            │
            │            ── runs each detector → Finding[] (its list)   │
            │            ── triage: sort by score, tag severity         │
            └──────────────────────────────────────────────────────────┘
                 ▲ detectors/ (registry + one file per detector + config)
                 │ explain/  (LLM explainer, cached; fills Finding.reason)
                                   │  results (per-detector lists)
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  web/   Hapi + @hapi/vision (Nunjucks) + @hapi/inert      │
            │         + govuk-frontend                                  │
            │         lists → finding detail → threshold re-render      │
            └──────────────────────────────────────────────────────────┘
            (persistence/ — optional Postgres for durable state, ADR-002)
```

### Suggested layout (helps Ralph keep concerns separate)
```
src/
  ingest/      parsers, column-map, normaliser, entity-derivation
  model/       Load, Entity, Finding types + factories
  detectors/   registry.js + <detector>.js (one per check) + config.json
  engine/      orchestrator.js, triage.js, (aggregate.js — stretch)
  explain/     llm.js (temp 0), cache/ (json on disk), stubs.json
  web/         server.js (Hapi), routes, views/ (nunjucks via vision), assets
  persistence/ (optional) db.js + migrations/ — Postgres, only if durable state needed
fixtures/      operator-*.xlsx (or .json)
reference/     allowed-codes.json (from Sheet1)
test/          golden-path smoke + per-detector unit tests
```

---

## 2. Architecture Decision Records

Format: Status · Context · Decision · Consequences · Alternatives.

### ADR-001 — Small single-process Hapi monolith, server-rendered with GOV.UK Frontend
**Accepted.**
**Context:** 4-hour build, one-command run, Defra-credible UI, deterministic demo. **Hapi is the
de-facto Defra Node stack**, so it's both a sound monolith choice and the consistency-correct one.
**Decision:** One Node.js 20 process running **Hapi** (`@hapi/hapi`), with **`@hapi/vision`**
rendering **Nunjucks** templates that use **govuk-frontend**, and **`@hapi/inert`** serving the
govuk static assets. No SPA, no microservices, no client-side framework.
**Consequences:** Fast to build; instantly credible; Defra-aligned; no API/CORS/build-pipeline
overhead; state stays on the server. Limited rich interactivity (acceptable — see ADR-009).
**Alternatives:** Express (fine, but Hapi matches Defra convention); GOV.UK Prototype Kit (faster
scaffold but opinionated/Express-based); React SPA + API (rejected for the timebox).

### ADR-002 — In-memory read model by default; PostgreSQL only for durable state
**Accepted.** *(Refines the PRD "no database" non-goal.)*
**Context:** ≤ a few thousand loads across a handful of files; determinism is paramount; but some
features (analyst confirm/dismiss, run history) genuinely need persistence.
**Decision:** The **detection pipeline stays in-memory** — parse spreadsheets/fixtures into arrays
at boot, compute findings, hold them in memory. This keeps the golden path deterministic and
DB-free. **PostgreSQL is the chosen store for any durable state** (confirm/dismiss decisions, saved
runs/`runMeta`, audit log) and is engaged **only when such a feature is enabled**, behind a
`persistence/` module and a feature flag, with migrations. If the flag is off (default demo), the
app runs with no DB.
**Consequences:** Determinism and one-command run preserved for the demo; a clean, real path to
persistence without rearchitecting; analyst-decision/audit features become possible (answers Q3).
Cost: a DB dependency when those features are on (provide via docker-compose / connection string).
**Alternatives:** Pure in-memory always (rejected — can't persist analyst decisions/audit);
SQLite (lighter, but Postgres is the stated standard and the production target); Postgres for the
read model too (rejected — needless setup/coupling for derived, recomputable data).

### ADR-003 — Spreadsheet ingestion via a config-driven column map → canonical model
**Accepted.**
**Context:** Real template has machine-name header row 1, a human row 2, an Example row 3, and a
reference `Sheet1`. Columns are stable but numerous; more materials/templates will appear.
**Decision:** Read with a spreadsheet lib (**exceljs** — clean npm install; SheetJS `xlsx` is an
equivalent alternative). Map the **machine header names** (`GROSS_WEIGHT`, `EWC_CODE`, …) to a
canonical `Load` via a declarative `columnMap`. Skip rows 2–3. Load `Sheet1` row 1/row 2 into
`reference.allowedEwc` / `allowedMaterials`.
**Consequences:** New template versions = edit the map, not the parser. Decouples detectors from
sheet layout.
**Alternatives:** Hard-code cell positions (brittle); infer schema (overkill).

### ADR-004 — Detectors are self-registering Strategy plugins with a uniform contract
**Accepted. (Core decision — this is the product.)**
**Context:** Extensibility is the stated core value; "add a scenario" must not mean a rewrite.
**Decision:** Every detector implements `evaluate(data, ctx) → Finding[]`, carries `static meta`
(`id, title, scope, version, enabled, shadow, config`), and **self-registers** in a central
registry. Detectors are **pure and deterministic** — no I/O, no shared mutable state, no LLM
calls. The orchestrator discovers and runs all `enabled` detectors; no `if/else` per detector.
**Consequences:** New detector = one file + `register()`; trivially unit-testable; parallelisable.
Forces discipline (pure functions, data via `ctx`).
**Alternatives:** Inline checks in the engine (rejected — the anti-pattern this brief exists to
avoid); external rules engine as the primary mechanism (deferred — see ADR-006).

### ADR-005 — Detector-local scoring; each detector owns its ranked list; aggregation deferred
**Accepted.**
**Context:** PRD wants 0–100 scores that rank lists and *optionally* combine. Cross-detector
score comparability is genuinely hard and not needed for the per-detector-list output.
**Decision:** Each detector emits a **detector-local** `score` (0–100) that need only be
**monotonic within that detector**, plus `severity` from a fixed enum (`low|medium|high|critical`).
The orchestrator sorts each detector's findings; it does **not** reinterpret or rescale scores.
Any combined per-subject score is a **separate pure function over `Finding[]`**, added later, with
its own calibration step.
**Consequences:** Detectors stay fully decoupled; no false precision from comparing unlike scores.
The "combined queue" remains a clean future addition, not a constraint on detector design.
**Alternatives:** Globally-normalised scores now (rejected — premature calibration, couples
detectors); raw scores only (rejected — UI needs a consistent rank/severity).

### ADR-006 — Thresholds & rules externalised as runtime config; rules-engine deferred behind it
**Accepted.**
**Context:** Board requirement: "make % configurable — differs by domain." Must not bake
thresholds into code.
**Decision:** Each detector's tunables live in `meta.config` (and a `detectors/config.json`),
namespaced per material/domain, **adjustable at runtime** (drives the demo's live re-rank).
Thresholds are passed in via `ctx`, never hard-coded. Keep config hand-rolled for now; a rules
engine (`json-rules-engine`, or GoRules/ZEN for decision tables) can later back the simple
"X > Y" detectors **behind the same `Detector` interface** without touching consumers.
**Consequences:** Configurability is structural; analysts tune without deploys; clear upgrade path.
**Alternatives:** Adopt a rules engine now (rejected — setup cost vs 4h; the interface seam means
no lock-out later); thresholds in code (rejected — violates the requirement).

### ADR-007 — LLM is a cached, offline explainer; never a detector; submitted text is untrusted
**Accepted.**
**Context:** Determinism is a demo guardrail; the research consensus is "LLM explains, statistics
decide"; submission free-text could carry prompt-injection.
**Decision:** Detectors decide deterministically. An `explain/` layer turns a tripped detector +
its evidence into `Finding.reason`, **temperature 0, cached to disk per finding**, with a
**stubbed per-detector fallback string** so the golden path runs with no network/keys. Any
profile tables (e.g. material → expected destinations) are **pre-computed offline and reviewed**,
stored as JSON. All submitted text is treated as data, never instructions; LLM output is
structure-validated.
**Consequences:** Demo can't fail on the model; reasons are reproducible; safe. Slightly less
"live AI" flash — mitigated by showing the cached reasons as first-class.
**Alternatives:** Live per-record LLM scoring (rejected — non-deterministic, slow, unsafe).

### ADR-008 — Reproducibility via run-stamping; evolvability via enabled/shadow flags
**Accepted.**
**Context:** Regulator context demands you can explain *why* and *with what logic* a case flagged;
detectors will change over time.
**Decision:** Every `Finding` carries `runMeta` (detector id+version, config hash, dataset
snapshot id, timestamp). Detectors carry `enabled` and `shadow` flags: `shadow` detectors run and
log but don't surface — giving a `shadow → live` promotion path and a one-line **backtest** (run
the registry over a historical dataset, since every detector shares one signature).
**Consequences:** Auditable, replayable flags; safe detector evolution. Negligible build cost.
**Alternatives:** None for the domain; omitting it would be a real gap even in a prototype.

### ADR-009 — Threshold interactivity via stateless server re-render, not client state
**Accepted.**
**Context:** The demo must show a threshold change re-ranking a list; determinism + no browser
storage.
**Decision:** Threshold/filter changes are **GET query params**; the server recomputes triage and
re-renders. Optional progressive-enhancement JS may submit on input, but the server is the source
of truth. No `localStorage`/client state.
**Consequences:** Simple, reproducible, shareable URLs encode state. A small latency per change
(fine). Re-running detectors per request is cheap (ADR-002/010); cache results and re-triage only.
**Alternatives:** Client-side re-rank (needs shipping findings to the browser + JS state —
rejected for the timebox/determinism).

### ADR-010 — External enrichment behind a cached provider interface, off by default
**Accepted (stretch).**
**Context:** Companies House / DVLA add real signal but are network dependencies.
**Decision:** Wrap any external lookup in a `Provider` interface with an on-disk cache and a
feature flag (default **off**). Enrichment results feed the same detector pipeline as just another
input.
**Consequences:** Golden path stays offline/deterministic; enrichment is additive, not load-bearing.
**Alternatives:** Direct API calls inline (rejected — couples the demo to the network).

---

## 3. Cross-cutting constraints (NFRs)

- **C1 Determinism:** no live network on the golden path; all external/LLM calls cached or
  stubbed. Same inputs → same screen, every time.
- **C2 One-command run:** `npm install && npm run dev` on a fixed port, **DB-free by default**.
  Postgres is required only when the persistence flag is on; provide it via docker-compose so the
  command stays one step. The golden-path demo must run without Postgres.
- **C3 Resilience of ingest:** a malformed row or file must never abort a run — collect and
  surface parse warnings; partial data is acceptable.
- **C4 Separation of concerns:** `ingest → model → detectors → engine → explain → web` are
  distinct modules; dependencies point inward (web/engine depend on model, not vice versa).
- **C5 Identity resolution is naive:** entities are keyed on a normalised string
  (lowercased/trimmed name, or postcode where present). Documented limitation; fuzzy/graph
  matching is out of scope.
- **C6 Testability:** detectors are pure → one unit test each; plus a golden-path smoke test that
  ingests fixtures and asserts each ★ detector's top finding.
- **C7 Performance envelope:** O(loads × detectors), in-memory; comfortable to ~10⁴ loads across
  files. No optimisation needed; do not prematurely add one.
- **C8 No browser storage / no client state** (follows from ADR-001/009).

---

## 4. Assumptions & open questions

- **A1** All submissions follow template v5.1 machine headers. *If versions differ, the column map
  gets a per-version variant.*
- **A2** Operator identity comes from the Cover sheet (accreditation/registration). Confirmed in
  the sample; assumed present in every file.
- **A3** "Customer" = overseas reprocessor (OSR). Confirm with the team — it changes which field
  backs detectors #6/#4.
- **Q1** Do you want the **combined per-subject score** promoted from stretch to core? (ADR-005
  keeps it deferred by default.)
- **Q2** Is a **reload/re-ingest route** wanted for the demo, or is boot-time load enough?
- **Q3** Persisting analyst **confirm/dismiss** decisions: now supported via the optional Postgres
  path (ADR-002). In or out of the golden path? (Default: out — flag off.)

---

## 5. What this constrains Ralph to build (in order)

1. `model/` + `ingest/` (column map, normalise, derive entities, load reference lists) — ADR-003.
2. `detectors/registry.js` + `Finding` factory + 2 trivial detectors — ADR-004/005.
3. `engine/orchestrator.js` + `triage.js` — fan-out, per-detector ranked lists.
4. `web/` Hapi routes + Nunjucks/govuk views: lists → detail → threshold query-param re-render — ADR-001/009.
5. Remaining ★ detectors + `explain/` cached reasons + stubs — ADR-007.
6. Run-stamping + shadow flag; one network detector across operators — ADR-008.
