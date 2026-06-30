# Retina Tomography Viewer

An interactive **3D web viewer** for GeneLab AWG retina micro-tomography. It shows
two linked views side by side — the whole **eye anatomy** on the left and the
individually toggleable **segmented tissue layers** on the right — built with
[Three.js](https://threejs.org/) and a zero-build static front end.

---

## Features

- **Split, synchronised views** — rotate the eye anatomy and the segmented layers
  in tandem (the **Sync** button mirrors orbit orientation while each view keeps
  its own zoom), or explore them independently.
- **On-demand layers** — each segmented structure loads only when toggled, with a
  real progress bar, a cancel control, and recolour / opacity sliders.
- **Fast by default** — heavy source scans (≈1 GB STL meshes, a 137 MB anatomy
  model) are decimated and Draco-compressed to a few hundred KB each and shipped
  with the app, so a first visit downloads ~8 MB instead of well over 1 GB.
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
| `?anatomy=<url>`  | Override the left-pane anatomy model URL.     |

---

## How it works

| File              | Responsibility                                             |
|-------------------|------------------------------------------------------------|
| `index.html`      | Markup, theming, Three.js import map.                       |
| `viewer.js`       | Scenes, cameras, controls, sync, loading, UI wiring.       |
| `data-loader.js`  | Loads & parses the dataset manifest; resolves optimized assets. |
| `asset-loader.js` | Streaming downloads with progress, cancellation & caching. |
| `optimized/`      | Pre-optimized GLBs that ship with the app.                 |

### Data

The dataset **manifest** (a CSV) and the original full-resolution scans live in a
[Hugging Face dataset](https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui).
The manifest lists, per sample, each segmented structure and a link to its mesh.

At load time the app prefers an **optimized** copy of each mesh from `optimized/`
(same-origin, tiny) and transparently falls back to the original on Hugging Face
if an optimized copy is not present. The Hugging Face data is never modified.

### Regenerating optimized assets

The optimized GLBs are produced from the source meshes with
[`gltf-transform`](https://gltf-transform.dev/) (decimation + Draco compression).
See [`tools/optimize/`](tools/optimize) for the conversion script and pipeline.

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

## License

MIT © 2025
