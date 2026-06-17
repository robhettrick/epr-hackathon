'use strict';

/**
 * web/routes.js — the golden-path page routes (server-rendered Nunjucks/govuk).
 *
 * Split out of `server.js` so the page-route surface can grow (detector list →
 * per-detector findings → finding detail → live-threshold re-render) without the
 * server bootstrap getting longer. Every route here is a pure read over the
 * in-memory read model (`{ data, result }`) built once at boot (ADR-002): no
 * database, no per-request detector re-run. Triage is the only thing re-run per
 * request (cheap), and that lands with the per-detector routes.
 *
 * Dependency rule (ADR C4): this is the outermost `web` layer — it consumes the
 * engine's output and renders it; it never reaches back into detectors/ingest.
 */

const Boom = require('@hapi/boom');

const { triage } = require('../engine/triage');
const { SEVERITIES } = require('../model/finding');

/**
 * Severity → govuk tag modifier class. Severity is a *tag* on each finding (PRD
 * §5.3), not the sort key, so it is shown as a coloured govuk tag while `score`
 * drives the ranking. Higher severity = hotter colour.
 */
const SEVERITY_TAG = Object.freeze({
  critical: 'govuk-tag--red',
  high: 'govuk-tag--orange',
  medium: 'govuk-tag--yellow',
  low: 'govuk-tag--grey',
});

/**
 * Boot-overview figures for the landing page. Counts only **surfaced** detectors
 * and their findings — shadow detectors run but never surface in the UI/counts
 * (ADR-008), so they are excluded here and from the detector list below.
 */
function buildSummary(data, result) {
  const surfaced = result.detectors.filter((d) => d.surfaced);
  return {
    loads: data.loads.length,
    operators: data.entities.operators.size,
    detectors: surfaced.length,
    findings: surfaced.reduce((total, d) => total + d.count, 0),
  };
}

/**
 * The rows for the detector list view (golden-path step 4): one entry per
 * surfaced detector with its finding count and the path to its per-detector list.
 * Order follows the orchestrator's registration order (deterministic demo).
 */
function buildDetectorList(result) {
  return result.detectors
    .filter((d) => d.surfaced)
    .map((d) => ({
      id: d.id,
      title: d.title,
      scope: d.scope,
      count: d.count,
      href: `/detectors/${encodeURIComponent(d.id)}`,
    }));
}

/**
 * The per-detector findings view (golden-path steps 3–4): one detector's findings
 * ranked highest score first, each row carrying the subject, its severity tag, the
 * score, and a link into the finding detail page (the detail route lands next).
 *
 * Ranking + surfacing is delegated to the engine's pure `triage` (re-run per
 * request, ADR-009): `options` are the request's GET query params overlaid onto the
 * defaults, so changing `?minScore`/`?minSeverity`/`?limit` re-ranks and re-filters
 * the list with NO code change (golden-path step 6). `triage` coerces those raw
 * query strings defensively, so a malformed param degrades to "no threshold" rather
 * than erroring the page.
 *
 * Returns `null` for an unknown OR shadow detector (not in the surfaced set) so the
 * route can answer 404 rather than render an empty page (ADR-008).
 *
 * `findingId` is the finding's `subject.id` — unique within a single detector (one
 * finding per load index / per entity), and stable regardless of triage order, so
 * the detail route can resolve a finding by it without depending on the ranking.
 *
 * @param {object} result the engine result (`{ detectors, byDetector }`).
 * @param {string} detectorId the requested detector id.
 * @param {object} [options] triage thresholds, typically `request.query`.
 * @returns {object|null} the view model, or null if the detector isn't surfaced.
 */
function buildDetectorView(result, detectorId, options = {}) {
  const record = result.detectors.find((d) => d.id === detectorId && d.surfaced);
  if (!record) return null;

  const findings = result.byDetector[detectorId] || [];
  const triaged = triage(findings, options);

  const rows = triaged.surfaced.map((f) => ({
    findingId: f.subject.id,
    label: f.subject.label || String(f.subject.id),
    subjectType: f.subject.type,
    score: f.score,
    severity: f.severity,
    severityTag: SEVERITY_TAG[f.severity] || 'govuk-tag--grey',
    href: `/detectors/${encodeURIComponent(detectorId)}/findings/${encodeURIComponent(f.subject.id)}`,
  }));

  return {
    id: record.id,
    title: record.title,
    scope: record.scope,
    href: `/detectors/${encodeURIComponent(detectorId)}`,
    total: triaged.total,
    surfacedCount: triaged.surfacedCount,
    hiddenCount: triaged.hiddenCount,
    // The resolved (coerced) thresholds, so the filter form pre-fills the values
    // actually applied this request — the threshold UI reflects engine state, not
    // the raw query string.
    thresholds: triaged.thresholds,
    severityOptions: buildSeverityOptions(triaged.thresholds.minSeverity),
    rows,
  };
}

/**
 * The `<select>` items for the minimum-severity filter: an "Any severity" no-gate
 * option plus one per `SEVERITY` (hottest first, so the most selective gate reads at
 * the top), marking the currently-applied gate selected. Built here, not in the
 * template, so the view stays logic-free and the enum stays the single source of
 * truth (the form can never offer a severity the model doesn't define).
 */
function buildSeverityOptions(selected) {
  const items = [{ value: '', text: 'Any severity', selected: !selected }];
  for (const severity of [...SEVERITIES].reverse()) {
    items.push({ value: severity, text: severity, selected: severity === selected });
  }
  return items;
}

/**
 * Render one evidence/thresholds value for the detail view. Findings are a uniform
 * contract (PRD §5.2) whose `evidence`/`thresholdsUsed` are detector-specific shapes,
 * so the detail view must display ANY shape with no per-detector branching (ADR-004):
 * primitives stringify, dates ISO-format, nested objects/arrays render as JSON, and a
 * null/undefined shows as an em dash. The view escapes the result as data.
 */
function describeValue(value) {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Flatten a plain object into `{ key, value }` rows for a govuk summary list,
 * stringifying each value generically. A non-object (or empty) yields no rows. */
function toDetailRows(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value: describeValue(value) }));
}

/**
 * The finding detail view (golden-path step 5): one finding's reason code, the
 * evidence (the figures that tripped it) and the `thresholdsUsed` echo — the page a
 * regulator opens to understand WHY a subject was flagged and decide whether to act.
 *
 * Resolves the finding by `detectorId` + `findingId` (the finding's `subject.id`,
 * matched as a string since it arrives from the URL) over the in-memory read model —
 * no triage/threshold dependency, so a finding is reachable by its stable id even if
 * the current threshold would hide it from the ranked list.
 *
 * Returns `null` (→ 404) for an unknown/shadow detector OR an unknown finding id, so
 * the route never renders an empty detail page (ADR-008).
 *
 * @param {object} result the engine result (`{ detectors, byDetector }`).
 * @param {string} detectorId the requested detector id.
 * @param {string} findingId the requested finding's `subject.id` (as a URL string).
 * @returns {object|null} the detail view model, or null if it can't be resolved.
 */
function buildFindingView(result, detectorId, findingId) {
  const record = result.detectors.find((d) => d.id === detectorId && d.surfaced);
  if (!record) return null;

  const findings = result.byDetector[detectorId] || [];
  const finding = findings.find((f) => String(f.subject.id) === String(findingId));
  if (!finding) return null;

  return {
    detectorId: record.id,
    detectorTitle: record.title,
    detectorScope: record.scope,
    detectorHref: `/detectors/${encodeURIComponent(detectorId)}`,
    subject: finding.subject,
    score: finding.score,
    severity: finding.severity,
    severityTag: SEVERITY_TAG[finding.severity] || 'govuk-tag--grey',
    reason: finding.reason,
    evidence: toDetailRows(finding.evidence),
    thresholdsUsed: toDetailRows(finding.thresholdsUsed),
  };
}

/**
 * Register the page routes against the wired server, closing over the in-memory
 * read model so each handler is a synchronous render with no I/O.
 *
 * @param {import('@hapi/hapi').Server} server
 * @param {{data: object, result: object}} readModel
 */
function registerPageRoutes(server, { data, result }) {
  const summary = buildSummary(data, result);
  const detectors = buildDetectorList(result);

  server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => h.view('home', { pageTitle: 'Overview', summary }),
  });

  // Golden-path step 4: every detector with its finding count and a link to its
  // ranked findings list (the per-detector route lands in the next plan item).
  server.route({
    method: 'GET',
    path: '/detectors',
    handler: (request, h) => h.view('detectors', { pageTitle: 'Detectors', detectors }),
  });

  // Golden-path steps 3–4 + 6: one detector's findings, ranked highest score first,
  // each linking to its detail page. The GET query (`minScore`/`minSeverity`/`limit`)
  // is overlaid onto triage so the threshold form re-ranks/re-filters live with no
  // code change (ADR-009). Unknown/shadow detector → 404 (defensive; the list above
  // only links surfaced detectors).
  server.route({
    method: 'GET',
    path: '/detectors/{id}',
    handler: (request, h) => {
      const detector = buildDetectorView(result, request.params.id, request.query);
      if (!detector) return Boom.notFound(`Unknown detector "${request.params.id}"`);
      return h.view('detector', { pageTitle: detector.title, detector });
    },
  });

  // Golden-path step 5: one finding's detail — reason + evidence + thresholdsUsed.
  // Resolved by detector id + finding id (subject.id) over the read model; an
  // unknown detector OR an unknown finding id → 404.
  server.route({
    method: 'GET',
    path: '/detectors/{id}/findings/{findingId}',
    handler: (request, h) => {
      const { id, findingId } = request.params;
      const finding = buildFindingView(result, id, findingId);
      if (!finding) return Boom.notFound(`Unknown finding "${findingId}" for detector "${id}"`);
      return h.view('finding', { pageTitle: finding.detectorTitle, finding });
    },
  });
}

module.exports = {
  registerPageRoutes,
  buildSummary,
  buildDetectorList,
  buildDetectorView,
  buildFindingView,
};
