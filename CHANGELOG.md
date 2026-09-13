# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

Nothing yet.

## [1.0.0] — 2026-09-12

First tagged release: the viewer as a core library with a thin browser app over it.

### Added

- **`core/` — a DOM-free library** (12 ES modules). Scenes, cameras, framing,
  clipping and slice caps, camera synchronisation, and the layer and anatomy
  loading state machines, with no reference to `document`, `window`, `fetch` or
  the DOM anywhere in its module graph. Renderer and controls enter through
  injected adapters, bytes through an injected `io`, and every state transition
  leaves through an event emitter, so the same code drives this page, a page of
  your own, or a Node process with no browser.
- **`core/index.js`** barrel and a `package.json` `exports` map, with
  `./browser`, `./headless`, `./asset-loader` and `./data-loader` subpaths.
- **"Using the core in your own page"** in the README: a minimal working page,
  the import table, the import-map note and the record shapes `layers` accepts.
- **`app/browser-adapters.js`** — the only module that constructs a
  `WebGLRenderer` or browser `OrbitControls`.
- **`tools/bench`** — asset inventory and a symmetric point-to-surface error
  measurement between a full-resolution scan and the shipped mesh, using an
  exact uniform spatial hash cross-checked against brute force in the test suite.
- **507 unit tests** on Node's built-in runner, including a static DOM-free scan
  that follows imports so an app-layer module cannot be pulled into `core/`
  behind a file that is itself clean.
- **18 Playwright end-to-end tests** and CI running both suites plus a decode of
  every shipped asset.
- `CONTRIBUTING.md`, including support and governance expectations.

### Changed

- `viewer.js` went from 1,689 lines holding the entire application to 235 lines
  of view/controller over the core, with the DOM panels split into `app/ui/`.
- `tools/bench` now resolves the app shell by walking `index.html`'s module
  graph instead of a hard-coded file list, which had gone stale during the
  extraction and understated the shell.
- Unit tests run on Node >= 20 (`engines`), and `three` is a devDependency so
  the core can be exercised headless.

### Fixed

- The DOM-free scan was blind to text following a `//` inside a string literal,
  so a URL in `core/mesh-parsers.js` hid the rest of its line from the check.
- Both glTF parsers could drop their `reject` callback with the suite green; a
  failed parse then hung forever. Now pinned by a fixture that fails
  asynchronously, the path every shipped Draco asset takes.
- `registerParts` had lost its back-mesh guard in an uncommitted edit, which
  would have overwritten each structure with its own back-face duplicate on a
  second pass.

[Unreleased]: https://github.com/GoJian/awg_retina_tomography_ui/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/GoJian/awg_retina_tomography_ui/releases/tag/v1.0.0
