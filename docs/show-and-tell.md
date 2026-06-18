# Spot the Anomaly — show & tell

## The problem

Regulators reviewing EPR packaging-waste submissions spend most of their day comparing data by
eye: submission against submission, this year against last, a report against its re-submission.
It's slow, manual, and anomalies slip through. The data needed to catch them already exists —
nobody had built the thing that looks at it systematically.

## What we built

A working compliance tool that:

1. **Ingests multiple operators' submission spreadsheets** straight from the real EPR exporter
   template — no reformatting — into one combined dataset.
2. **Fans the data out across a registry of anomaly detectors.** Each detector is a small,
   self-contained check.
3. **Presents each detector's findings as its own ranked, severity-tagged list**, every finding
   carrying a plain-English reason and the evidence behind it.
4. Lets the regulator **drill into any finding** and **tune the sensitivity threshold live** to
   match their review capacity.

It's a server-rendered **GOV.UK Frontend** application, so it looks and behaves like a real Defra
service from minute one.

## The demo (what you'll see)

Running on a curated two-operator dataset (an Aluminium exporter and a Fibre-based-composite
exporter):

- **Overview** — 100 loads across 2 operators, the detectors that ran, total findings.
- **Detectors** — each detector with its finding count.
- **EWC-not-packaging** — top hit is a *hazardous* waste code filed on a packaging-waste export,
  flagged critical, with the reason written out.
- **Chain mass-balance** — loads where the tonnages don't reconcile (exported more than was ever
  received), ranked worst-first.
- **A finding's detail** — the reason and the exact figures that tripped it.
- **Live threshold** — nudge it and the list re-ranks instantly.
- **"Add a detector = one file"** — new checks appear automatically as new lists.

On the full real submissions (`FIXTURES=raw`) the same engine runs over ~2,000 loads — the point
being it scales from the demo to the regulator's whole population.

## Why it matters

- **It turns trawling into triage.** The regulator works a ranked queue with reasons, not a wall
  of spreadsheets.
- **It's honest about confidence.** Findings are scored and severity-tagged; the threshold is the
  regulator's dial, configurable per material/domain.
- **It's built to grow.** Detectors are pluggable — the set of checks expands as regulators learn,
  without rewrites. That extensibility is the core of the design, not an afterthought.
- **It's grounded in the real data.** Every detector maps to a field in the actual template and a
  real anomaly pattern found in the sample submissions.

## What happens next

The golden path and the headline detectors work today. To take it further:

- **Complete the ★ detector set** — material-profile (does the declared recyclable-% match the
  grade?), destination-plausibility (is this a credible reprocessing country?), and the
  cross-operator network check (one supplier feeding many operators) — plus an LLM that writes the
  investigator-facing reasons.
- **Cross-reference external data** — Companies House for overdue filings, dissolved-but-trading
  entities, and shared directors (a free, high-value signal).
- **Close the loop** — let analysts confirm/dismiss findings and feed that back to tune thresholds
  (the persistence path is designed in, off by default).
- **Run it on real submissions at scale**, and complete a formal GOV.UK accessibility assessment
  before any live use.
