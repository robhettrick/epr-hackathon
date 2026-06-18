# AI-build retrospective — how we built Spot the Anomaly in a day

A candid account of building a working, GOV.UK-styled regulator tool largely through AI, end to
end, in a single hackathon day. Useful as a reusable playbook.

## The pipeline

We ran a deliberate sequence, each stage feeding the next:

1. **Ideation** — assessed all nine briefs against an "AI-heavy, demo-in-a-day, can-code" lens;
   chose Brief 2 (Spot the Anomaly) as the best fit and shaped the core idea: ingest → fan-out to
   detectors → per-detector scored lists.
2. **Deep research** — a multi-source, fact-checked sweep of current anomaly-detection practice:
   detection techniques for scarce-label tabular data, human-in-the-loop flagging (scoring,
   triage, reason codes, alert fatigue), and **architecture for extensibility**. Synthesised to
   `docs/anomaly-detection-research.md`.
3. **Data grounding** — analysed the real EPR exporter file (1,000 loads), profiled the fields and
   the built-in calculations, and derived a concrete catalogue of detectable anomalies mapped to
   actual columns (`docs/anomaly-scenarios-from-sample.md`). Cross-checked the team's whiteboard
   scenarios against what the data could actually support.
4. **PRD** — turned the idea + research + data into a build-ready spec with an explicit golden
   path, a ★ detector set, the `Detector`/`Finding` contracts, and a demo script.
5. **Architecture & ADRs** — an architect pass producing 11 ADRs and cross-cutting constraints
   (Hapi monolith, in-memory + optional Postgres, pluggable detectors, LLM-as-explainer, GDS
   compliance scope).
6. **Autonomous build** — handed the specs to **Ralph** (the Ralph Wiggum loop runner) driving
   **Claude Code** in plan→build cycles. It produced the project from scratch: model, ingestion,
   detector registry, engine, and the GOV.UK web layer.
7. **Human-in-the-loop audits** — between batches, we reviewed the code and **ran the detectors
   against the real fixtures** to verify behaviour, catching issues the green test suite couldn't.

## Who did what

- **Claude (assistant):** problem selection, research, data analysis, PRD, ADRs, curated demo
  fixtures, reference-data extraction, and the between-batch audits.
- **Ralph + Claude Code (opus):** the autonomous plan/build loop — ~20+ build iterations across a
  few batches, one plan item per iteration, each ending in tests + an atomic commit.
- **The human:** ran Ralph, made the product calls (stack = Hapi + Postgres, "make % configurable"),
  and drove the demo.

## What worked

- **Spec-first, golden-path-first.** A tight PRD with one non-negotiable happy path kept the
  autonomous loop from wandering; the ★-set scoping stopped it building all 14 candidate detectors.
- **The detector abstraction paid for itself.** Strategy + registry + a uniform `Finding` meant
  every new detector was genuinely one file, and the UI stayed generic.
- **Curated fixtures with seeded anomalies.** The real data was synthetic in places (random
  export/OSR tonnages), which made one detector flood. A small curated fixture with deliberate,
  documented seeds gave legible demo lists *and* an end-to-end smoke test oracle.
- **Audit by running, not just reading.** Executing detectors over the fixtures surfaced the flood
  and a tonnage-as-text nit that passing unit tests hid.
- **Short batches with review between.** `-n 5`/`-n 8`, skim `PROGRESS.md`, continue.

## What we hit (honestly)

- **Toolchain gotchas, all on macOS:** the sandbox failed to mount the SSH-agent socket (fixed
  with `SSH_AUTH_SOCK=""`); a brand-new repo had no `HEAD` so `plan` failed until an initial
  commit; and Claude's credentials didn't carry into the devcontainer until authenticated once
  inside it. All now documented in `START-HERE.md`.
- **A commit race.** The assistant committed with `git add -A` while the loop was mid-iteration and
  swept Ralph's in-progress web files into an unrelated commit. No data lost, but the lesson is
  real: **don't run broad git operations against a folder an autonomous agent is working in** —
  stage specific paths, or leave committing to the loop.
- **Synthetic-data artifacts.** `chain-mass-balance` was correct but flooded on the raw fixtures'
  random tonnage columns — a data problem, not a code one. We fixed the *data* (curated fixture),
  not the detector.
- **Pace.** The invisible layers (model, ingest) went fast; the GOV.UK web layer was where
  iterations slowed, as expected.

## Reusable lessons

1. **Research and ground in the data before writing the spec** — the PRD was far better for it.
2. **Make the spec's golden path and scope explicit** — it's the steering wheel for an autonomous
   loop.
3. **Design one strong abstraction** (here, the detector contract) and let everything else stay
   generic.
4. **Keep a human auditing by execution**, not just reading summaries or trusting green tests.
5. **Seed deterministic, documented demo data** — it doubles as your smoke-test oracle.
6. **Give the autonomous loop its own lane** — don't touch its working tree concurrently.

## By the numbers

- 37 commits, 232 passing tests, ~30 autonomous build iterations across a handful of batches.
- A complete golden path (ingest → fan-out → ranked/triaged lists → detail → live threshold),
  **all five ★ detectors live** plus a cached LLM explainer, `runMeta` reproducibility stamping,
  and shadow-flag promotion — all in roughly a day.
