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
 * request, ADR-009): this item ships the default (surface-everything, ranked)
 * view; the live-threshold item overlays request query params onto `options`.
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
 * @param {object} [options] triage thresholds (defaults surface everything).
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
    total: triaged.total,
    surfacedCount: triaged.surfacedCount,
    hiddenCount: triaged.hiddenCount,
    rows,
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

  // Golden-path steps 3–4: one detector's findings, ranked highest score first,
  // each linking to its detail page. Unknown/shadow detector → 404 (defensive; the
  // list above only links surfaced detectors).
  server.route({
    method: 'GET',
    path: '/detectors/{id}',
    handler: (request, h) => {
      const detector = buildDetectorView(result, request.params.id);
      if (!detector) return Boom.notFound(`Unknown detector "${request.params.id}"`);
      return h.view('detector', { pageTitle: detector.title, detector });
    },
  });
}

module.exports = {
  registerPageRoutes, buildSummary, buildDetectorList, buildDetectorView,
};
