# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## Unreleased

Nothing yet.

## [1.0.0] — 2026-09-14

The first release: the viewer as a core library with a thin browser app over it.

### Added

- **`core/` — a DOM-free library** (12 ES modules plus the `core/index.js`
  barrel). Scenes, cameras, framing, clipping and slice caps, camera
  synchronisation, and the layer and anatomy loading state machines, with no
  reference to `document`, `window`, `fetch` or the DOM anywhere in its module
  graph. Renderer and controls enter through injected adapters, bytes through an
  injected `io`, and every state transition leaves through an event emitter, so
  the same code drives this page, a page of your own, or a Node process with no
  browser.
- **`core/index.js`** barrel and a `package.json` `exports` map, with `./core/*`
  for the individual core modules and `./browser`, `./headless`,
  `./asset-loader` and `./data-loader` subpaths.
- **"Using the core in your own page"** in the README: a minimal working page,
  the import table, the import-map note and the record shapes `layers` accepts.
- **`app/browser-adapters.js`** — the only module that constructs a
  `WebGLRenderer` or browser `OrbitControls`.
- **`tools/bench`** — asset inventory, a first-visit size report, and a symmetric
  point-to-surface error measurement between a full-resolution scan and the
  shipped mesh, using an exact uniform spatial hash cross-checked against brute
  force in the test suite. The size report resolves the app shell by walking
  `index.html`'s module graph rather than a hard-coded list, so it cannot
  understate the shell when a module moves, and gzips it — the raw and
  over-the-wire numbers quoted in the README and the paper come from here.
- **507 unit tests** on Node's built-in runner, including a static DOM-free scan
  that follows imports so an app-layer module cannot be pulled into `core/`
  behind a file that is itself clean.
- **18 Playwright end-to-end tests** and CI running both suites plus a decode of
  every shipped asset.
- `package.json` — `engines` requiring Node >= 20, and `three` r169 as a peer
  dependency and as a devDependency so the core can be exercised headless.
- `CONTRIBUTING.md`, including support and governance expectations, a manual
  smoke test for what the automated suites cannot reach, `CODE_OF_CONDUCT.md`
  and `CITATION.cff`.

### Changed

- `viewer.js` went from 1,689 lines holding the entire application to 235 lines
  of view/controller over the core, with the DOM panels split into `app/ui/`.
- `tools/optimize/optimize.sh` now documents `@gltf-transform/cli@4.0.0` as the
  CLI version the shipped assets were built with: an unpinned CLI bundles a
  different meshoptimizer and will not reproduce them.

[Unreleased]: https://github.com/kush1434/awg_retina_tomography_ui/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kush1434/awg_retina_tomography_ui/releases/tag/v1.0.0
