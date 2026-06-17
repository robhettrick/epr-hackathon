# Fixtures — sample submissions

Real EPR exporter "summary log" spreadsheets (template v5.1) used to build and test ingestion
and the detectors. Each has the same sheet structure: data on *Exported (sections 1, 2 and 3)*
(header row 1 = machine names, rows 2–3 are human header + Example → skip), and a hidden
`Sheet1` holding the authoritative valid EWC-code and material lists.

| File | Operator (accreditation / reg) | Material | Loads | Role |
| --- | --- | --- | --- | --- |
| `exporter_E-ACC12245AL_E25SR500020912AL-b3c87758.xlsx` | `E-ACC12245AL` / `E25SR500020912AL` | Aluminium | 1,000 | Aluminium operator (this is a re-submission of the original AL log — use for re-submission / year-on-year comparison) |
| `exporter_E-ACC12245FB_E25SR500020912FB.xlsx` | `E-ACC12245FB` / `E25SR500020912FB` | Fibre-based composite | 1,000 | A distinct operator + material — unlocks cross-operator and cross-material detectors |

## Notes for ingestion
- Tag every load with its `operatorId` from the **Cover** sheet
  (`__EPR_META_ACCREDITATION_NUMBER` / `__EPR_META_REGISTRATION_NUMBER`) so entity-level
  detectors can span operators.
- Material is on the Cover sheet (`__EPR_META_MATERIAL`); per-load grade is in `DESCRIPTION_WASTE`.
- Two materials are now represented (Aluminium, Fibre-based composite), so the
  **material-profile** detector must key its expected profile on material, not assume aluminium.

## Known limitations (synthetic data)
- These are realistic templates filled with synthetic (faker-style) data. Suppliers, carriers,
  vehicles and OSRs are **unlikely to overlap naturally across files**, so the **network
  detectors** (single-supplier→many-operators, shared-vehicle-across-operators) will need a
  **seeded shared entity** to fire convincingly in the demo — e.g. inject one supplier (or one
  vehicle reg) into a handful of loads in both files.
- The auto-calculated fields reconcile exactly, and `exported` / `received-by-OSR` look randomly
  generated — see `docs/anomaly-scenarios-from-sample.md`. Seed deliberate anomalies for the demo
  rather than relying on artifacts.

## Still to add
- `reference/allowed-codes.json` — valid EWC codes + materials extracted from `Sheet1`
  (powers the EWC-not-packaging and material-validity detectors).
