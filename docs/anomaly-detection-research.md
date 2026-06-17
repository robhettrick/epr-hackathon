# Detecting & flagging anomalies for human investigation
### Research briefing for the EPR "Spot the Anomaly" team

Scope: how to detect anomalies in producer packaging-waste submissions (year-on-year, vs
sector peers, vs external reference data) and surface them for a regulator to investigate —
with a **detection layer abstract enough to change over time**, which was your specific ask.

---

## TL;DR — the five things that matter

1. **No single algorithm wins.** Every benchmark (ADBench/NeurIPS, JMLR 2024) says the same:
   layer several cheap detectors, don't hunt for one model. Run rules → robust per-peer-group
   statistics → year-on-year change detection, and aggregate their scores.
2. **The abstraction you want already has a standard shape:** each detector is a self-contained
   *strategy* implementing one interface, self-registered in a *registry*, all emitting the
   **same `Finding` object** `{detectorId, version, score, severity, reason, evidence,
   thresholdsUsed}`. Adding a detector = drop a file + one `register()` call. This is the whole
   answer to "so they can change over time."
3. **Don't let the LLM be the detector.** Use deterministic/statistical checks for the
   *decision* (auditable), and an LLM only as an *explainer* that turns a tripped check into a
   human-readable reason. Pre-compute the "business-type → expected materials" profile offline,
   cache it. This also satisfies the hackathon's deterministic-demo guardrail.
4. **Score, rank, and triage — don't just flag.** Normalise each detector's score, combine into
   one 0–100 risk score per producer, rank the queue, and split three ways: auto-clear the
   obviously fine, auto-escalate the obviously bad, route the ambiguous middle to a human.
   Attach reason codes to every flag. The unit of work is the **case**, not the alert.
5. **Control noise structurally.** The dominant cause of failed compliance tooling is false
   positives (>95% of alerts in AML). Don't flag single data points; require a sustained signal,
   make thresholds tunable per peer-group, and capture confirm/dismiss feedback from day one.

---

## Part 1 — Detection techniques

### The layered model (recommended)

| Layer | Examples | Why it's here | Labels needed | Explainable? |
| --- | --- | --- | --- | --- |
| 1. Rules / expert checks | impossible tonnage, sum-to-total mismatch, unit errors, illegal YoY ratio | catch known errors instantly, fully auditable | none | ★★★ |
| 2. Robust per-peer-group stats | **MAD / robust z-score**, IQR within a sector+size cohort | the strongest match to "compare to your peers"; resists being skewed by the outliers it hunts | none | ★★★ |
| 3. Year-on-year change | CUSUM / changepoint on a producer's own history | catches abrupt level shifts vs last year | none | ★★☆ |
| 4. Cohort smoke alarm | **Benford's law** on declared figures | screens fabricated/rounded numbers at the *cohort* level | none | ★★☆ |
| 5. (Optional) unsupervised ML | Isolation Forest (global), LOF (local), autoencoder | catches multivariate weirdness rules miss | none | ★☆☆ (needs SHAP) |
| 6. Explainer | LLM turns a tripped check + evidence into a reason | investigator-facing narrative, not a decision | none | n/a |

### Key guidance

- **Use robust statistics, not plain z-score.** The mean and standard deviation are themselves
  corrupted by the outliers you're looking for ("masking"). Median + **MAD** (median absolute
  deviation) or **IQR** don't have this problem and give a plain-English reason: *"this figure
  sits 6 robust-SDs above the median of your 40-producer peer cohort."*
- **Peer-group framing is the conceptual core.** Cluster producers into cohorts (by sector,
  size, material mix), then judge each producer *within its cohort*. Deviation against genuine
  peers produces far fewer false positives than against the whole population. This is exactly
  the brief's "wine merchant with no cork/glass" example.
- **When labels are scarce** (you'll have ~none on the day): rules, robust stats, Benford,
  Isolation Forest and peer-group methods are all **label-free**. Only reach for
  semi-supervised methods (Deep SAD, PU learning, Google's SPADE) once you have a handful of
  confirmed cases — SPADE specifically handles *new* anomaly types appearing after labelling,
  which is the real-world regulatory drift problem.
- **Benford is a smoke alarm, not evidence.** It flags risk at the *dataset* level, not which
  record is fraudulent, and legitimate things (capped values, unit conventions, small samples)
  break it. Use it to prioritise a cohort for review, never as a standalone flag.
- **Isolation Forest / autoencoders need help to be explainable.** They give a score, not a
  reason — pair with per-feature attribution (SHAP / reconstruction error) before showing a
  regulator. For a hackathon, you may not need them at all.

---

## Part 2 — The abstraction layer (your core ask)

This is the part to get right architecturally. Three patterns, all Node-friendly.

### 2.1 A common detector interface (Strategy pattern) + a registry

Every detector — whether a one-line rule or an Isolation Forest — implements the same
contract and self-registers. The orchestrator discovers them dynamically; no `if/else` chains,
no central file to edit when you add one.

```js
// Every detector implements this
class Detector {
  static meta = { id: 'peer-glass-outlier', version: '1.0.0', enabled: true, shadow: false };
  async evaluate(record, ctx) { /* returns Finding | null */ }
}

// Registry — detectors register themselves
const registry = new Map();
export const register = (D) => registry.set(D.meta.id, D);
```

Adding a detector tomorrow = create `detectors/peer-glass-outlier.js`, call `register()`.
Nothing else in the codebase changes. (PyOD's `ADEngine` is the mature reference for this
"many swappable detectors behind one orchestrator" shape.)

### 2.2 One output contract for all detectors — the `Finding`

This is what makes aggregation and the UI generic, and it carries the evidence an investigator
(and an auditor) needs:

```js
{
  detectorId: 'peer-glass-outlier',
  version: '1.0.0',
  score: 0.82,              // normalised 0–1 so scores are comparable across detectors
  severity: 'high',         // low | medium | high | critical
  reason: 'Wine merchant declared 0 kg glass; glass expected for this business type',
  evidence: { sic: '47250', declaredGlassKg: 0, peerMedianKg: 1840 },
  thresholdsUsed: { minExpectedKg: 100 }
}
```

### 2.3 Config/DSL-driven rules — separate *logic* from *thresholds*

For the many simple "X exceeds Y" checks, don't write code per rule — declare them as data so a
domain expert can change a threshold without a deploy. For a Node prototype:

- **`json-rules-engine`** — rules are plain JSON (`all`/`any` nesting, custom operators,
  async "facts"), ~17 kb, no `eval()`. Best default. Wrap the whole engine as one `Detector`
  so rule-based and code-based detectors share the registry and `Finding` contract.
- **GoRules / ZEN (`@gorules/zen-engine`)** — Rust core, executes JSON decision *tables* fast,
  has a business-friendly table editor. Graduate to this if rules grow tabular. The registry
  abstraction means you can swap engines later without touching consumers.

```js
engine.addRule({
  conditions: { all: [
    { fact: 'declaredGlassKg', operator: 'lessThan', value: 100 },
    { fact: 'businessType',    operator: 'equal',    value: 'wine_merchant' }
  ]},
  event: { type: 'missing-expected-material', params: { severity: 'high' } }
});
```

### 2.4 Orchestrator + pluggable aggregation

```js
async function runAll(record, ctx) {
  const findings = (await Promise.all(
    [...registry.values()]
      .filter(D => D.meta.enabled)
      .map(D => new D().evaluate(record, ctx))
  )).filter(Boolean);
  const overall = aggregate(findings);   // weighted-max / weighted-mean / voting — swappable
  return { producer: record.id, overall, findings, runMeta: ctx.runMeta };
}
```

### 2.5 Versioning, shadow mode & backtesting (what "change over time" really needs)

- **Stamp every run.** Each detector carries `meta.version`; record a `runMeta` (detector
  IDs+versions, rule-config hash, dataset snapshot, timestamp) on every `Finding` so a flagged
  case can be *replayed against the exact logic that produced it* — essential for a regulator.
- **Promotion path by config flag, no code change:** `shadow → backtested → live`.
  - **Backtest:** because every detector shares `evaluate(record, ctx)`, replaying a new
    detector over historical submissions is just `runAll` over an old dataset — estimate hit
    rate / false positives before release.
  - **Shadow mode:** run the new detector live but suppress its actions (`meta.shadow = true`);
    log its findings, compare to expectations for a while, then flip to live.

This `shadow/enabled` flag pair on `meta` is the cheap, concrete mechanism that lets the team
evolve detectors safely after the hackathon.

---

## Part 3 — Flagging for human investigation

### Scoring: normalise → weight → combine

Don't treat each check as a binary trip-wire. Normalise each detector's score to a common scale
(they emit different ranges), then **fuse via a weighted sum** into one 0–100 risk score per
producer. Weight by the producer's **risk context** — the same raw signal on a high-risk entity
should outrank it on a low-risk one. (This is standard AML alert-scoring practice.)

### Thresholds: set them to investigator capacity

Thresholds are the precision/recall dial and are in tension — higher = fewer false positives but
more misses. Pick the operating point deliberately from a precision-recall curve and your
**review capacity**, not a default 0.5. Then split three ways:

- **auto-clear** clearly low-risk submissions,
- **auto-escalate** clearly high-risk ones,
- **route the ambiguous middle** to a human queue.

### Triage, reason codes, and the case as unit of work

- **Rank the queue by score** so investigators hit the highest-harm cases first — never
  chronological.
- **Attach feature-level reason codes + a narrative** to every flag ("flagged because tonnage
  fell 80% vs prior year AND diverges 3σ from sector peers"). Post-EU-AI-Act this is a
  regulatory expectation, not a nice-to-have, and it's what makes a flag actionable.
- **Group signals per producer into a case**, enriched with history and related submissions,
  with a full audit log of every routing/escalation/decision.

### False positives, alert fatigue & feedback

- >95% of AML alerts are false positives; this causes fatigue *and* makes real cases get missed
  in the noise. Modern scoring cuts this materially (studies report FP down to ~12%).
- The cost of a **false negative** (missed under-reporting → environmental/financial harm) is
  asymmetric and worse, so deliberately accept some false positives to maximise capture.
- **Capture confirm/dismiss feedback from day one.** When analysts repeatedly dismiss an alert
  type, that should tune the rule/threshold; confirmed cases sharpen detection. Firms with
  automated feedback loops improved their alert-to-outcome ratio ~35% — yet only ~19% of
  mid-market firms have them, so it's a genuine differentiator.

### Noise control (borrowed from observability — Datadog/Grafana)

- **Don't alert on a single anomalous point.** Alert only when a *sustained fraction* of a
  window is anomalous — this one idea kills most spike noise.
- **Hysteresis / recovery condition** so a flag can't flap on and off.
- **Severity tiers** (warning vs critical) so not everything demands attention.
- Expose **one sensitivity dial** per detector (e.g. "k × MAD", k≈2–3) rather than hard-coded
  thresholds.

---

## Part 4 — External cross-referencing (Companies House)

The **UK Companies House REST API is free** and returns company profile, officers (directors),
PSC/beneficial-ownership, filing history, and charges. Cheap, high-value risk signals you can
derive directly and feed in as *just another detector*:

- overdue accounts / confirmation statements,
- dissolved-but-still-reporting, or very recently incorporated,
- outstanding charges,
- **director/PSC network overlaps** — the same officer across many recently-dissolved
  companies is a classic regulator red flag.

Limitation to design around: it gives **direct declarations only** — no automatic multi-layer
ownership traversal and no shareholder API, so deep network analysis means stitching the graph
yourself (officers → appointments → other companies). **Cache responses** for a deterministic
demo.

---

## Part 5 — What this means for the build tomorrow

Your PRD already scopes two flag types (YoY swing + AI waste-profile). The research says that's
exactly right for a 4-hour build. Concretely:

1. **Build the abstraction first, even tiny.** A `Detector` interface, a registry, and the
   `Finding` contract (Part 2.1–2.2). This is ~30 lines and is the thing the judges/your team
   will care about — it's literally your stated differentiator, and it makes adding the 2nd and
   3rd detector trivial.
2. **Ship 3 cheap detectors** behind that interface:
   - `yoy-swing` — robust change vs the producer's prior period (deterministic).
   - `peer-profile` — declared materials vs an **expected profile table for the sector**,
     pre-computed once by an LLM and stored as reviewed JSON (the wine-merchant-no-glass flag).
   - `companies-house` *(stretch)* — overdue-filings / dissolved flag from cached API data.
3. **Aggregate to a 0–100 score, rank the queue, show reason codes.** Use the `evidence` in each
   `Finding` to render the side-by-side comparison the PRD's detail view calls for.
4. **LLM = explainer only**, temperature 0, cached per record, with a stubbed per-rule fallback
   string so the live demo can't fail.
5. **Demo the abstraction explicitly:** add a detector live, or toggle a `shadow` flag, to show
   the system is built to evolve. That directly answers "so they can change over time."

The deterministic detectors + LLM-explainer + registry/Finding pattern is both the
state-of-the-art consensus *and* the most demo-safe design. It also visibly connects back to
Brief 1 (the same checks that help a producer at submission time are what the regulator runs
here).

---

## Sources

**Detection techniques**
- [JMLR 25 (2024): Unsupervised Anomaly Detection on Real-world Data](https://jmlr.org/papers/volume25/23-0570/23-0570.pdf)
- [ADBench: Anomaly Detection Benchmark (NeurIPS 2022)](https://arxiv.org/pdf/2206.09426)
- [scikit-learn: Novelty and Outlier Detection (Isolation Forest, LOF)](https://scikit-learn.org/stable/modules/outlier_detection.html)
- [Median Absolute Deviation (Wikipedia)](https://en.wikipedia.org/wiki/Median_absolute_deviation) · [Robust measures of scale / IQR](https://en.wikipedia.org/wiki/Robust_measures_of_scale) · [Hampel test](https://en.wikipedia.org/wiki/Hampel_test)
- [Divergence from Benford's law fails to measure financial accuracy (ScienceDirect, 2025)](https://www.sciencedirect.com/science/article/pii/S1467089525000211) · [Benford's Law in fraud detection (JATIT)](http://www.jatit.org/volumes/Vol100No14/23Vol100No14.pdf)
- [CUSUM](https://en.wikipedia.org/wiki/CUSUM) · [Change detection](https://en.wikipedia.org/wiki/Change_detection)
- [Google Research: data-centric semi-supervised AD (SRR & SPADE)](https://research.google/blog/unsupervised-and-semi-supervised-anomaly-detection-with-data-centric-ml/)
- [Peer Dataset Comparison Outlier Detection for Financial Surveillance (IEEE)](https://ieeexplore.ieee.org/document/1699985/) · [Peer-group analysis for risk scoring (ManageEngine)](https://www.manageengine.com/log-management/cyber-security/enhance-risk-scoring-accuracy-and-anomaly-detection-with-peer-group-analysis.html)

**LLM-assisted detection & explanation**
- [Anomaly Detection of Tabular Data Using LLMs (arXiv:2406.16308)](https://arxiv.org/abs/2406.16308) · [AnoLLM (Amazon Science)](https://assets.amazon.science/f3/e4/9033ae94402eb468072da852f55c/anollm-large-language-models-for-tabular-anomaly-detection.pdf)
- [LLMAD: accurate & interpretable TS anomaly detection (arXiv:2405.15370)](https://arxiv.org/html/2405.15370v1) · [AnomalyExplainer (arXiv:2509.00069)](https://arxiv.org/pdf/2509.00069)
- [LLMs for Anomaly & OOD Detection: a survey (arXiv:2409.01980)](https://arxiv.org/pdf/2409.01980) · [Boosting Anomaly Detection with LLMs (TDS)](https://towardsdatascience.com/boosting-your-anomaly-detection-with-llms/)
- [Building Guardrails for LLMs (arXiv:2402.01822)](https://arxiv.org/pdf/2402.01822)

**Flagging for human investigation (AML / fraud / compliance)**
- [Alert Scoring (Unit21)](https://www.unit21.ai/fraud-aml-dictionary/alert-scoring) · [Real-time risk scoring (Flagright)](https://www.flagright.com/post/real-time-risk-scoring-in-aml-compliance-flagrights-approach)
- [Reduce AML false positives (SEON)](https://seon.io/resources/how-to-reduce-aml-false-positives/) · [Understanding false positives (Flagright)](https://www.flagright.com/post/understanding-false-positives-in-transaction-monitoring)
- [Explainable AI as a regulatory imperative in AML (Fincrime Central)](https://fincrimecentral.com/aml-ai-explainability-regulatory-imperative/) · [Explainable AI in AML (ComplyAdvantage)](https://complyadvantage.com/insights/enhancing-aml-using-explainable-ai/)
- [Compliance case triage framework (Ethico)](https://www.ethico.com/insights/compliance-case-triage-framework-how-to-prioritize-investigations-when-every-report-feels-urgent-2) · [Case Queues (Unit21 docs)](https://docs.unit21.ai/docs/case-queues)
- [Tackling Fraud, Error & Debt in the benefits/tax system (HMRC/HMG PDF)](https://assets.publishing.service.gov.uk/media/5a7f529440f0b62305b8670f/tackling-fraud-error-debt-benefit-tax-system.pdf) · [Precision vs recall trade-off (APXML)](https://apxml.com/courses/basics-model-evaluation-metrics/chapter-2-metrics-for-classification/precision-recall-tradeoff)

**Extensible architecture & mature systems**
- [json-rules-engine (GitHub)](https://github.com/CacheControl/json-rules-engine) · [GoRules ZEN — Node SDK](https://docs.gorules.io/developers/sdks/nodejs) · [JSON Decision Model](https://docs.gorules.io/reference/json-decision-model-jdm)
- [Strategy pattern in JS (valentinog)](https://www.valentinog.com/blog/strategy-pattern-javascript/) · [Registry Pattern (GeeksforGeeks)](https://www.geeksforgeeks.org/system-design/registry-pattern/) · [PyOD (GitHub)](https://github.com/yzhao062/pyod)
- [Releasing fraud rules safely / backtesting (Sardine)](https://www.sardine.ai/blog/fraud-rules) · [Backtesting fraud rules (Lithic)](https://www.lithic.com/blog/smarter-rules-less-risk-backtesting-and-custom-code-are-here) · [Shadow-mode testing (OneUptime)](https://oneuptime.com/blog/post/2026-02-17-how-to-implement-shadow-mode-testing-for-ml-models-on-google-cloud/view)
- [Datadog Anomaly Monitor](https://docs.datadoghq.com/monitors/types/anomaly/) · [Datadog Outlier Monitor (DBSCAN/MAD)](https://docs.datadoghq.com/monitors/types/outlier/) · [Grafana anomaly detection at scale](https://grafana.com/blog/how-to-use-prometheus-to-efficiently-detect-anomalies-at-scale/)
- [AML transaction monitoring architecture (Redis)](https://redis.io/blog/transaction-monitoring-system/) · [Tune transaction-monitoring rules (Flagright)](https://www.flagright.com/post/how-to-tune-transaction-monitoring-rules) · [Continuous monitoring (Diligent)](https://www.diligent.com/resources/blog/continuous-monitoring)
- [Companies House API (GOV.UK catalogue)](https://www.api.gov.uk/ch/companies-house/) · [Companies House API surface, post-ECCTA](https://dev.to/openregistry/uk-companies-house-post-eccta-reality-and-the-actual-api-surface-3737)
