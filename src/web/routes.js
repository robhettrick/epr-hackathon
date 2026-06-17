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
}

module.exports = { registerPageRoutes, buildSummary, buildDetectorList };
