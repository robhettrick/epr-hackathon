# PRD / Ralph spec — Brief 2: Spot the Anomaly

> **Ralph spec.** Drop in `specs/`. One-line goal for `ralph plan -g`:
> **"Ingest EPR packaging-waste submissions, fan out to a registry of anomaly detectors, and produce per-detector scored, triaged lists for a regulator to investigate."**
>
> Golden path is §4. Everything else is enhancement. Keep the demo deterministic (cached LLM,
> no live dependency). UI = GOV.UK Design System. Stack = Node.js 20.

---

## 1. Summary

Regulators compare producer waste submissions by eye — submission vs submission, year vs year.
It's slow and anomalies slip through. This tool **ingests one or more submission spreadsheets,
runs every registered detector over the data, and presents each detector's findings as its own
ranked, scored, triaged list** with plain-English reasons, so a regulator works the
highest-value cases first instead of trawling.

The design priority is **extensibility**: adding a new anomaly check = adding one self-contained
detector that automatically appears as a new list. Detection logic, data, and thresholds are
separated so checks can change over time (the team's "make % configurable" requirement).

## 2. Users & goals

**Primary user:** a regulator / compliance officer reviewing accredited exporter & reprocessor
submissions.

**Goals**
- Turn raw submissions into a prioritised set of things worth investigating, with reasons.
- Let analysts tune sensitivity per material/domain without code changes.
- Make adding a new detector cheap, so the system grows with regulator knowledge.

**Non-goals (for the demo)**
- Real authentication, writing back to any source system, a trained ML classifier (no labels
  exist — see §9), production data volumes, full sector taxonomy.

## 3. Data we're working from

Real sample: `exporter_E-ACC12245AL_E25SR500020912AL.xlsx` — an EPR **exporter summary log**
(template v5.1, material = Aluminium), 1,000 load records on sheet *Exported (sections 1, 2 and
3)*; row 3 is an "Example" to skip; a hidden `Sheet1` holds the **authoritative valid EWC-code
and material lists** (use as a reference input). **Multiple submissions are available** — ingest
several operators' files to unlock the network detectors.

Per-load fields used by detectors: dates (`G` received-for-export, `U` export, `Y` received-by-OSR);
`H` EWC code; `I` material; weights `K/L/M/N/Q`; `R` recyclable %; chain tonnages `S` received-for-export,
`T` exported, `BK` received-by-OSR; `BJ` OSR country; `AN` refused; `BI/Z` OSR; `AH` supplier;
`BC/BE` carrier/vehicle.

## 4. Golden path (the ONE flow that must work for the demo)

1. **Ingest** ≥2 submission spreadsheets → normalise to a common `Load` record + derive
   `Entities` (operators, suppliers, customers/OSRs, vehicles, countries).
2. **Fan out**: the orchestrator runs every registered detector over the loads/entities.
3. **Each detector emits its own scored, triaged list** of `Finding`s, ranked high→low.
4. The UI shows the **list of detectors**, each with its ranked findings and a count.
5. **Drill into a finding** → reason code + the evidence (the figures/records that tripped it).
6. **Adjust a detector's threshold** (a slider/config) and see its list re-rank live —
   demonstrating "make % configurable".

Build 1→6 end-to-end before adding detectors beyond the demo set.

## 5. Architecture

```
spreadsheet(s) ─► Ingest/normalise ─► { loads[], entities{} }
                                          │
                                   Detector registry  (fan-out)
                       ┌──────────┬───────┴────────┬───────────────┐
                   row-level   entity-level   cross-period     external(stretch)
                       └──────────┴────────────────┴───────────────┘
                                          │  each detector → Finding[]
                                  Per-detector scored & triaged lists
                                          │
                                   GOV.UK review UI (lists → finding detail)
```

### 5.1 Detector contract (the abstraction)
Every detector — rule, statistical, or profile — implements one interface and self-registers.
Adding a detector = drop a file in `detectors/`, call `register()`. Nothing else changes.

```js
class Detector {
  static meta = {
    id: 'ewc-not-packaging',
    title: 'EWC code not a packaging code',
    scope: 'load',            // 'load' | 'entity' | 'period'
    version: '1.0.0',
    enabled: true, shadow: false,
    config: { /* thresholds live here, editable at runtime */ }
  };
  // returns Finding[] (its own list); orchestrator sorts by score desc
  async evaluate(data, ctx) { /* data = loads/entities; ctx = reference lists + config */ }
}
```

### 5.2 Finding contract (uniform output → generic UI + aggregation)
```js
{
  detectorId, version,
  subject: { type: 'load'|'operator'|'supplier'|'osr'|'vehicle'|'country', id, label },
  score,            // 0–100 normalised so lists rank and (optionally) combine
  severity,         // low | medium | high | critical
  reason,           // plain-English, investigator-facing
  evidence,         // the fields/records that justify it (drives the detail view)
  thresholdsUsed,   // echo of config used (auditability)
  runMeta           // detector+config version, dataset snapshot, timestamp
}
```

### 5.3 Triage
Within each list: rank by `score` desc; tag `severity`; thresholds in `meta.config` decide what
surfaces. Per the research, thresholds are set to **investigator capacity**, configurable per
material/domain. *(Stretch: an optional combined view aggregating each subject's findings into a
single 0–100 score — weighted across detectors.)*

## 6. Detector catalogue

**★ = in the demo golden-path set.** Scope shown in brackets.

**Row-level (single submission)**
- ★ **EWC-not-packaging** [load] — `H` not a `15 01 xx` packaging code / not in `Sheet1` list /
  hazardous `*`. *Strongest, most explainable; 987/1000 non-packaging, 488 hazardous in the sample.*
- ★ **Chain mass-balance** [load] — require `received-for-export ≥ exported ≥ received-by-OSR`
  (allow interim `AC`). *8 impossible rows in the sample.*
- **Temporal logic** [load] — export before received; OSR-received before export. *107 + 107 rows.*
- ★ **Material-profile mismatch** [load] — declared `R` vs the grade implied by `I`
  (e.g. "97.5% AAIG cans" declaring ≤80%: all 348 such rows). *LLM writes the reason.*
- **Arithmetic integrity** [load] — recompute `N` and `S`; flag formula overrides (tamper check).
- **Vehicle plate format** [load] — `BE` not a plausible UK reg.

**Entity-level (single or multi operator)**
- ★ **Destination plausibility & concentration** [country] — implausible/incapable destinations
  and over-concentration by tonnage. *172 countries incl. Tuvalu/Nauru/Kiribati in the sample.*
- **OSR refusal rate** [osr] — high share of `AN=Yes` for an overseas reprocessor.
- ★ **Single supplier → too many operators** [supplier] *(multi-submission)* — a supplier feeding
  an implausible number of operators / share of volume. *Justifies multi-file ingestion.*
- **Single customer ← too many operators** [osr] *(multi-submission)* — mirror of the above.
- **Shared vehicle across operators** [vehicle] *(multi-submission)* — same `BE` claimed by 2+
  operators on overlapping dates.

**Cross-period**
- **Year-on-year / seasonal swing** [period] — robust change in `S` vs a prior submission.

**External (stretch)**
- **Companies House** [supplier/operator] — overdue filings, dissolved-but-trading, director/PSC
  overlaps. Cache responses.

**Cross-cutting:** an **LLM explainer** turns any tripped detector + evidence into the `reason`
string. Temperature 0, cached per finding, with a stubbed per-detector fallback so the demo can't
fail on network/keys. The LLM never decides — detectors decide.

## 7. Ingestion notes
- Parse the *Exported (sections 1,2,3)* sheet; header is row 1 (machine names), skip rows 2–3.
- Load `Sheet1` reference lists into `ctx.reference` (`allowedEwc`, `allowedMaterials`).
- Normalise every file to the same `Load` shape; tag each with its `operatorId` (from the Cover
  sheet accreditation/registration) so entity-level detectors can span operators.
- Tolerate missing optional columns; never crash a run on one bad row (collect parse warnings).

## 8. Acceptance criteria
- [ ] Ingesting ≥2 spreadsheets yields a combined, normalised load set + derived entities.
- [ ] The orchestrator runs all `enabled` detectors and returns one ranked list per detector.
- [ ] Each of the ★ demo detectors fires on the sample/fixtures with correct counts.
- [ ] Every finding shows subject, score, severity, a plain-English reason, and evidence.
- [ ] Adjusting a detector's threshold re-ranks/filters its list without code changes.
- [ ] At least one detector is entity-level and **spans multiple operators** (network scenario).
- [ ] Adding a new detector requires only a new file + `register()` (demonstrate or document).
- [ ] LLM reasons are cached; pulling the network does not break the demo.

## 9. Data / fixtures plan
- Use the real exporter file + **2 synthesised operator files** that deliberately **share some
  suppliers, customers and vehicles** (to trip the network detectors) and include a **prior-year
  slice** (for YoY).
- Seed ~1 clear anomaly per ★ detector so each list has an obvious top hit.
- Keep schema identical to the real template; reference lists from `Sheet1`.
- No labels exist (the board's "don't have data for frequency of anomaly") → detectors are
  rule/profile/statistical, **not** trained classifiers.

## 10. Demo script (~2 min)
"Three operators' submissions go in." → Show the **list of detectors**, each with a count and a
ranked list. → Open **EWC-not-packaging**: top hit is a hazardous thermal code on 'packaging'
waste, with the reason. → Open **Destination plausibility**: aluminium to Tuvalu. → Open **Single
supplier → many operators**: one supplier feeding five operators across the three files — "you
can only see this because we ingested the whole population." → **Drag the threshold** on a
detector and watch its list re-rank. → Close: "Each scenario is one detector; adding the next is
one file — the system grows with what regulators learn."

## 11. Out of scope / stretch
**Out:** auth, write-back, trained ML, real Companies House/DVLA at runtime, full taxonomy.
**Stretch:** combined per-subject aggregate score; Companies House detector; YoY detector;
shadow-mode toggle to show `shadow → live` promotion; export a flagged-cases CSV.

## 12. Risks
- **Over-scope** — ship the 6-step golden path with the ★ set before any extra detector.
- **Synthetic-data artifacts** — the sample's `exported`/`received-by-OSR` columns look randomly
  generated; build fixtures with *deliberate* anomalies, don't rely on artifacts.
- **LLM determinism** — cache + stub; never let a live call gate the demo.
- **Ingestion fragility** — one malformed row must not kill a run.
