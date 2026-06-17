# Whiteboard scenarios × the data we have
### Can the uploaded exporter file support each user scenario?

Transcribed from the team whiteboard ("Spot the Anomaly — make it easy to identify important
anomalies") and mapped against `exporter_E-ACC12245AL_E25SR500020912AL.xlsx`.

Two notes from the board frame everything:
- 🟨 *"Make % configurable — differs depending on domain"* → thresholds must be config-driven
  (this is the abstraction the architecture already plans for: rules + thresholds as data).
- 🟪 *"Don't have data for frequency of anomaly"* → you have **no labels / no base rates**. Correct
  instinct; it's why the detectors must be unsupervised/rule-based, not trained classifiers.

## The one constraint that decides most of this

The upload is **a single exporter's summary log** (one accreditation, 1,000 loads, material =
Aluminium). So:

- Scenarios that look **inside a submission** (a load, or this operator's pattern) → **supported now**.
- Scenarios about a **network across operators** (a supplier or customer touching *many*
  operators; two operators sharing a vehicle; the market "taking too much") → **need several
  operators' submissions**. The regulator holds these; you have one. Options: get 2–3 more
  exporter/reprocessor files, or synthesize a few, or demo the single-operator version and say
  "same engine, more data."

## Mapping table

| # | Scenario (sticky) | Data fields in the file | Supported? | Method / detector |
|---|-------------------|-------------------------|-----------|-------------------|
| 1 | AI knowing profiles of "material" operators | `DESCRIPTION_WASTE I`, `EWC H`, `RECYCLABLE_% R`, `OSR_COUNTRY BJ` | ✅ **Fully** | Profile + LLM-explainer: expected EWC/destinations/recyclable-% per material vs declared |
| 2 | EWC code for non-packaging | `EWC_CODE H` + allowed list in `Sheet1` | ✅✅ **Fully (strongest)** | Reference-list validation + rule. *987/1000 are non-packaging; 488 hazardous* |
| 3 | Countries taking too much of certain materials | `OSR_COUNTRY BJ`, `TONNAGE_RECEIVED_BY_OSR BK`, `S` | 🟡 **Partial** | Per-country tonnage concentration **within this operator** now; market-wide "too much" needs all operators. *172 distinct countries incl. Tuvalu/Nauru/Kiribati* |
| 4 | Same OSRs refusing loads | `WAS_THE_WASTE_REFUSED AN`, `OSR_NAME BI`, `OSR_ID Z` | 🟡 **Partial** | Refusal-rate per OSR computable in-file; "same OSR across operators" needs multi-operator data |
| 5 | Single supplier → too many operators | `SUPPLIER_NAME AH`, `POSTCODE AJ`, `EMAIL AK` | 🔴 **Needs more data** | Network/graph detector across operators. In-file proxy: supplier concentration & duplicate supplier identities |
| 6 | Single customer ← too many operators | `OSR_NAME BI` / `OSR_ID Z` | 🔴 **Needs more data** | Same as #5 but on the reprocessor side |
| 7 | Is this a legit vehicle? (reg plate) | `CARRIER_VEHICLE_REGISTRATION_NUMBER BE`, `CARRIER_NAME BC`, `CBD BD` | 🟡 **Partial** | UK plate **format/plausibility** check now; true "legit" needs DVLA (external, not available) |
| 8 | Are 2 operators claiming the same vehicles? | `BE` (+ `DATE_OF_EXPORT U`) | 🔴 **Needs more data** | Cross-operator vehicle reuse. In-file proxy: same plate on overlapping dates/sites |
| 9 | Compare received tonnes vs operator, YoY / seasonally | `TONNAGE_RECEIVED_FOR_EXPORT S`, dates `G/U/Y` | 🔴 **Needs prior period** | Changepoint / robust YoY. File is 2026-only; needs a prior-year submission. *In-file: monthly/seasonal distribution is analysable* |

✅ fully supported · 🟡 partial / single-operator proxy · 🔴 needs additional data

## What this means for the build

**Build these now — fully supported, high signal, zero labels:**
- **#2 EWC-not-packaging** — your single strongest, most explainable flag (reference list is in
  the file's `Sheet1`).
- **#1 material-operator profile** — declared recyclable-% vs the material grade (e.g. "97.5% AAIG
  cans" declaring ≤80%: all 348 such rows), plus EWC/destination plausibility. This is the
  "AI knowing profiles" sticky and your LLM-explainer showpiece.
- **#3 destination concentration** (within this operator) and **#4 OSR refusal-rate** — both
  aggregate cleanly from single-file fields.
- Plus the integrity checks already found: **chain mass-balance** (8 impossible rows) and
  **temporal logic** (107 + 107 rows) — these aren't on the board but are easy wins worth showing.

**Cross-operator scenarios (#5, #6, #8, market-wide #3/#4): same engine, more data.**
These are genuinely valuable and exactly what a regulator needs, but they're *network* detectors.
To demo them, add 2–3 more operators' submissions (real or synthesized) sharing some
suppliers/customers/vehicles, then run the same registry of detectors across the combined set.
Worth saying explicitly in the demo: "these run on the regulator's full population; here's the
single-operator slice."

**#7 vehicle & #9 YoY:** do the in-file proxy (plate format check; monthly distribution) and note
the external/temporal data you'd add (DVLA lookup; prior-year file).

## How this feeds the architecture

Each scenario is a `Detector` emitting the standard `Finding`. The board's *"make % configurable"*
note maps directly to **thresholds-as-config** per material/domain. Group them:

- **Intra-row / single-submission** (#1, #2, #3-in-file, #4-in-file, #7-format, + mass-balance,
  temporal) — build first.
- **Cross-operator network** (#5, #6, #8) — a graph/aggregation detector that runs over the
  combined population; gate behind "needs multi-operator data."
- **Cross-period** (#9) — changepoint detector; gate behind "needs prior submission."

## Suggested next step

I can generate a **combined fixture of 3 synthetic operators** (reusing real rows from this file
plus shared suppliers/customers/vehicles and a prior-year slice) so that *every* whiteboard
scenario — including the network and YoY ones — becomes demoable, not just the single-operator
subset. Pair that with the `reference/allowed-codes.json` from `Sheet1` and you can build all nine.
