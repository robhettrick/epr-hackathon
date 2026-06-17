# Anomaly-detection scenarios, grounded in the exporter sample
### `exporter_E-ACC12245AL_E25SR500020912AL.xlsx`

A data-scientist's read of a real EPR submission file, turned into a concrete catalogue of
detectable anomalies — each mapped to the actual columns, a detection method, what it found in
*this* file, and an investigator-facing reason code.

---

## 1. What the file is

An **EPR packaging-waste EXPORTER "summary log"**, template v5.1, material = **Aluminium**
(accreditation `E-ACC12245AL`, registration `E25SR500020912AL`). The sheet *Exported
(sections 1, 2 and 3)* holds **1,000 load records** (row 4 onward; row 3 is a worked
"Example"). Each row is one load of UK packaging waste received for export and sent to an
approved overseas reprocessor (OSR).

Key fields per load: dates (received-for-export `G`, export `U`, received-by-OSR `Y`); `EWC_CODE`
`H`; material `DESCRIPTION_WASTE` `I`; weights (`GROSS K`, `TARE L`, `PALLET M`, `NET N`,
non-target `Q`); `RECYCLABLE_PROPORTION R`; the three chain tonnages (`received-for-export S`,
`exported T`, `received-by-OSR BK`); destination `OSR_COUNTRY BJ`; plus supplier, carrier,
weighbridge, bill-of-lading and customs references. A reference sheet (`Sheet1`) holds the
**authoritative dropdown lists** — every valid EWC code (row 1) and every valid material
description (row 2). That list is itself a detector input.

---

## 2. How I analysed it (method)

Step by step, the same order I'd use on any unfamiliar regulatory dataset:

1. **Map the schema** — dumped the machine header row, identified the auto-calculated fields and
   the chain relationships (what *should* equal what).
2. **Profile distributions** — min/median/max on every numeric column to learn the "normal"
   shape and spot impossible ranges.
3. **Test the internal arithmetic** — recomputed `NET = GROSS − TARE − PALLET` and
   `S = (NET − non-target) × recyclable %` (with the 0.15% baling-wire deduction) to see whether
   declared totals reconcile.
4. **Test the chain mass-balance** — does `received-for-export ≥ exported ≥ received-by-OSR`?
5. **Test temporal logic** — can a load be exported before it was received, or arrive at the OSR
   before it left?
6. **Validate against reference lists** — are EWC codes and materials drawn from the allowed
   lists, and are they consistent with "aluminium packaging waste"?
7. **Plausibility / profile checks** — do destinations and material grades make sense?
8. **Duplicate / linkage checks** — repeated weighbridge tickets, containers, references.

---

## 3. Data reality check (read this before trusting any single number)

This is a **realistic template populated with synthetic data** (faker-style company names and
emails). Two consequences matter for the demo:

- **The auto-calculated fields are perfectly consistent** — `NET` and `S` reconcile to the
  formula in **all 1,000 rows (zero residual)**. That's expected: the spreadsheet computes them.
  The point of an arithmetic-integrity detector is to catch the row where someone **overrode the
  formula** — so you must *seed* a tampered row to demo it.
- **Some columns look randomly generated**, notably `exported T` and `received-by-OSR BK`
  (both uniform ~1–5 t regardless of load size). That produces spectacular but *artificial*
  mass-balance violations. They're perfect for **illustrating** the detector, but don't present
  them as discovered fraud.

**Recommendation:** use this file to prove the detectors *fire on real columns*, but build a
small **controlled fixture** with a handful of deliberately, realistically seeded anomalies for
the actual demo (see §6).

---

## 4. The scenario catalogue

Severity = regulatory seriousness. "Found here" = what the 1,000 rows actually contain.
Method ties back to the research briefing (`anomaly-detection-research.md`).

| # | Scenario | Columns | Method | Found in this file | Severity |
|---|----------|---------|--------|--------------------|----------|
| A1 | Net weight doesn't reconcile to gross−tare−pallet | K,L,M,N | Rule (intra-row) | 0 / 1000 (auto-calc; seed to demo) | High |
| A2 | Export tonnage doesn't reconcile to net×recyclable% | N,Q,R,O,S | Rule (intra-row) | 0 / 1000 (auto-calc; seed) | High |
| B1 | **Mass-balance broken across the chain** (received-for-export ≥ exported ≥ received-by-OSR) | S,T,AC,BK | Rule (cross-field) | **8 rows export > received**; chain nonsensical throughout | Critical |
| C1 | Exported **before** received for export | G,U | Rule (temporal) | **107 / 1000** | High |
| C2 | Arrived at OSR **before** it was exported | U,Y | Rule (temporal) | **107 / 1000** | High |
| D1 | **EWC code is not a packaging code** (should be `15 01 xx`) | H + Sheet1 | Reference-list validation | **987 / 1000** are non-packaging chapters | High |
| D2 | Hazardous EWC code on packaging waste | H | Rule / reference | **488 / 1000** starred (hazardous) | Critical |
| D3 | Material/EWC not in the allowed dropdown list | H,I + Sheet1 | Reference-list validation | list available; seed an off-list value | Medium |
| E1 | **Material grade vs declared recyclable % mismatch** (e.g. "AAIG cans (97.5%)" but R≤0.80) | I,R | Profile / rule | **all 348** "97.5%" rows report R ≤ 0.80 | Medium |
| E2 | **Implausible reprocessing destination** for UK aluminium | BJ | Profile + LLM-explainer + external (OECD/Basel) | Samoa, Tuvalu, Nauru, Kiribati, Djibouti, Lesotho, Haiti, Yemen all present; **172 distinct countries** | High |
| F1 | **Duplicate weighbridge ticket** (same load counted twice) | AV (+G,K) | Duplicate/linkage | **1 repeated value** | High |
| F2 | Container/trailer reused on impossible dates | X,U | Duplicate/linkage | 0 here; seed | Medium |
| G1 | Net-weight statistical outlier vs peer loads | N | Robust z-score / MAD | distribution clean here; demo on fixture | Low–Med |
| G2 | Recyclable-% outlier within a material cohort | R, grouped by I | Peer-group (MAD within cohort) | viable — R spans 0.05–0.80 | Medium |
| H1 | Supplier/carrier not a live company | AH,BC,BD | External (Companies House) | needs API; cache for demo | Medium |
| H2 | Year-on-year tonnage swing for this exporter | S (vs prior period) | Changepoint / robust YoY | needs prior-year file | High |

### Detail on the headline scenarios

**B1 — Chain mass-balance (the #1 regulator check).** Physically, the tonnage *received for
export* must be ≥ the tonnage *exported* must be ≥ the tonnage *received by the overseas
reprocessor* (allowing for documented interim-site handling, col `AC`). In this file, `exported`
and `received-by-OSR` sit at ~1–5 t while `received-for-export` has a median of ~78 t, and **8
loads claim more exported than was ever received** — impossible. This is the most important and
most explainable detector: it needs no model, just the chain inequality, and the reason code
writes itself.
*Reason code:* "Load #1042 reports 4.7 t exported but only received 253.7 t for export, and the
overseas reprocessor recorded 1.9 t — the chain does not reconcile (Δ flagged)."

**C1/C2 — Temporal logic.** ~11% of loads have `date_of_export` earlier than
`date_received_for_export`, and another ~11% arrive at the OSR before they were exported.
Deterministic, zero-label, high-confidence.
*Reason code:* "Export date 08 Feb 2026 precedes the date the waste was received for export
(16 Feb 2026)."

**D1/D2 — EWC code validity.** A UK *packaging-waste* aluminium log should carry EWC `15 01 04`
(metallic packaging) or another `15 01` code. Yet only **13 / 1,000** rows use a `15` packaging
code; the rest are spread across mining (`01`), chemical (`06/07`), thermal (`10`) and
waste-management (`19`) chapters, and **488** carry the hazardous `*` marker. Validate `H`
against the allowed list in `Sheet1` *and* against the "is this a packaging code" rule.
*Reason code:* "EWC `10 03 21*` is a hazardous thermal-process code, not a packaging code
(expected `15 01 xx`) for an aluminium packaging-waste export."

**E2 — Destination plausibility (the LLM-explainer's moment).** UK aluminium packaging waste
plausibly goes to reprocessors in a relatively small set of countries. A spread across **172
destinations** including small island states with no aluminium-reprocessing capacity (Tuvalu,
Nauru, Kiribati, Samoa) is implausible and Basel-relevant. This is the scenario where a
pre-computed "expected destinations for this material" profile + an LLM rationale shines — and it
can be cross-checked against the OECD-country / Basel control lists.
*Reason code:* "Destination Tuvalu-TV has no known aluminium reprocessing capacity; 14 loads
were declared to small-island states with no OSR infrastructure."

**E1 — Grade vs proportion mismatch.** The material description encodes an expected recyclable
grade (e.g. "AAIG aluminium cans (97.5%)"). All 348 rows declaring that 97.5% grade report a
recyclable proportion of **≤ 0.80** — internally inconsistent. A neat cross-field plausibility
check that needs only the two columns.

---

## 5. How these map to your architecture

Each scenario is a **`Detector`** emitting the standard **`Finding`** from the research briefing.
Grouped by detector family so they share code:

- **Intra-row rule detectors** (A1, A2, B1, C1, C2, D2, E1) — pure functions over one row;
  trivial, deterministic, the bulk of your value. Express thresholds in JSON config.
- **Reference-list validators** (D1, D3) — load the allowed EWC/material lists from `Sheet1`
  into a set; membership + "is-packaging-code" test.
- **Cohort / peer-group detectors** (G1, G2) — group by material, apply MAD/robust-z *within*
  the cohort.
- **Profile + LLM-explainer** (E2) — deterministic flag against a pre-computed expected-profile
  table; LLM writes the human reason (cached, temperature 0).
- **External cross-reference** (H1, E2) — Companies House for supplier/carrier; OECD/Basel list
  for destinations. Cache responses for a deterministic demo.
- **Cross-period detector** (H2) — needs a prior submission; robust year-on-year change.

```js
// e.g. the chain mass-balance detector
class ChainBalanceDetector {
  static meta = { id: 'chain-mass-balance', version: '1.0.0', enabled: true, shadow: false };
  async evaluate(row) {
    const recv = row.TONNAGE_RECEIVED_FOR_EXPORT, exp = row.TONNAGE_OF_UK_PACKAGING_WASTE_EXPORTED;
    if (exp > recv + 0.01) return {
      detectorId: 'chain-mass-balance', version: '1.0.0',
      score: 1.0, severity: 'critical',
      reason: `Exported ${exp} t exceeds ${recv} t received for export`,
      evidence: { recv, exp, osr: row.TONNAGE_RECEIVED_BY_OSR },
      thresholdsUsed: { tolerance: 0.01 }
    };
    return null;
  }
}
```

---

## 6. Recommended fixture strategy for the demo

Don't demo on the raw file (its anomalies are partly artifacts). Instead build
`fixtures/loads.json` — say **40 loads** copied from real rows — and **seed ~6 deliberate,
realistic anomalies**, one per detector you want to show:

1. A tampered `NET` that breaks `GROSS−TARE−PALLET` (A1).
2. A load with `exported > received-for-export` (B1).
3. A load `exported` two weeks before it was `received` (C1).
4. A load with EWC `20 03 01` (municipal) instead of `15 01 04` (D1).
5. A "97.5% AAIG cans" load declaring 35% recyclable (E1).
6. A load shipped to **Tuvalu** (E2 — the LLM-explainer showpiece).

Then the demo narrative is: 40 loads in → ranked queue out → click the Tuvalu flag → plain-English
reason → toggle a detector's `shadow` flag to show the system is built to evolve.

---

## 7. Action plan

1. **Extract a clean fixture** from this file (I can generate `fixtures/loads.json` + the seeded
   anomalies now).
2. **Pull the allowed EWC + material lists** from `Sheet1` into `reference/allowed-codes.json`
   (powers D1/D3) — I can do this now too.
3. **Implement detectors B1, C1/C2, D1, E1 first** — all zero-label, deterministic, high-signal,
   and each maps to a real column shown above.
4. **Add E2 (destination plausibility) as the AI moment** with a cached LLM reason.
5. **Aggregate to a 0–100 score, rank the queue, show reason codes** per the research briefing.

---

### Appendix — figures cited (from the 1,000 data rows)
- NET reconciliation errors: 0 · S-formula residual: 0 (both auto-calculated)
- exported > received-for-export: 8 · export-before-received: 107 · OSR-before-export: 107
- EWC packaging (`15`) codes: 13 · hazardous-starred EWC: 488 · distinct OSR countries: 172
- "97.5% AAIG" rows with recyclable ≤ 0.80: 348 / 348 · duplicate weighbridge tickets: 1
- material split: AAIG cans 348, IBA 87.5% 339, other 313 · PERN issued: 504 yes / 496 no
