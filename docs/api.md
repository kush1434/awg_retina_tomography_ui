# Core API reference

Every function and method the core library exports, with what it does, what it
emits and what it expects. The [README](../README.md#using-the-core-in-your-own-page)
is the tour — start there; this is the index you come back to.

The core is Three-only and DOM-free: it makes no network request of its own
(bytes arrive through the injected `io`), constructs no WebGL context (renderers
arrive through the injected `adapters`), and touches no widget (everything the
outside world needs to know leaves through the emitter). Nothing here is
reactive: a setter applies its change immediately and emits once.

Import paths below use the package name; inside this repository the same
modules are `./core/index.js`, `./core/adapters-headless.js` and so on.

```js
import { createWorkbench } from 'awg-retina-tomography-ui';
```

---

## `createWorkbench(options)`

Builds the two panes, the camera sync, the layer and anatomy controllers and the
shared view state, and returns the whole application surface. Nothing is
downloaded until you call `anatomy.load()` or `layers.load(...)`.

| Option | Required | Meaning |
|---|---|---|
| `adapters` | yes | One `{ createRenderer, createControls }` pair used by both panes, or `{ glb, stl }` for one each. See [Adapters](#adapters). `createPane` throws a `TypeError` if either function is missing. |
| `io` | yes in practice | `{ fetchBuffer(url, { signal, onProgress }), isCached(url) }`. The workbench is constructed without it, but a `load()` then fails and reports the failure as an error event. |
| `loaders` | no | From [`createLoaders`](#createloadersopts). Built with the default Draco decoder path when omitted. |
| `parsers` | no | From [`createMeshParsers`](#createmeshparsersloaders). Derived from `loaders` when omitted. |
| `modelId` | no | The `?model=` value for the reference eye. An unknown, unavailable or missing id falls back to `mesheye`. |
| `anatomyUrl` | no | Overrides the reference-eye file outright, bypassing the registry. |
| `startTime` | no | Seeds the fps window; the app passes `performance.now()`. Default `0`. |

### What it returns

**Sub-objects**

| Member | What it is |
|---|---|
| `panes` | `{ glb, stl }` — the two panes from [`createPane`](#createpaneoptions). |
| `layers` | The [`LayerController`](#wblayers-layercontroller) for the segmented layers (the `stl` pane). |
| `anatomy` | The [`AnatomyController`](#wbanatomy-anatomycontroller) for the reference eye. |
| `sync` | The [`CameraSync`](#wbsync-camerasync) linking the two panes. Use `setSync(on)` rather than linking it yourself. |

**View state** — each applies the change to both panes and emits once.

| Method | Effect and event |
|---|---|
| `setRenderMode(mode)` | `'surface'` / `'wireframe'` / `'slices'`. Entering `slices` with no axis cut turns on the x cut first (and emits `clip`), so something is visibly sliced. Emits `rendermode`. |
| `setLayout(mode)` | `'split'` (anatomy in its own pane) or `'overlay'` (anatomy merged into the workspace). Re-places the anatomy. Emits `layout`. |
| `setClipAxis(axis, on)` | Turn the cut on one of `'x' \| 'y' \| 'z'` on or off. Emits `clip`. |
| `setClipPos(axis, frac)` | Move that cut; `frac` is 0–1 across the bounds. Emits `clip`. |
| `setClipFlip(on)` | Keep the other side of every cut. Emits `clip`. |
| `setShowPlanes(on)` | Show the translucent slice quads. Emits `clip`. |
| `setSync(on)` | Link or unlink orbit mirroring. Emits `sync` **before** (un)linking, so a listener sees the new state. |
| `setAutoRotate(on)` | Orbit both panes while idle. Emits `autorotate`. |
| `setGrid(on)` | Show the ground grid (hidden anyway while the bounds are empty). Emits `grid`. |
| `setGlobalOpacity(v)` | 0–1 multiplier over every layer's own opacity. Emits `opacity`. |
| `setLinkOffsets(on)` | Move every sample's offset together; turning it on snaps every sample to the first one's offset (each snap emits `sample:offset`). Emits `linkoffsets`. |
| `setSolidFill(on)` | Swap the F10 coats for their solid-slab variants. Emits `solidfill`, then **returns the promise** of reloading every affected layer — await it if you need the reload finished. |
| `applyRenderModeAll()` | Re-apply the current render mode to both panes. Emits nothing; for callers that changed materials underneath. |
| `state()` | A frozen snapshot: `{ renderMode, layout, globalOpacity, autoRotate, linkOffsets, solidFill, grid, sync, clipState }`. Read-only — mutating it changes nothing. |

**Framing and the frame loop**

| Method | Effect |
|---|---|
| `resetPane(id)` | Re-frame one pane (`'glb'` or `'stl'`): the workspace on its sample groups, the anatomy on the globe along `ANATOMY_VIEW_DIR`. |
| `resetAll()` | `resetPane` for both. |
| `refitAfterReflow(layoutAtSwitch)` | Re-frame the workspace after the panes have changed size — pass the layout captured when the switch was made. No-op while nothing is loaded. |
| `resize(id, w, h)` | Resize one pane and update its camera aspect. `mountPane` calls this for you in the browser. |
| `tick(now)` | One frame: controls update, headlight, both renders, fps. `now` is your clock in milliseconds. Emits `stats` at most every 250 ms. You own the `requestAnimationFrame` loop. |
| `dispose()` | Unlink the sync, cancel the anatomy load, abort every in-flight layer, dispose both panes. Does not remove canvases — `mountPane`'s `unmount` does that. |

**Events** — `on(name, fn)` returns an unsubscribe function; `off(name, fn)` and
`once(name, fn)` are also present. Listeners run synchronously, in registration
order, on the emitting call stack; an exception thrown by a listener propagates
to the caller that triggered it. The payloads are tabulated in the
[README](../README.md#the-events).

---

## `wb.layers` (LayerController)

Owns one normalised `THREE.Group` per sample under the workspace pane's `root`,
the loaded layer objects, the in-flight downloads, and the colour / opacity /
offset rules. The sample and structure records it is given are the live state —
it writes `structure.color`, `structure.opacity` and `sample.offset` back onto
them.

**Records**

| Method | Contract |
|---|---|
| `setSamples(samples)` | Adopt the records (shape in the [README](../README.md#the-records-layers-takes)). Nothing is loaded; call it before anything else. |
| `findStructure(id)` | The structure record, or `null`. |
| `findSample(id)` | The sample record, or `null`. |
| `has(id)` | Whether that layer's object is loaded. |
| `groupCount()` | How many sample groups exist (a group appears on a sample's first load). |
| `getSampleGroup(sampleId)` | The sample's group, creating and attaching it if needed. |
| `normalizeSample(sampleId)` | Re-scale and re-position that group from its record's `offset`. |

**Loading** — `load()` never rejects.

| Method | Contract |
|---|---|
| `load(structure)` | Download through `io.fetchBuffer`, parse with `parsers`, attach, colour, normalise, re-frame. Emits `layer:state` `loading` (`phase` `start`, then `cache` or repeated `layer:progress`, then `build`), and finally `loaded` with `cached`. A failure emits `layer:state` `error` + `layer:error`; an abort emits a single `layer:state` `idle`. Never rejects — even a missing `io` arrives as `layer:error`. |
| `abort(id)` | Cancel that download. Says nothing itself — the `idle` comes from `load`. |
| `abortAll()` | Cancel every in-flight download. |
| `reloadFillVariants()` | Re-load every loaded F10 coat from the currently selected variant, preserving each row's visibility. Awaited by `setSolidFill`. |
| `isHeavy(structure)` | `true` when the record's `bytes` exceed `HEAVY_BYTES` (400 MB). The rule only — the confirm prompt belongs to the app. |
| `effectivePath(structure)` | The URL `load` would fetch, honouring Solid fill. |

`HEAVY_BYTES` and `effectivePath` are also exported from the barrel in their
unbound form, along with the `solidVariant` that `effectivePath` consults — see
[Layer paths](#geometry-helpers). The exported `effectivePath` takes
`(structure, view)`; the method above is it with this controller's `view` bound.

**Appearance**

| Method | Contract |
|---|---|
| `setColor(structure, hex)` | Writes `structure.color`, re-tints the object, rebuilds caps. Emits nothing (the app already knows). |
| `setOpacity(structure, v)` | Writes `structure.opacity` and re-applies. Effective opacity is per-layer × per-sample × global. |
| `setSampleOpacity(sample, v)` | Writes `sample.opacity` and re-applies to all its structures. |
| `setVisible(id, on)` | Show / hide one layer, then `syncVisibility()`. Safe for an id that is still downloading. |
| `setSampleVisible(sampleId, on)` | Show / hide a whole sample group. Does **not** sync visibility or rebuild caps. |
| `reapplyOpacity(structure)` / `reapplyAllOpacity()` | Recompute effective opacity after the global multiplier changed. |
| `anyVisible()` / `visibleIds()` | The current visibility, as a boolean / an array of ids. |
| `syncVisibility()` | Rebuild the cross-section caps and emit `layers:visible`. |

**Offsets and framing**

| Method | Contract |
|---|---|
| `setSampleOffset(sample, axis, value)` | Write one axis (a fraction of the workspace size), emit `sample:offset`, re-normalise the group. |
| `offsetChanged(sample, axis, value)` | The same, applied to every sample when `linkOffsets` is on, then refreshes the clip bounds. This is the one the UI calls. |
| `resetOffsets(sample)` | Zero all three axes (every sample when linked). |
| `snapOffsetsToFirst()` | Move every sample to the first sample's offset; what `setLinkOffsets(true)` does. |
| `workspaceBox()` | Union `THREE.Box3` of the visible, non-empty sample groups, falling back to everything under `pane.root`. |
| `fitStl(offset = 1.45)` | Frame the workspace box (the app uses 1.7 in overlay). No-op when empty. |
| `focusSample(sampleId)` | Frame one sample group. |

---

## `wb.anatomy` (AnatomyController)

Owns which registry model is showing, the loaded scene, the meshes it matched to
named structures, their per-structure state, the active preset, the pane-level
opacity and the overlay offset.

**Reading**

`object`, `group`, `parts` (the live `key → Mesh` map — read only), `preset`,
`opacity`, `offset` (a copy) and `loading` are getters. Plus:

| Method | Returns |
|---|---|
| `modelId()` / `model()` | The active id / its registry record. |
| `url()` | `anatomyUrl` when one was injected, else the model's own (relative) URL. |
| `presets()` | The model's presets, or `{}`. |
| `structures()` | The model's structures that matched a mesh, in registry order. |
| `meta(key)` | Registry metadata for one structure of the active model. |
| `stateFor(key)` | The live `{ visible, color, opacity }`, created from the registry defaults on first access. |
| `keyOf(mesh)` | The structure key for a mesh, matching its name or the nearest named ancestor; `null` when nothing matches. |
| `focusBox()` | The box the pane frames on — the sclera when visible, else the whole model. |
| `state()` | A frozen `{ modelId, url, preset, opacity, offset, visible, partKeys, loading }`. |

`ANATOMY_VIEW_DIR` (also on the barrel) is the `THREE.Vector3(-0.72, 0.26, 0.64)`
that both `place()` and `wb.resetPane('glb')` hand to `fitBox`, so the reference
eye always opens on the same three-quarter anterior view. The models put the
cornea at −X; a straight lateral view would show only a featureless white globe.

**Loading and placement** — `load()` never rejects.

| Method | Contract |
|---|---|
| `load()` | Download, parse and place the active model. Emits `anatomy:status` `loading` (`phase` `start`, `download` with `pct`, `build`), then `anatomy:parts`, then `loaded`. A failure emits `status` `error` with `message`; an abort emits a single `idle`. |
| `setModel(id)` | Switch models: aborts any load, disposes the current scene and per-structure state, emits `anatomy:model`, then `load()`s. Ignores an unknown id or the id already active. |
| `cancel()` | Abort an in-flight load. Says nothing itself. |
| `place()` | Re-parent the model for the current layout — its own pane in split, the normalised overlay group in the workspace — and re-frame. Called by `setLayout`. |
| `registerParts(scene)` | Match meshes to structure keys; returns `{ keys, unmatched }`. Called by `load`. |

**Styling**

| Method | Contract |
|---|---|
| `setVisible(key, on)` | Show / hide one structure. Emits `anatomy:style`. |
| `setColor(key, hex)` | Re-tint one structure. Emits `anatomy:style`. |
| `setOpacity(key, v)` | Fade one structure. Emits `anatomy:style`. |
| `setPreset(name)` | Apply a named preset (`whole`, `coats`, `media`, …): sets every structure's visibility and opacity, emits `anatomy:style` per structure, then `anatomy:preset`. Unknown names are ignored. |
| `applyStyle(key)` / `applyStyleAll()` | Push the current state onto the meshes (including the back-face pass that makes translucent shells blend in order). Emits nothing. |
| `setPaneOpacity(v)` | Scale every structure's own alpha, keeping their relative translucency. Emits `anatomy:opacity`. |
| `setObjectVisible(on)` | Show / hide the whole model. Emits `anatomy:visible`. |
| `setOffset(axis, v)` | Move the overlay wrapper on one axis (a fraction of the workspace size). Emits `anatomy:offset`; only re-normalises while in overlay. |

---

## `wb.sync` (CameraSync)

`new CameraSync(a, b)` mirrors orbit **orientation** between two panes — each
keeps its own distance and target. `enabled` is a read-only getter; `link()`
attaches the `change` listeners and mirrors `a` onto `b` immediately;
`unlink()` detaches them. Prefer `wb.setSync(on)`, which also emits `sync`.

---

## `createPane(options)`

One viewport: scene, lights, camera, controls, the `root` group and the slice
helpers. Throws `TypeError: createPane: adapters { createRenderer,
createControls } are required` when either adapter is missing.

Options: `id` (the name the app addresses the pane by), `capsEnabled` (fill
sliced cross-sections with stencil caps — the workspace pane only),
`headLight` (add a camera-tracking light the caller moves each frame — the
anatomy pane), `adapters`.

Returns `{ id, scene, camera, renderer, controls, root, clipPlanes,
activeClips, sliceGroup, sliceQuads, boxHelper, grid, capGroup, bounds,
defaultDist, capsEnabled, headLight, resize(w, h), render(), dispose() }`.
`resize` calls `setSize(w, h, false)` — it never writes the canvas's CSS, which
is why your page must size the canvas itself.

`PLANE_COLORS` is the `{ x, y, z }` map of slice-plane colours (sagittal /
axial / coronal).

---

## Adapters

An adapter pair is the only place a renderer or a set of controls is created.
The contract is written out in the
[README](../README.md#writing-your-own-adapters); `core/adapters-headless.js` is
the reference implementation.

| Export (subpath `./headless`) | What it is |
|---|---|
| `headlessAdapters()` | A stub renderer (no canvas, no GL, `info.render.triangles` fixed at 0) plus the real OrbitControls. Enough to run loading, styling, clipping, framing and sync under Node. |
| `stubElement()` | The minimum DOM-shaped object OrbitControls needs: listener registration, a style bag, an owner document, pointer capture and a size. One fresh object per call. |

Neither is re-exported from the core barrel, deliberately: a browser build never
pulls them in.

The browser pair lives at subpath `./browser`: `browserAdapters(mountEl)`
(WebGLRenderer capped at devicePixelRatio 2, canvas appended to `mountEl` before
the controls are made, DOM-wired OrbitControls) and `mountPane(pane, el)`, which
sizes the pane to `el` now and on every reflow and returns
`{ measure, unmount }` — `unmount` stops observing and removes the canvas,
symmetric with `pane.dispose()`.

---

## Loaders and parsers

### `createLoaders(opts)`

`createLoaders({ dracoDecoderPath })` returns `{ dracoLoader, gltfLoader,
stlLoader }`. `dracoDecoderPath` defaults to
`https://www.gstatic.com/draco/versioned/decoders/1.5.7/`; point it at a
directory you serve to drop that third-party fetch. The loaders never fetch
geometry — buffers arrive through `io` — but a Draco-compressed GLB does need
the decoder files at that path.

### `createMeshParsers(loaders)`

Returns the three parsers the controllers call:

- `parseSTL(buffer, structure)` — a segmented layer as one mesh in the
  structure's colour, with vertex normals computed. Synchronous.
- `parseGLTF(buffer)` — a segmented layer scene, every mesh re-skinned white
  (the controller applies the structure colour afterwards). Returns a promise;
  rejects on a malformed buffer.
- `parseAnatomyGLTF(buffer)` — the reference eye, materials and node names kept
  (the names are what structures are matched by). Returns a promise.

---

## The anatomy registry

Plain data, no DOM, no Three: the models the left pane can show.

| Export | What it is |
|---|---|
| `ANATOMY_MODELS` | Every model, including the surveyed ones flagged `unavailable` with the reason they ship no geometry. |
| `DEFAULT_MODEL_ID` | `'mesheye'`. |
| `STRUCTURE_STYLES` | The per-structure defaults (label, group, colour, opacity, roughness, nesting `depth`, and `coat` for the structures the µCT also resolves). |
| `modelById(id)` | The model record, or `undefined` for an unknown or unavailable id. |
| `resolveModelId(id)` | `id` when it names an available model, else `DEFAULT_MODEL_ID`. The `?model=` rule. |
| `structureMeta(model, key)` | One structure's metadata within a model, or `undefined`. |
| `presetOf(model, name)` | A named preset, or `undefined`. |

---

## Geometry helpers

These are pure functions, most of them pane-level — the workbench calls them for
you; they are exported because a consumer driving panes directly needs them.

**Clipping** (`core/clipping.js`)

| Export | Contract |
|---|---|
| `createClipState()` | A fresh mutable `{ x: { on, pos }, y, z, flip, showPlanes }`, every cut at 0.5. |
| `clipPlaneFor(axis, bounds, pos, flip)` | `{ normal, constant, cut }` for one cut; `pos` is a fraction of the bounds along `axis`. Pure. |
| `sliceQuadPlacement(axis, bounds, pos)` | `{ position, scale }` for that axis's translucent quad. Pure. |
| `updateBounds(pane, view)` | Recompute the pane's bounds from `root` and refresh the planes, quads, box helper and grid. No-op while `root` is empty. |
| `updateClips(pane, view)` | Rebuild `pane.activeClips` from the clip state and re-apply the render mode. |
| `applyRenderModeToPane(pane, view)` | Apply surface / wireframe / slices to every mesh in the pane, then rebuild caps. |
| `buildCaps(pane, view)` / `clearCaps(pane)` | Stencil caps that fill sliced cross-sections. `buildCaps` returns immediately unless the pane has `capsEnabled`, Solid fill is on, the mode is `slices` and exactly one plane is active. |
| `collectCapCoats(root)` | The meshes worth capping (visible, with geometry and material, not a helper or a back-face duplicate) and the colour each cap takes. |

**Framing** (`core/framing.js`)

| Export | Contract |
|---|---|
| `OVERLAY_TARGET` | `100` — the size every group is normalised to, so samples and the anatomy share one space. |
| `localBox(node)` | The bounding box of a node's content, ignoring the node's own transform. |
| `normalizeGroup(node, offset, target)` | Scale a group to `target`, centre it, then displace it by `offset` (a fraction of `target`). |
| `fitDistance({ fov, aspect }, maxDim, offset)` | The camera distance at which a sphere of diameter `maxDim` fills the *tighter* of the vertical and horizontal fields of view — which is what keeps a wide subject from being cropped in a tall pane. |
| `fitBox(pane, box, offset, dir)` | Frame a box: sets near / far, the controls target and the camera position, along `dir` when given. No-op for an empty box. |
| `fitToObject(pane, object, offset)` | `fitBox` over an object's world box; returns `false` and changes nothing when it is empty. |
| `unionBoxOfGroups(groups, fallbackRoot)` | Union box of the visible, non-empty groups, falling back to everything under `fallbackRoot`. |

**Layer paths** (`core/layers.js`) — module-level, not methods on
`LayerController`, though the controller binds them.

| Export | Contract |
|---|---|
| `HEAVY_BYTES` | `400 * 1024 * 1024` = `419430400` — the byte threshold [`isHeavy`](#wblayers-layercontroller) compares a record's `bytes` against. |
| `solidVariant(path)` | The locally-shipped solid-fill slab for an F10 ocular coat: any path containing `F10_layers/<name>.glb` — the remote Hugging Face original or a local optimized copy, matched case-insensitively and ignoring any query or fragment — maps to `optimized/F10_layers_solid/<name>.glb`. Anything else returns `null`. Pure. |
| `effectivePath(structure, view)` | The URL `load` would fetch for that structure: `solidVariant(structure.path)` when `view.solidFill` is on and a variant exists, otherwise `structure.path`. `wb.layers.effectivePath(structure)` is this function with the controller's own `view` already bound — mind the arity if you import the free one. |

**Materials** (`core/materials.js`) — `makeMaterial(colorHex, opacity)` (the
double-sided standard material every layer uses; transparent below 1),
`applyColor(object, colorHex)`, `setObjectOpacity(object, o)` (skips `noClip`
helpers and sets `renderOrder` so translucent meshes draw last) and
`disposeObject(obj)` (geometries and materials, recursively).

**Orientation** (`core/orientation.js`) — `applyOrientation(pane, az, polar)`
aims a camera from an azimuth / polar angle at its current distance;
`mirror(from, to, guard)` copies one pane's angles onto another behind a
re-entrancy guard.

**Emitter** (`core/emitter.js`) — `createEmitter()` returns
`{ on, off, once, emit }`. `on` throws a `TypeError` if the listener is not a
function and returns an unsubscribe. Delivery is synchronous and in
registration order: the app relies on `anatomy:model` landing before `load()`
starts and `layout` before the panes are re-parented.

---

## The app-level subpaths

Not part of the DOM-free core, but published alongside it.

**`./asset-loader`** — `fetchBuffer(url, { onProgress, signal })` streams a
download, reports `{ loaded, total, fromCache }`, stores the result in Cache
Storage and resolves to an `ArrayBuffer`; it throws `HTTP <status> <text>` on a
non-OK response and rejects with an `AbortError` when the signal fires. Caching
is best-effort: it is skipped outside a secure context and when the quota is
exceeded. `isCached(url)` answers from the cache alone; `clearCache()` empties
it.

**`./data-loader`** — this repository's CSV manifest format (columns in the
[README](../README.md#the-manifest-format)). `loadCSVData(csvUrl)` fetches and
parses the manifest into `samplesData` — trying up to four times with backoff,
because Hugging Face's edge answers the first cold request with HTTP 405 — and
appends the synthetic demo sample unless `?demo=off`. `fileKind(url)` maps an
extension to `'gltf'` or `'stl'`; `deriveOptimizedURL(url)` maps an STL URL to
its `optimized/….glb` path (`null` for anything else); `resolveStructure(st)`
switches a structure to its optimized copy when one is published and learns its
byte size (idempotent, memoised); `probeSizes(onResolved)` does that for every
structure; `formatBytes(n)` is the human-readable size used in the UI.
