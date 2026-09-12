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
| `core/`           | The DOM-free library: scenes, cameras, clipping, sync, layer & anatomy loading, view state — events out, adapters in. Entry `core/index.js`. |
| `app/browser-adapters.js` | The one browser-only seam: WebGL renderer, OrbitControls on the canvas, resize observation. |
| `viewer.js`       | View + controller: turns DOM input into workbench calls and renders its events. |
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
plus a static scan proving no core module reaches for a browser global
(417 tests, Node's built-in runner; `three` is the only devDependency the
unit tests need — `@playwright/test` serves the browser suite alone).
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
