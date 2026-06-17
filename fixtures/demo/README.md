# Curated demo fixture

Two small, **demo-friendly** exporter submissions with realistic chain tonnages and a
controlled set of seeded anomalies — one cluster per ★ detector. Use these for the demo and the
golden-path smoke test; use the full `../*.xlsx` files for the "and it scales to thousands" line.

They share the real template structure (same sheet names, machine headers, `Cover` meta,
`Sheet1` reference lists), so `ingest()` reads them with no code changes.

| File | operatorId | Material | Loads |
| --- | --- | --- | --- |
| `demo_exporter_AL.xlsx` | `E-ACC10001AL` | Aluminium | 50 |
| `demo_exporter_FB.xlsx` | `E-ACC10002FB` | Fibre-based composite | 50 |

Most rows are clean: packaging EWC (`15 01 04`/`15 01 05`), `received ≥ exported ≥ received-by-OSR`,
recyclable-% matching the material grade, plausible destinations. The seeds are deliberate.

## Expected detector results (assert these in the smoke test)

Verified by running the current detectors over both files via `ingest()`:

| Detector | Expected | Detail |
| --- | --- | --- |
| `ingest` | 100 loads, 2 operators, 0 warnings | |
| `ewc-not-packaging` | **5** findings | 2 hazardous (`15 01 10*`) → critical; 2 non-packaging (`20 03 01`) → high; 1 off-list (`XX 99 99`) → high |
| `chain-mass-balance` | **8** findings | 5 export-leg (T>S), 3 osr-leg (BK>T, no interim) — all critical |
| `single-supplier→many-operators` *(when built)* | **1** | "Shared Metals Recovery Ltd" (postcode `LS1 4AB`) across both operators — 7 loads (4 AL + 3 FB) |
| `material-profile` *(when built)* | **3** | "AAIG cans (97.5%)" / "drink cartons" rows declaring recyclable 0.30–0.35 |
| `destination-plausibility` *(when built)* | **3** | Tuvalu-TV, Nauru-NR (AL), Lesotho-LS (FB) |
| `temporal-logic` *(later)* | **1** | one AL load exported before it was received |
| `osr-refusal-rate` *(later)* | 3 refused loads | AL ×2, FB ×1 |
| `shared-vehicle-across-operators` *(later)* | **1** | reg `SH24RED` across both operators (4 loads) |

## Notes for the build loop
- **`operatorIds` and `loadIndexes` on entities are `Set`s, not arrays** — the
  `single-supplier→many-operators` detector must test `entity.operatorIds.size > 1` (not
  `.length`).
- Seeds sit on distinct rows so each detector's list stays legible (a seeded chain row still
  carries a valid packaging EWC, etc.).
- Point the golden-path smoke test at this folder, not the full fixtures, so assertions are
  small and stable.
