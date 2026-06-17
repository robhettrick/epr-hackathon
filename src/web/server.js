'use strict';

/**
 * web/server.js — the Hapi monolith (ADR-001) and golden-path boot (ADR-002).
 *
 * This is the outermost layer of the C4 dependency rule
 * (`web → engine → detectors → model`). It does four things at boot, once, into
 * memory — there is **no database on the golden path** (ADR-002):
 *
 *   1. Self-register every detector — detectors register on import (ADR-004), so
 *      something must import them; `registerDetectors()` requires each detector
 *      file in `src/detectors/`. This keeps "add a detector = one file +
 *      register()" literally true: a new detector file is picked up here with no
 *      edit to the engine or this server.
 *   2. Ingest the fixtures (golden-path step 1) into the in-memory dataset.
 *   3. Run the engine once (golden-path step 2) over that dataset, holding the
 *      per-detector findings in memory. Triage is re-run per request (cheap,
 *      ADR-009) so threshold changes never need a re-ingest or a detector re-run.
 *   4. Stand up Hapi with `@hapi/vision` (Nunjucks rendering govuk-frontend
 *      server-side) and `@hapi/inert` (serving the govuk-frontend static assets).
 *
 * Determinism (CLAUDE.md): fixtures are ingested in a fixed order, the engine is
 * deterministic, and there is no live network — the same boot always yields the
 * same in-memory result.
 *
 * `build()` returns the wired-but-unstarted server plus the boot data/result so
 * tests (and later golden-path views) can drive it without binding a port;
 * `start()` builds and listens. Running this file directly starts the server.
 */

const Fs = require('fs');
const Path = require('path');
const Hapi = require('@hapi/hapi');
const Vision = require('@hapi/vision');
const Inert = require('@hapi/inert');
const Nunjucks = require('nunjucks');

const { ingest } = require('../ingest');
const { run } = require('../engine/orchestrator');
const { registerPageRoutes } = require('./routes');

// --- Boot configuration -----------------------------------------------------

const ROOT = Path.join(__dirname, '..', '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// The two real submissions on the golden path (≥2 files, two materials/operators).
const FIXTURES = [
  Path.join(ROOT, 'fixtures', 'exporter_E-ACC12245AL_E25SR500020912AL-b3c87758.xlsx'),
  Path.join(ROOT, 'fixtures', 'exporter_E-ACC12245FB_E25SR500020912FB.xlsx'),
];

// govuk-frontend ships its Nunjucks templates + compiled assets under dist/.
// Resolve the package root via require so the path holds wherever node_modules
// lives, then expose `dist/` to Nunjucks (`{% extends "govuk/template.njk" %}`)
// and `dist/govuk/` to inert (CSS/JS/fonts/images).
const GOVUK_ROOT = Path.dirname(require.resolve('govuk-frontend/package.json'));
const GOVUK_DIST = Path.join(GOVUK_ROOT, 'dist');
const GOVUK_PUBLIC = Path.join(GOVUK_DIST, 'govuk');

const VIEWS_DIR = Path.join(__dirname, 'views');

// Detector-registry infrastructure files — NOT detectors, so don't import them as
// such (they self-register nothing; requiring them is harmless but pointless).
const NON_DETECTOR_FILES = new Set(['registry.js', 'config.js']);

// --- Boot steps -------------------------------------------------------------

/**
 * Import every detector so it self-registers (ADR-004). Scanning the directory —
 * rather than a hand-maintained import list — is what makes adding a detector a
 * one-file change: drop the file in `src/detectors/` and it joins the run.
 *
 * @returns {string[]} the detector filenames imported (for boot logging/tests).
 */
function registerDetectors() {
  const dir = Path.join(__dirname, '..', 'detectors');
  const imported = [];
  for (const file of Fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.js') || NON_DETECTOR_FILES.has(file)) continue;
    require(Path.join(dir, file)); // eslint-disable-line global-require
    imported.push(file);
  }
  return imported;
}

/**
 * Ingest the fixtures and run the engine once, returning the in-memory read model.
 *
 * The dataset's own reference lists (the per-file Sheet1 union) are enriched with
 * the reviewed `reference/allowed-codes.json` so detectors get the explicit
 * `packagingEwcCodes` subset (the `15 01 xx` list) rather than re-deriving it.
 *
 * @returns {Promise<{data: object, result: object}>}
 */
async function buildReadModel() {
  const dataset = await ingest(FIXTURES);

  const allowedCodes = require(Path.join(ROOT, 'reference', 'allowed-codes.json')); // eslint-disable-line global-require
  const data = {
    ...dataset,
    reference: {
      ...dataset.reference,
      ewcCodes: allowedCodes.ewcCodes,
      packagingEwcCodes: allowedCodes.packagingEwcCodes,
      materials: allowedCodes.materials,
    },
  };

  const result = await run(data);
  return { data, result };
}

// --- Server wiring ----------------------------------------------------------

/**
 * Configure the Nunjucks view engine on the server, with the search path spanning
 * our own `views/` (layout + pages) and the govuk-frontend `dist/` (base template
 * + component macros). `serviceName` is a global so the govuk service header
 * renders on every page.
 */
function configureViews(server) {
  server.views({
    engines: {
      njk: {
        compile(src, options) {
          const template = Nunjucks.compile(src, options.environment);
          return (context) => template.render(context);
        },
        prepare(options, next) {
          options.compileOptions.environment = Nunjucks.configure(
            [VIEWS_DIR, GOVUK_DIST],
            { autoescape: true, watch: false },
          );
          return next();
        },
      },
    },
    relativeTo: __dirname,
    path: 'views',
    context: {
      serviceName: 'Spot the Anomaly',
      serviceUrl: '/',
    },
  });
}

/**
 * Register the static-asset routes (inert): the compiled govuk CSS/JS under
 * `/govuk/` and the fonts/images under `/assets/` (the path the govuk base
 * template references by default via `assetPath`).
 */
function registerStaticRoutes(server) {
  server.route({
    method: 'GET',
    path: '/govuk/{param*}',
    handler: { directory: { path: GOVUK_PUBLIC, redirectToSlash: false, index: false } },
  });
  server.route({
    method: 'GET',
    path: '/assets/{param*}',
    handler: { directory: { path: Path.join(GOVUK_PUBLIC, 'assets'), redirectToSlash: false, index: false } },
  });
}

/**
 * Build the fully wired server without starting it (used by tests). Registers
 * detectors, builds the in-memory read model, then configures Hapi.
 *
 * @returns {Promise<{server: import('@hapi/hapi').Server, data: object, result: object}>}
 */
async function build() {
  registerDetectors();
  const { data, result } = await buildReadModel();

  const server = Hapi.server({ port: PORT, host: HOST });
  await server.register([Inert, Vision]);
  configureViews(server);
  registerStaticRoutes(server);
  registerPageRoutes(server, { data, result });

  // Hang the read model off the server so later routes/handlers can reach it.
  server.app.data = data;
  server.app.result = result;

  return { server, data, result };
}

/**
 * Build and start the server (the `npm run dev` / `npm start` entrypoint).
 */
async function start() {
  const { server, data, result } = await build();
  await server.start();
  // eslint-disable-next-line no-console
  console.log(
    `Spot the Anomaly listening on ${server.info.uri} — `
    + `${data.loads.length} loads, ${result.detectors.length} detectors`,
  );
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { build, start, registerDetectors, buildReadModel, FIXTURES };
