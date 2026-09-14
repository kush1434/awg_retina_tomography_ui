# Contributing

Contributions are welcome, whether that is a bug report, a question about the
data, or a pull request.

## Reporting a problem or asking a question

Open an issue at
<https://github.com/GoJian/awg_retina_tomography_ui/issues>. There is no
template; a useful report usually says what you did, what you expected, and
what happened instead. For rendering problems please include your browser and
operating system, and anything the browser console printed — WebGL behaviour
varies more between machines than the rest of the application does.

If something in the documentation is wrong or unclear, that is a bug too.

## Making a change

1. Fork the repository and branch from `main`.
2. Make the change.
3. Run the tests. They need Node >= 20 and python3 on your PATH — Playwright
   serves the app itself with `tools/dev-serve.py` (see `playwright.config.js`),
   which is why CI installs Python alongside Node:

   ```bash
   npm ci                     # three is a devDependency for the headless core tests
   npm test                   # unit tests; Node >= 20 (globs are expanded by the
                              # shell; on Windows use Node 22)
   npx playwright install chromium   # on Linux add --with-deps (needs sudo), as CI does
   npm run test:e2e           # browser tests
   ```

4. Add tests for anything you fixed or added. The data, caching and geometry
   layers and the `app/ui/` view modules (over the fake DOM in
   `test/helpers/fake-dom.js`) are unit-tested in `test/`, the DOM-free
   `core/` library in `test/core/`; behaviour that only shows up in a browser
   belongs in `test/e2e/`.
5. Open a pull request describing what changed and why.

CI runs both suites plus an asset decode on every pull request.

## Manual smoke test

The suites leave four things uncovered, on purpose — they are what makes the
browser tests fast and offline. Playwright runs Chromium only; it pins
`?dataset=` to the checked-in `local/F10/F10_layers.csv`, so the live Hugging
Face manifest is never fetched; the Draco decoder is a browser-only download, so
no test decodes a compressed asset; and nothing asserts anything about rendered
pixels, so a clip cap that comes out hollow or translucent shells drawn in the
wrong order would leave the suite green.

Before a release, then — and after changing loading, clipping or materials —
walk the deployed app through this by hand:

1. Open it with no `?dataset=` and confirm the layer tree fills. This is the
   only exercise of the real manifest fetch and its cold-start 405 retry against
   Hugging Face's edge; unit tests only cover that retry with a stubbed `fetch`.
2. Load the default anatomy and confirm geometry appears — the only path that
   actually decodes a Draco-compressed GLB.
3. Toggle two segmented layers and confirm both render.
4. Switch to the **Slices** tab, enable a plane, and confirm the cut surface is
   capped solid rather than hollow, and that nested translucent shells still
   read front-to-back.
5. Repeat 1–4 once in Firefox and once in Safari.
6. Narrow the window below 620px and confirm the left rail becomes the overlay
   drawer and both panes stay usable.

## Style

The project has no build step, no framework and no npm runtime dependency beyond
Three.js, and we would like to keep it that way — please raise an issue before
adding one. The page does load four things from third-party origins, and a
reviewer watching the network tab should expect them: Three.js itself, through
the import map in `index.html`; the Draco decoder wasm that Three's
`DRACOLoader` needs, from gstatic (`dracoDecoderPath` in `core/mesh-parsers.js`
points it elsewhere if you host your own); the web fonts, from Google Fonts; and
the dataset manifest and its meshes from Hugging Face, unless `?dataset=` points
somewhere else. Each is a plain URL or a documented option, not a package.

Otherwise, match the surrounding code: ES modules, the existing banner-comment
convention at the top of each file, and comments that explain *why* rather than
restate the code.

## Working with the data

The application reads a CSV manifest, so most data changes need no code. Point
the viewer at an alternative manifest with `?dataset=<url>`; the columns are
documented in [The manifest format](README.md#the-manifest-format). The
full-resolution source scans live in the
[Hugging Face dataset](https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui)
and are never modified by this repository.

If you regenerate the optimized assets, please include the `--verify` output for
any mesh whose decimation settings changed, so the accuracy claims in the README
stay honest:

```bash
cd tools/bench && npm install
node --max-old-space-size=16384 bench.mjs \
  --verify ../optimize/original/eye.stl ../../optimized/sample_1_seg_mesh/eye.glb \
  --samples 50000
```

`tools/bench/node_modules` is git-ignored, hence the `npm install` first, and the
source scan is not in git either — [`tools/bench/README.md`](tools/bench/README.md)
has the `curl` lines that fetch it from Hugging Face.

## Support and governance

**Maintainers.** Kush Shah ([@kush1434](https://github.com/kush1434)) is the
primary maintainer and reviews incoming issues and pull requests; Jian Gong
([@GoJian](https://github.com/GoJian)) owns the canonical repository. Author
credit for the accompanying paper is a separate list, in [`paper.md`](paper.md).

**Code of conduct.** Participation is governed by the
[Contributor Covenant](CODE_OF_CONDUCT.md). Report unacceptable behaviour to the
maintainers through the issue tracker.

**Getting help.** Use the [issue tracker](https://github.com/GoJian/awg_retina_tomography_ui/issues)
for bugs, questions about the data, and feature requests — there is no separate
support channel, and questions asked in the open help the next person. Expect a
first response within about two weeks. This is a small research project rather
than a funded product: quiet periods happen, and an unanswered issue is a
backlog, not a refusal.

**How decisions get made.** Maintainers decide by consensus on the issue or pull
request itself, so the reasoning stays with the change. Two commitments shape
what gets accepted: the viewer keeps its no-build, no-runtime-dependency
character (anything beyond `three` needs a case made in an issue first), and
`core/` stays free of the DOM — the scan in `test/core/dom-free.test.js` is the
binding check, not a style preference.

**Breaking changes.** `core/`'s exported API follows semantic versioning; a
breaking change needs a major version and a [`CHANGELOG.md`](CHANGELOG.md) entry.
Releases are git tags of the form `vMAJOR.MINOR.PATCH`. Because the package is
not on npm, an install resolves to whatever the branch you name points at that
day, so pin something: a tag once one has been cut, and until then the commit you
tested against —
`npm install github:kush1434/awg_retina_tomography_ui#<commit>`.

## Licensing

The viewer's code is MIT. The bundled reference eye models keep their upstream
licences (GPL-3.0 and CC BY 4.0) and are documented in
[`optimized/anatomy/README.md`](optimized/anatomy/README.md). By contributing you
agree that your contribution is licensed under the MIT licence.
