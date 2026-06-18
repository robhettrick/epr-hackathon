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
| `ingest` | 130 loads, 2 operators, 0 warnings | 50 AL-2026 + 50 FB-2026 + 30 AL-2024 |
| `ewc-not-packaging` | **5** findings | 2 hazardous (`15 01 10*`) → critical; 2 non-packaging (`20 03 01`) → high; 1 off-list (`XX 99 99`) → high |
| `chain-mass-balance` | **8** findings | 5 export-leg (T>S), 3 osr-leg (BK>T, no interim) — all critical |
| `single-supplier→many-operators` *(when built)* | **1** | "Shared Metals Recovery Ltd" (postcode `LS1 4AB`) across both operators — 7 loads (4 AL + 3 FB) |
| `material-profile` *(when built)* | **3** | "AAIG cans (97.5%)" / "drink cartons" rows declaring recyclable 0.30–0.35 |
| `destination-plausibility` *(when built)* | **3** | Tuvalu-TV, Nauru-NR (AL), Lesotho-LS (FB) |
| `temporal-logic` *(seeded)* | **1** | one AL load exported before it was received |
| `shared-vehicle-across-operators` *(seeded)* | **1** | reg `SH24RED` across both operators (4 loads) |
| `vehicle-plate-format` *(seeded)* | **1** | one AL load with reg `NOTAPLATE` (not a valid UK plate) |
| `single-customer←many-operators` *(seeded)* | **1** | OSR "Global Reprocessing Ltd" across both operators — 5 loads (3 AL + 2 FB) |
| `osr-refusal-rate` *(seeded)* | "Global Reprocessing Ltd" elevated | that OSR has 2 of 5 loads refused (40%); other refused loads sit on single-load OSRs |
| `arithmetic-integrity` *(seeded)* | **1** | one AL load whose `NET_WEIGHT` ≠ `GROSS − TARE − PALLET` (off by 120 t) |
| `year-on-year-swing` *(seeded)* | **1** | AL operator's 2024 → 2026 received-for-export swing (the prior-year slice is in the default ingest) |

## Prior-year slice (for `year-on-year-swing`)
`demo_exporter_AL_2024.xlsx` — the **same operator** (`E-ACC10001AL`), 30 loads dated 2024 with
tonnages ~half of 2026, so a year-on-year comparison shows a clear swing. **Included in the
default ingest** (AL-2026 + FB-2026 + AL-2024 = 130 loads) so `year-on-year-swing` fires in the
UI. It carries only clean baseline rows (no other seeds), so the five ★ counts are unchanged.

## Notes for the build loop
- **`operatorIds` and `loadIndexes` on entities are `Set`s, not arrays** — the network detectors
  (`single-supplier→many-operators`, `single-customer←many-operators`,
  `shared-vehicle-across-operators`) must test `.size`, not `.length`.
- **`arithmetic-integrity` needs the model extended first.** The fixtures now carry
  `GROSS_WEIGHT`, `TARE_WEIGHT`, `PALLET_WEIGHT`, `WEIGHT_OF_NON_TARGET_MATERIALS`, but the
  column-map / `Load` model don't map them yet — add them to `column-map.js` + `load.js` before
  the detector can recompute `NET = GROSS − TARE − PALLET`. (This also closes the backlog item
  "map the interim-site flag / extra weight columns".)
- The new seeds sit on previously-clean rows, so the five ★ detector counts (5/8/3/3/1) are
  unchanged — keep it that way.
- Point the golden-path smoke test at this folder, not the full fixtures, so assertions are
  small and stable.
