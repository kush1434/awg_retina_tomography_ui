# Retina Tomography Viewer

An interactive **3D web viewer** for GeneLab AWG retina micro-tomography. It shows
two linked views side by side — a reference **eye anatomy** model on the left and
the individually toggleable **segmented tissue layers** on the right — built with
[Three.js](https://threejs.org/) and a zero-build static front end.

---

## Features

- **Split, synchronised views** — rotate the eye anatomy and the segmented layers
  in tandem (the **Sync** button mirrors orbit orientation while each view keeps
  its own zoom), or explore them independently.
- **Switchable reference eyes** — pick from three published open-source eye
  models (mesh.eye, the Feel++ CAD eye, and the Upatras OpenSim oculomotor model
  with its six extraocular muscles). Each is shipped as separate named
  structures — cornea, iris, lens, vitreous, sclera, choroid, retina, zonules,
  retinal vessels, lamina cribrosa, optic nerve, extraocular muscles — every one
  independently toggleable, recolourable, fadeable and sliceable, with
  per-model presets. Retina, choroid and sclera are tagged `µCT` because the
  segmentation on the right resolves them too, so the two panes can be read
  against each other.
- **On-demand layers** — each segmented structure loads only when toggled, with a
  real progress bar, a cancel control, and recolour / opacity sliders.
- **Fast by default** — heavy source scans (≈1 GB STL meshes) are decimated and
  Draco-compressed to a few hundred KB each and shipped with the app, so a first
  visit downloads well under 10 MB instead of over 1 GB.
- **Browser caching** — assets are cached via the Cache Storage API, so they
  download once and load instantly afterwards.
- **Responsive** — a draggable divider on desktop; a collapsible drawer and
  stacked views on mobile.

---

## Running locally

No build step or dependencies — just serve the folder over HTTP (ES modules and
the Cache API require `http://localhost`, not `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

### Useful URL parameters

| Parameter  | Purpose                                              |
|------------|------------------------------------------------------|
| `?dataset=<url>`  | Load an alternative manifest (CSV).           |
| `?model=<id>`     | Pick the reference eye: `mesheye`, `humaneye`, `upat`. |
| `?anatomy=<url>`  | Override the left-pane anatomy model URL outright. |

---

## How it works

| File              | Responsibility                                             |
|-------------------|------------------------------------------------------------|
| `index.html`      | Markup, theming, Three.js import map.                       |
| `core/`           | The DOM-free library: scenes, cameras, clipping, sync, layer & anatomy loading, view state — events out, adapters in. Entry `core/index.js`; see [Using the core in your own page](#using-the-core-in-your-own-page). |
| `app/browser-adapters.js` | The one browser-only seam: WebGL renderer, OrbitControls on the canvas, resize observation. |
| `app/ui/`         | The view: `chrome.js` (toasts, confirm, HUD, study menu, status-bar mirrors of the view events), `layer-panel.js` and `anatomy-panel.js` (the two rails — DOM in, `wb.*` calls out, events rendered back). |
| `viewer.js`       | The controller entry: builds the workbench with the browser adapters, reads the URL, wires the top-level controls and runs the frame loop. |
| `data-loader.js`  | Loads & parses the dataset manifest; resolves optimized assets. |
| `asset-loader.js` | Streaming downloads with progress, cancellation & caching. |
| `optimized/`      | Pre-optimized GLBs that ship with the app.                 |
| `optimized/anatomy/` | The reference eye models, their provenance and licences. |

### Data

The dataset **manifest** (a CSV) and the original full-resolution scans live in a
[Hugging Face dataset](https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui).
The manifest lists, per sample, each segmented structure and a link to its mesh.

At load time the app prefers an **optimized** copy of each mesh from `optimized/`
(same-origin, tiny) and transparently falls back to the original on Hugging Face
if an optimized copy is not present. The Hugging Face data is never modified.

### Reference eye models

The left pane is **not** NASA data — it is a published open-source eye model,
shown for orientation:

| id | Model | Structures | Licence |
|----|-------|-----------:|---------|
| `mesheye`  | [feelpp/mesh.eye](https://github.com/feelpp/mesh.eye) — *A 3D geometrical model and meshing procedures for the human eyeball* ([doi:10.5281/zenodo.13829740](https://doi.org/10.5281/zenodo.13829740)) | 10 | GPL-3.0 |
| `humaneye` | The SolidWorks CAD eye that mesh.eye derives from; adds zonules and retinal vessels | 10 | GPL-3.0 |
| `upat`     | [Upatras OpenSim oculomotor model](https://simtk.org/projects/eye) ([arXiv:1807.07332](https://arxiv.org/abs/1807.07332)) — globe + six extraocular muscles | 8 | CC BY 4.0 |

All three are **human** eyes while the segmented scan is **mouse**; they are
references for orientation, not for morphometric comparison. The model menu also
lists the projects surveyed that ship no 3D geometry (ISETBio, OpenRetina,
V-Cornea, OpenEyeSim, pulse2percept, Open Source Brain), disabled and with the
reason, rather than hiding them.

The models keep their upstream licences and are merely aggregated with the
viewer's MIT code. Full provenance, structure tables and licences:
[`optimized/anatomy/README.md`](optimized/anatomy/README.md).

### Regenerating optimized assets

The optimized GLBs are produced from the source meshes with
[`gltf-transform`](https://gltf-transform.dev/) (decimation + Draco compression);
the eye models are rebuilt from their upstream sources with
[`tools/optimize/anatomy/build-anatomy.sh`](tools/optimize/anatomy/build-anatomy.sh).
See [`tools/optimize/`](tools/optimize) for the pipeline.

---

## Using the core in your own page

`core/` is the viewer without the viewer: scenes, cameras, clipping, camera
sync and the layer / anatomy loading state machines, with no DOM anywhere in
its module graph. It takes its renderer and controls through injected
**adapters**, its bytes through an injected **io**, and reports every
transition through an **event emitter** — so the same library drives the page
in this repo, a page of your own, or a Node process with no browser at all.

### Getting it

It is not on npm. Install it from git, or copy `core/`,
`app/browser-adapters.js` and `asset-loader.js` into your own project and
import them by relative path:

```bash
npm install github:GoJian/awg_retina_tomography_ui three   # three is a peer dependency (^0.169.0)
```

| Import | What you get |
|---|---|
| `awg-retina-tomography-ui` | the core barrel — `createWorkbench`, `createPane`, the clipping / framing / materials helpers ([`core/index.js`](core/index.js)) |
| `awg-retina-tomography-ui/browser` | `browserAdapters(el)` and `mountPane(pane, el)` — the WebGL / OrbitControls / ResizeObserver half |
| `awg-retina-tomography-ui/headless` | `headlessAdapters()` — a stub renderer plus the real OrbitControls, for Node |
| `awg-retina-tomography-ui/asset-loader` | `fetchBuffer` / `isCached` — streaming downloads with progress, cancellation and Cache Storage |
| `awg-retina-tomography-ui/data-loader` | the CSV manifest parser, if you want this repo's dataset format too |

### A minimal page

The core imports `three` and `three/addons/` by bare specifier, so a page with
no build step needs the same import map `index.html` carries (a bundler
resolves both from `node_modules` instead):

```html
<script type="importmap">
{ "imports": {
    "three": "https://esm.sh/three@0.169.0",
    "three/addons/": "https://esm.sh/three@0.169.0/examples/jsm/",
    "awg/": "./node_modules/awg-retina-tomography-ui/"
} }
</script>
<div id="left"></div><div id="right"></div>

<script type="module">
import { createWorkbench } from 'awg/core/index.js';
import { browserAdapters, mountPane } from 'awg/app/browser-adapters.js';
import { fetchBuffer, isCached } from 'awg/asset-loader.js';

const left = document.getElementById('left'), right = document.getElementById('right');
const wb = createWorkbench({
  adapters: { glb: browserAdapters(left), stl: browserAdapters(right) },
  io: { fetchBuffer, isCached },
  anatomyUrl: '/models/eye-anatomy.glb',   // the registry URLs are relative to THIS repo's page
});
mountPane(wb.panes.glb, left);
mountPane(wb.panes.stl, right);
requestAnimationFrame(function frame(now) { wb.tick(now); requestAnimationFrame(frame); });

wb.on('layer:state', ({ id, state }) => console.log(id, state));   // render the events you care about

wb.anatomy.load();                                   // reference eye → left pane
wb.layers.setSamples(samples);                       // your meshes → right pane (shape below)
wb.layers.load(wb.layers.findStructure('s1__retina'));
</script>
```

`createWorkbench` takes `{ adapters, io, loaders, parsers, modelId, anatomyUrl,
startTime }`. `adapters` is required — one `{ createRenderer, createControls }`
pair for both panes or `{ glb, stl }` for one each — and is the only place a
WebGL context is made. `io` is any `{ fetchBuffer(url, { signal, onProgress }),
isCached(url) }`; `loaders` / `parsers` let you swap in your own Three loaders
(a self-hosted Draco decoder, say). Nothing is loaded until you ask.

### The records `layers` takes

`wb.layers.setSamples(...)` wants the data-loader's own records. They are plain
objects, so you can build them yourself — one sample per subject, one structure
per downloadable mesh:

```js
const samples = [{
  id: 's1',                            // unique; the `sampleId` in every event
  label: 'Sample 1',
  offset: { x: 0, y: 0, z: 0 },        // position in the shared workspace, as a fraction of its size
  opacity: 1,                          // whole-sample opacity multiplier
  structures: [{
    id: 's1__retina',                  // unique; the `id` in every layer:* event
    sampleId: 's1',
    label: 'Retina',
    path: '/meshes/retina.glb',        // what io.fetchBuffer is called with
    kind: 'gltf',                      // 'gltf' → glTF/GLB, anything else → binary STL
    color: 0xd9634c,
    opacity: 1,
    bytes: null,                       // size when known; over 400 MB `layers.isHeavy()` is true
  }],
}];
```

`color` and `opacity` are written back by `setColor` / `setOpacity`, and
`offset` by the offset setters — the records are the live state, not a copy.

### The events

`wb.on(name, fn)` returns an unsubscribe; `wb.once` and `wb.off` are there too.
The core never touches a widget — this table is the whole interface out:

| Event | Payload |
|---|---|
| `rendermode` | `{ mode: 'surface' \| 'wireframe' \| 'slices' }` |
| `clip` | frozen `{ x: { on, pos }, y, z, flip, showPlanes }` |
| `layout` | `{ layout: 'split' \| 'overlay' }` |
| `sync` `autorotate` `grid` `linkoffsets` `solidfill` | `{ on }` |
| `opacity` | `{ global }` |
| `sample:offset` | `{ sampleId, axis, value }` |
| `layer:state` | `{ id, state: 'idle' \| 'loading' \| 'loaded' \| 'error', phase?: 'start' \| 'cache' \| 'build', cached? }` |
| `layer:progress` | `{ id, loaded, total, pct }` (`pct` is 0 when the response has no `Content-Length`) |
| `layer:error` | `{ id, label, error }` |
| `layers:visible` | `{ anyVisible, visibleIds }` |
| `anatomy:model` | `{ id, model, isDefault, preset }` |
| `anatomy:status` | `{ state: 'idle' \| 'loading' \| 'loaded' \| 'error', phase?: 'start' \| 'download' \| 'build', pct?, loaded?, total?, fromCache?, message? }` |
| `anatomy:parts` | `{ modelId, keys, unmatched, preset }` |
| `anatomy:preset` | `{ name, preset }` |
| `anatomy:style` | `{ key, state: { visible, color, opacity } }` |
| `anatomy:opacity` `anatomy:visible` `anatomy:offset` | `{ value }` / `{ on }` / `{ axis, value, offset }` |
| `stats` | `{ az, el, triangles, fps }` — emitted from `tick(now)`, at most every 250 ms |

Neither controller ever rejects: a failed download arrives as `layer:state
error` + `layer:error` (or `anatomy:status error`), and a cancelled one as a
single `idle`.

### Without a browser

`headlessAdapters()` swaps the WebGL renderer for a stub and keeps the real
OrbitControls, so the whole library — loading, styling, clipping, framing,
camera sync — runs under Node. That is how `npm test` exercises it; see
[`test/core/`](test/core) for worked examples.

---

## Tests

```bash
npm ci                         # three is a devDependency (headless core tests)
npm test                       # unit tests — Node >= 20
npx playwright install chromium
npm run test:e2e               # browser tests against the real viewer
```

`npm test` covers the manifest parser, the optimized-asset resolution, the
Hugging Face retry, the streaming/caching asset loader, the geometry code
behind the reported decimation error, and the whole `core/` library run
headless — pane construction with a stub renderer and the real OrbitControls,
clipping planes and caps, camera sync, STL/glTF parsing of synthetic meshes,
the layer and anatomy loading state machines, and every workbench transition —
plus a static scan proving no core module reaches for a browser global, and
the `app/ui/` view modules rendered into a small fake DOM over a headless
workbench (507 tests, Node's built-in runner; `three` is the only devDependency
the unit tests need — `@playwright/test` serves the browser suite alone).
`npm run test:e2e` drives the actual application in Chromium and checks that
WebGL starts, that a toggled layer reaches the GPU, that the asset cache fills,
and that the controls behave (18 tests). Both run in CI on every push, along
with a decode of every shipped asset.

## Benchmarks

```bash
cd tools/bench && npm install && node bench.mjs
```

Reports the size, triangle count and compression of every shipped asset, and
the first-paint payload. `node bench.mjs --verify <source.stl> <optimized.glb>`
measures the surface error introduced by decimation. See
[`tools/bench/README.md`](tools/bench/README.md).

Measured on the shipped assets:

| Source mesh | Triangles | Size | Shipped | Reduction | Mean surface error | Area change |
|---|---:|---:|---:|---:|---:|---:|
| `eye.stl` | 21,141,576 | 1008 MB | 633 KB | 1631x | 0.017% | +0.63% |
| `feature.stl` | 3,131,220 | 149 MB | 325 KB | 471x | 0.006% | +0.21% |

Errors are symmetric point-to-surface distances as a fraction of the
bounding-box diagonal. The viewer is meant for orientation, teaching and
qualitative inspection — **not** as a substitute for the source mesh in
morphometric analysis.

## Contributing

Bug reports, questions and pull requests are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Deployment

This is a static site; it deploys as-is to any static host.

- **Vercel** — `npx vercel` from this folder (config in `vercel.json`), or import
  the repo at vercel.com.
- **GitHub Pages** — enable Pages → "GitHub Actions"; the workflow in
  `.github/workflows/pages.yml` publishes the site on every push to `main`.

---

## Credits

- [Three.js](https://threejs.org/) · [STLLoader](https://threejs.org/docs/#examples/en/loaders/STLLoader) · [GLTFLoader](https://threejs.org/docs/#examples/en/loaders/GLTFLoader) · [OrbitControls](https://threejs.org/docs/#examples/en/controls/OrbitControls)
- Source scans produced with [3D Slicer](https://www.slicer.org/) and hosted on [Hugging Face](https://huggingface.co/datasets).
- Reference eye models from [feelpp/mesh.eye](https://github.com/feelpp/mesh.eye) and the [Upatras OpenSim oculomotor model](https://gitlab.com/mitkof6/upat_eye_model), tessellated with [gmsh](https://gmsh.info).

## License

MIT © 2025 — except the eye models under `optimized/anatomy/`, which keep their
upstream licences (GPL-3.0 and CC BY 4.0). See
[`optimized/anatomy/README.md`](optimized/anatomy/README.md).
