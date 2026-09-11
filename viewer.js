// ============================================================================
//  viewer.js — Retina Tomography Workbench
//  Two linked Three.js scenes (eye-anatomy GLB | segmented layers) wrapped in a
//  clinical instrument-panel UI: synced orbit, render modes (surface / wireframe
//  / tri-planar slices via clipping planes), on-demand loading, caching & HUD.
// ============================================================================

import * as THREE from 'three';

import { loadCSVData, probeSizes, resolveStructure, samplesData, formatBytes } from './data-loader.js';
import { fetchBuffer, isCached, clearCache } from './asset-loader.js';
import { browserAdapters, mountPane } from './app/browser-adapters.js';
import { createPane } from './core/pane.js';
import { ANATOMY_MODELS, DEFAULT_MODEL_ID, modelById, resolveModelId, structureMeta, presetOf } from './core/anatomy-models.js';
import { normalizeGroup, fitBox, fitToObject } from './core/framing.js';
import { makeMaterial, setObjectOpacity, disposeObject } from './core/materials.js';
import {
  createClipState,
  updateBounds as coreUpdateBounds, updateClips as coreUpdateClips,
  applyRenderModeToPane as coreApplyRenderModeToPane, buildCaps as coreBuildCaps,
} from './core/clipping.js';
import { CameraSync } from './core/orientation.js';
import { createLoaders, createMeshParsers } from './core/mesh-parsers.js';
import { createEmitter } from './core/emitter.js';
import { LayerController, HEAVY_BYTES } from './core/layers.js';

// ---------------------------------------------------------------------------
//  DOM
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const layerTree = $('#layer-tree');
const viewportEl = $('#viewport');
const glbPane = $('#pane-glb');
const stlPane = $('#pane-stl');
const divider = $('#divider');
const glbOverlay = $('#glb-overlay');
const stlEmpty = $('#stl-empty');
const toastHost = $('#toast-host');
const btnSync = $('#btn-sync');

// ---------------------------------------------------------------------------
//  Global view state
// ---------------------------------------------------------------------------
const view = {
  renderMode: 'surface',                            // surface | wireframe | slices
  layout: 'split',                                  // split | overlay
  globalOpacity: 1,
  autoRotate: false,
  linkOffsets: false,                               // move all sample offsets together
  solidFill: false,                                 // default OFF: show the original individual coats; toggle on for the filled+capped view
  clipState: createClipState(),
};

// ---------------------------------------------------------------------------
//  Shared loaders
// ---------------------------------------------------------------------------
const parsers = createMeshParsers(createLoaders());

// ---------------------------------------------------------------------------
//  Panes
// ---------------------------------------------------------------------------
// The scene / camera / slice-helper half of a pane is built by core/pane.js;
// the WebGL renderer, DOM-wired OrbitControls and ResizeObserver come from
// app/browser-adapters.js. The anatomy pane gets a camera-tracking headlight
// (animate moves it); the segmented-coat pane gets solid cross-section caps
// when sliced.
const glb = createPane({ id: 'glb', headLight: true, adapters: browserAdapters(glbPane) });
const stl = createPane({ id: 'stl', capsEnabled: true, adapters: browserAdapters(stlPane) });
const mounts = { glb: mountPane(glb, glbPane), stl: mountPane(stl, stlPane) };
const panes = [glb, stl];

// ---------------------------------------------------------------------------
//  Events
// ---------------------------------------------------------------------------
// The core library talks outward only through this emitter; the listeners
// (wired in init) render each transition into the DOM.
const emitter = createEmitter();

// The STL pane is the "overlay workspace": every sample is a normalised group
// under stl.root, so samples stack on top of each other — core/layers.js owns
// those groups, the loaded layers, the in-flight downloads and the per-sample
// offset / opacity rules. In overlay layout the eye anatomy is merged in as
// another group.
const layers = new LayerController({ pane: stl, view, io: { fetchBuffer, isCached }, parsers, emitter });
const sampleCtlRefs = new Map();    // sampleId -> { ox, oy, oz } offset slider inputs
const anatomyGroup = new THREE.Group();
let anatomyObject = null;
const anatomyOffset = { x: 0, y: 0, z: 0 };
let anatomyOpacity = 1;

// Route the anatomy model to the correct place for the current layout:
// its own left pane (split) or merged into the overlay workspace (overlay).
function placeAnatomy() {
  if (!anatomyObject) return;
  anatomyObject.parent?.remove(anatomyObject);
  if (view.layout === 'overlay') {
    anatomyGroup.add(anatomyObject);
    if (!anatomyGroup.parent) stl.root.add(anatomyGroup);
    normalizeGroup(anatomyGroup, anatomyOffset);
    updateBounds(stl);
    layers.fitStl(1.7);
    applyRenderModeToPane(stl);
  } else {
    if (anatomyGroup.parent) stl.root.remove(anatomyGroup);
    glb.root.add(anatomyObject);
    fitBox(glb, anatomyFocusBox(), 1.75, ANATOMY_VIEW_DIR);
    updateBounds(glb);
    applyRenderModeToPane(glb);
  }
}

function setLayout(mode) {
  view.layout = mode;
  document.querySelectorAll('#layout-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
  document.body.classList.toggle('overlay-layout', mode === 'overlay');
  $('#overlay-ctl').hidden = mode !== 'overlay';
  $('#layout-desc').textContent = mode === 'overlay' ? 'Everything superimposed & aligned' : 'Anatomy & layers side by side';
  placeAnatomy();
  // Re-size + re-fit after the pane reflows to its new width (twice, to be safe:
  // once on the next frame, once after layout has fully settled).
  const resize = () => {
    mounts.glb.measure(); mounts.stl.measure();
    if (layers.groupCount() || anatomyObject) { updateBounds(stl); layers.fitStl(mode === 'overlay' ? 1.7 : 1.45); }
  };
  requestAnimationFrame(resize);
  setTimeout(resize, 90);
  applyRenderModeAll();
}

// ---------------------------------------------------------------------------
//  Camera framing
// ---------------------------------------------------------------------------
// Frame the left pane on the globe rather than on everything: the optic nerve
// runs ~8 mm past the sclera, and fitting that whole extent shrinks the eye
// itself. Padded a little so the nerve still reads as it leaves the frame.
// Open on a three-quarter anterior view: the model's cornea sits at -X, so
// looking in from -X (and a little above and to the front) puts the cornea,
// iris and pupil facing the viewer. A straight lateral view just shows a
// featureless white globe.
const ANATOMY_VIEW_DIR = new THREE.Vector3(-0.72, 0.26, 0.64);

function anatomyFocusBox() {
  const box = new THREE.Box3();
  const globe = anatomyParts.get('sclera');
  if (globe && globe.visible) box.setFromObject(globe);
  if (box.isEmpty() && anatomyObject) box.setFromObject(anatomyObject);
  return box;
}

function resetPane(pane) {
  if (pane === stl) layers.fitStl(view.layout === 'overlay' ? 1.7 : 1.45);
  else if (anatomyParts.size) fitBox(pane, anatomyFocusBox(), 1.75, ANATOMY_VIEW_DIR);
  else if (pane.root.children.length && fitToObject(pane, pane.root)) updateBounds(pane);
}
function resetAll() { panes.forEach(resetPane); }

// ---------------------------------------------------------------------------
//  Slicing / clipping
// ---------------------------------------------------------------------------
// The clip-plane, slice-quad, render-mode and stencil-cap logic lives in
// core/clipping.js and takes the live `view` state explicitly; these shims keep
// the call sites below reading as they always have.
const updateBounds = (pane) => coreUpdateBounds(pane, view);
const updateClips = (pane) => coreUpdateClips(pane, view);
const applyRenderModeToPane = (pane) => coreApplyRenderModeToPane(pane, view);
const buildCaps = (pane) => coreBuildCaps(pane, view);
function applyRenderModeAll() { panes.forEach(applyRenderModeToPane); }

function setRenderMode(mode) {
  view.renderMode = mode;
  $('#render-mode').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#slice-sec').hidden = mode !== 'slices';
  // Entering Slices with nothing cut shows no slice — enable one for discoverability.
  if (mode === 'slices' && !view.clipState.x.on && !view.clipState.y.on && !view.clipState.z.on) {
    view.clipState.x.on = true;
    const cb = document.querySelector('.slice-toggle input[data-axis="x"]');
    if (cb) cb.checked = true;
    panes.forEach(updateClips);
  }
  $('#mode-desc').textContent = {
    surface: 'Shaded surface · solid meshes',
    wireframe: 'Wireframe · edge view',
    slices: 'Tri-planar MPR · orthogonal clipping',
  }[mode];
  $('#stat-mode').textContent = mode;
  applyRenderModeAll();
}

// ---------------------------------------------------------------------------
//  Sync (mirror orbit orientation only)
// ---------------------------------------------------------------------------
const sync = new CameraSync(glb, stl);
function setSync(on) {
  btnSync.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('synced', on);
  const label = btnSync.querySelector('.sync-toggle-label');
  if (label) label.textContent = on ? 'Synced' : 'Sync views';
  if (on) sync.link(); else sync.unlink();
}

// ---------------------------------------------------------------------------
//  Layer rows
// ---------------------------------------------------------------------------
// Downloading, parsing and placing a layer lives in core/layers.js; the app
// keeps the row elements and renders the controller's events onto them.
const rowRefs = new Map();

function wireLayerEvents() {
  emitter.on('layer:state', ({ id, state, phase, cached }) => {
    const refs = rowRefs.get(id);
    if (!refs) return;
    const label = state === 'loading'
      ? { start: 'Downloading… 0%', cache: 'Loading from cache…', build: 'Building mesh…' }[phase]
      : state === 'loaded' ? (cached ? 'Loaded · cached' : 'Loaded')
        : state === 'error' ? 'Failed to load' : '';
    setRowState(refs, state, label);
    if (state === 'loading' && phase === 'build') refs.bar.style.width = '100%';
  });
  emitter.on('layer:progress', ({ id, loaded, total, pct }) => {
    const refs = rowRefs.get(id);
    if (!refs) return;
    refs.bar.style.width = `${total ? Math.min(pct, 99) : 50}%`;
    refs.status.textContent = total
      ? `Downloading… ${pct}% (${formatBytes(loaded)} / ${formatBytes(total)})`
      : `Downloading… ${formatBytes(loaded)}`;
  });
  emitter.on('layer:error', ({ id, label, error }) => {
    toast(`Couldn't load "${label}". ${error.message}`, 'error');
    const refs = rowRefs.get(id);
    if (refs) refs.checkbox.checked = false;
  });
  emitter.on('layers:visible', ({ anyVisible }) => stlEmpty.classList.toggle('hidden', anyVisible));
  // Keep a sample's offset sliders in step with its 3D group.
  emitter.on('sample:offset', ({ sampleId, axis, value }) => {
    const ref = sampleCtlRefs.get(sampleId);
    if (ref && ref['o' + axis]) { ref['o' + axis].value = Math.round(value * 100); setFill(ref['o' + axis]); }
  });
}

// ---------------------------------------------------------------------------
//  Anatomy GLB (left pane) — lazy
// ---------------------------------------------------------------------------
let anatomyController = null;

// Which reference model the left pane is showing. `?model=<id>` picks one at
// load; `?anatomy=<url>` still overrides the file outright, for a model that
// isn't in the registry.
let activeModelId = resolveModelId(new URLSearchParams(location.search).get('model'));
const activeModel = () => modelById(activeModelId) || ANATOMY_MODELS[0];

function resolveAnatomyURL() {
  return new URLSearchParams(location.search).get('anatomy') || activeModel().url;
}

// Switch models: drop the current one entirely (geometry, materials, per-
// structure state) and load the new one in its place.
async function setAnatomyModel(id) {
  if (!modelById(id) || id === activeModelId) return;
  anatomyController?.abort();
  activeModelId = id;

  if (anatomyObject) {
    anatomyObject.parent?.remove(anatomyObject);
    disposeObject(anatomyObject);
    anatomyObject = null;
  }
  anatomyParts.clear();
  anatomyState.clear();
  anatomyRowRefs.clear();
  anatomyPreset = 'whole';
  glb.root.clear();

  const url = new URL(location.href);
  if (id === DEFAULT_MODEL_ID) url.searchParams.delete('model');
  else url.searchParams.set('model', id);
  history.replaceState(null, '', url);

  syncModelMenu();
  buildAnatomyTree();
  await loadAnatomy();
}

async function loadAnatomy() {
  const url = resolveAnatomyURL();
  anatomyController = new AbortController();
  renderOverlay('loading', { pct: 0, label: 'Starting…' });
  try {
    const buffer = await fetchBuffer(url, {
      signal: anatomyController.signal,
      onProgress: ({ loaded, total, fromCache }) => {
        if (fromCache) return renderOverlay('loading', { pct: 100, label: 'Loading from cache…' });
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        renderOverlay('loading', { pct, label: total ? `${pct}% · ${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded) });
      },
    });
    renderOverlay('loading', { pct: 100, label: 'Building model…' });
    const scene = await parseGLTF_anatomy(buffer);
    glb.root.clear();
    anatomyObject = scene;
    registerAnatomyParts(scene);
    buildAnatomyTree();
    placeAnatomy();
    glbOverlay.classList.add('hidden');
  } catch (err) {
    if (err.name === 'AbortError') { renderOverlay('idle'); return; }
    console.error('Anatomy GLB failed:', err);
    renderOverlay('error', { message: err.message });
    toast(`Couldn't load the eye-anatomy model. ${err.message}`, 'error');
  } finally {
    anatomyController = null;
  }
}
const parseGLTF_anatomy = (buffer) => parsers.parseAnatomyGLTF(buffer);

// ---------------------------------------------------------------------------
//  Anatomy structures — per-structure meshes, colour & opacity
// ---------------------------------------------------------------------------
const anatomyParts = new Map();     // key -> THREE.Mesh
const anatomyState = new Map();     // key -> { visible, color, opacity }
const anatomyRowRefs = new Map();   // key -> { row, checkbox, swatch, colorInput, opacity }
let anatomyPreset = 'whole';

// Structure metadata for the model currently loaded.
const anatomyMeta = (key) => structureMeta(activeModel(), key);

function anatomyStateFor(key) {
  let st = anatomyState.get(key);
  if (!st) {
    const d = anatomyMeta(key) || { color: 0xffffff, opacity: 1 };
    st = { visible: true, color: d.color, opacity: d.opacity };
    anatomyState.set(key, st);
  }
  return st;
}

// Match each mesh in the GLB to its structure by glTF node name. The exporter
// names both the node and the mesh, but a loader may hang the name on either,
// so check the mesh and then walk up to the nearest named ancestor.
function anatomyKeyOf(mesh) {
  for (let o = mesh; o; o = o.parent) {
    const k = (o.name || '').trim().toLowerCase();
    if (anatomyMeta(k)) return k;
  }
  return null;
}

function registerAnatomyParts(scene) {
  anatomyParts.clear();
  const unmatched = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.userData.anatomyBackOf) return;
    const key = anatomyKeyOf(o);
    if (key) { anatomyParts.set(key, o); o.userData.anatomyKey = key; }
    else unmatched.push(o.name || '(unnamed)');
  });

  if (!anatomyParts.size) {
    // A custom model supplied via ?anatomy= won't carry our node names. Leave it
    // alone rather than colouring it wrong — it still renders, just without the
    // per-structure panel.
    console.warn('Anatomy model has no recognised structure names; per-structure controls disabled.', unmatched);
    setObjectOpacity(scene, anatomyOpacity);
    return;
  }
  if (unmatched.length) console.warn('Anatomy meshes with no matching structure:', unmatched);

  for (const key of anatomyParts.keys()) applyAnatomyStyle(key);
}

// These structures are nested, near-convex shells that all share a centre, so
// three.js's per-object back-to-front sort can't order them — every shell has a
// near half and a far half at the same object distance, and the result is a
// flat, obviously-wrong overlap. Render each translucent shell twice instead:
// its back faces first (outermost shell first), then its front faces (innermost
// first). That is the correct far-to-near order for concentric shells.
//
//   back faces:  10 + depth   (sclera 10, choroid 11, retina 12, lens 13 …)
//   front faces: 90 - depth   (lens 87,   retina 88,  choroid 89, sclera 90)
//
// Opaque structures skip all of this and just depth-test normally.
function anatomyBackMesh(mesh) {
  let back = mesh.userData.backMesh;
  if (!back) {
    back = new THREE.Mesh(mesh.geometry, makeMaterial(0xffffff, 1));
    back.material.userData.anatomy = true;
    back.frustumCulled = false;
    back.userData.anatomyBackOf = mesh.userData.anatomyKey;
    mesh.userData.backMesh = back;
    mesh.add(back);
  }
  return back;
}

// Effective alpha = the structure's own opacity x the pane-level anatomy opacity.
function applyAnatomyStyle(key) {
  const mesh = anatomyParts.get(key);
  if (!mesh) return;
  const st = anatomyStateFor(key);
  const meta = anatomyMeta(key);
  const depth = meta?.depth ?? 0;
  const alpha = st.opacity * anatomyOpacity;
  const translucent = alpha < 0.999;

  if (!mesh.material?.userData?.anatomy) {
    mesh.material?.dispose?.();
    mesh.material = makeMaterial(st.color, alpha);
    mesh.material.userData.anatomy = true;
  }
  const m = mesh.material;
  m.color.setHex(st.color);
  m.roughness = meta?.rough ?? 0.72;
  m.opacity = alpha;
  m.transparent = translucent;
  m.depthWrite = !translucent;
  m.side = translucent ? THREE.FrontSide : THREE.DoubleSide;
  m.needsUpdate = true;
  mesh.renderOrder = translucent ? 90 - depth : 0;
  mesh.visible = st.visible;

  const back = anatomyBackMesh(mesh);
  const bm = back.material;
  bm.color.setHex(st.color);
  bm.roughness = meta?.rough ?? 0.72;
  bm.opacity = alpha;
  bm.transparent = true;
  bm.depthWrite = false;
  bm.side = THREE.BackSide;
  bm.needsUpdate = true;
  back.renderOrder = 10 + depth;
  back.visible = translucent;
}
function applyAnatomyStyleAll() { for (const key of anatomyParts.keys()) applyAnatomyStyle(key); }

function setAnatomyPreset(name) {
  const model = activeModel();
  const preset = presetOf(model, name);
  if (!preset) return;
  anatomyPreset = name;
  for (const s of model.structures) {
    const st = anatomyStateFor(s.key);
    st.visible = !preset.hidden.includes(s.key);
    st.opacity = preset.opacity[s.key] ?? s.opacity;
  }
  applyAnatomyStyleAll();
  syncAnatomyRows();
  document.querySelectorAll('#anatomy-preset .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
  const desc = $('#anatomy-preset-desc');
  if (desc) desc.textContent = preset.desc;
  buildCaps(glb);
}

function syncAnatomyRows() {
  for (const [key, refs] of anatomyRowRefs) {
    const st = anatomyStateFor(key);
    refs.checkbox.checked = st.visible;
    refs.opacity.value = String(Math.round(st.opacity * 100));
    setFill(refs.opacity);
    const hex = `#${st.color.toString(16).padStart(6, '0')}`;
    refs.swatch.style.background = hex;
    refs.colorInput.value = hex;
    refs.row.classList.toggle('is-off', !st.visible);
  }
}

// ---------------------------------------------------------------------------
//  GLB overlay state machine
// ---------------------------------------------------------------------------
async function renderOverlay(state, data = {}) {
  glbOverlay.classList.remove('hidden');
  if (state === 'idle') {
    const cached = await isCached(resolveAnatomyURL());
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <span class="ms overlay-icon">visibility</span>
        <div class="overlay-title">${activeModel().label}</div>
        <div class="overlay-sub">${activeModel().blurb}${cached ? ' · cached' : ''}</div>
        <button class="btn btn-primary" id="overlay-load">Load model</button>
      </div>`;
    glbOverlay.querySelector('#overlay-load').onclick = loadAnatomy;
  } else if (state === 'loading') {
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <div class="overlay-title">Loading eye anatomy</div>
        <div class="progress"><div class="progress-fill" style="width:${data.pct || 0}%"></div></div>
        <div class="overlay-sub">${data.label || ''}</div>
        <button class="btn btn-ghost" id="overlay-cancel">Cancel</button>
      </div>`;
    glbOverlay.querySelector('#overlay-cancel').onclick = () => anatomyController?.abort();
  } else if (state === 'error') {
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <div class="overlay-title">Couldn't load model</div>
        <div class="overlay-sub">${data.message || ''}</div>
        <button class="btn btn-primary" id="overlay-retry">Try again</button>
      </div>`;
    glbOverlay.querySelector('#overlay-retry').onclick = loadAnatomy;
  }
}

// ---------------------------------------------------------------------------
//  Layer tree
// ---------------------------------------------------------------------------
function setRowState(refs, state, status) {
  if (!refs) return;
  refs.row.dataset.state = state;
  refs.status.textContent = status || '';
  if (state !== 'loading') refs.bar.style.width = state === 'loaded' ? '100%' : '0%';
  refs.progress.style.display = state === 'loading' ? 'block' : 'none';
}

// Each model brings its own presets, so the segmented control is rebuilt when
// the model changes.
function buildPresetButtons() {
  const host = $('#anatomy-preset');
  if (!host) return;
  const presets = activeModel().presets || {};
  const names = Object.keys(presets);
  host.innerHTML = '';
  host.classList.toggle('seg-2', names.length === 2);
  for (const name of names) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (name === anatomyPreset ? ' active' : '');
    b.dataset.preset = name;
    b.textContent = presets[name].label;
    b.addEventListener('click', () => setAnatomyPreset(name));
    host.appendChild(b);
  }
  const desc = $('#anatomy-preset-desc');
  if (desc) desc.textContent = presets[anatomyPreset]?.desc || '';
}

// The model menu lists every project surveyed for this pane. The ones with no
// 3D geometry stay in the list, disabled, with the reason — otherwise it looks
// like they were simply forgotten.
function buildModelMenu() {
  const menu = $('#model-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const m of ANATOMY_MODELS) {
    const item = document.createElement('button');
    item.className = 'model-item';
    item.dataset.modelId = m.id;
    item.disabled = !!m.unavailable;
    item.innerHTML =
      `<span class="model-name">${m.label}</span>` +
      `<span class="model-sub">${m.unavailable || m.blurb}</span>` +
      (m.unavailable ? '' : `<span class="model-lic mono">${m.license}</span>`);
    if (!m.unavailable) {
      item.addEventListener('click', () => { menu.classList.remove('open'); setAnatomyModel(m.id); });
    }
    menu.appendChild(item);
  }
  syncModelMenu();
}

function syncModelMenu() {
  const m = activeModel();
  const label = $('#model-label');
  if (label) label.textContent = m.label;
  const src = $('#anatomy-source');
  if (src) {
    src.innerHTML = m.href
      ? `<a href="${m.href}" target="_blank" rel="noopener">${m.source} ↗</a> · ${m.license}`
      : `${m.source} · ${m.license}`;
  }
  document.querySelectorAll('#model-menu .model-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.modelId === activeModelId);
  });
}

// The anatomy panel mirrors the layer tree on the right: one row per structure
// with a visibility box, a recolourable swatch and an opacity slider.
function buildAnatomyTree() {
  const host = $('#anatomy-tree');
  if (!host) return;
  host.innerHTML = '';
  anatomyRowRefs.clear();

  buildPresetButtons();
  if (!anatomyParts.size) { const c = $('#anatomy-count'); if (c) c.textContent = '—'; return; }

  let lastGroup = null;
  for (const s of activeModel().structures) {
    if (!anatomyParts.has(s.key)) continue;
    if (s.group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'anat-group';
      h.textContent = s.group;
      host.appendChild(h);
      lastGroup = s.group;
    }
    host.appendChild(buildAnatomyRow(s));
  }
  syncAnatomyRows();
  const count = $('#anatomy-count');
  if (count) count.textContent = anatomyParts.size;
}

function buildAnatomyRow(s) {
  const st = anatomyStateFor(s.key);
  const hex = `#${st.color.toString(16).padStart(6, '0')}`;

  const row = document.createElement('div');
  row.className = 'layer-row anat-row';
  row.dataset.state = 'loaded';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.className = 'layer-check';
  checkbox.id = `anat-${s.key}`; checkbox.checked = st.visible;

  const swatch = document.createElement('button');
  swatch.className = 'layer-swatch'; swatch.style.background = hex; swatch.title = 'Change colour';
  const colorInput = document.createElement('input');
  colorInput.type = 'color'; colorInput.value = hex; colorInput.className = 'layer-color-input';

  const label = document.createElement('label');
  label.className = 'layer-label'; label.htmlFor = checkbox.id;
  label.innerHTML = `<span class="layer-name">${s.label}</span>` +
    (s.coat ? '<span class="coat-tag" title="Also segmented from the µCT scan in the right-hand pane">µCT</span>' : '');

  const opacity = document.createElement('input');
  opacity.type = 'range'; opacity.min = '0'; opacity.max = '100';
  opacity.value = String(Math.round(st.opacity * 100));
  opacity.className = 'layer-opacity'; opacity.title = 'Opacity';
  setFill(opacity);

  const top = document.createElement('div');
  top.className = 'layer-top';
  top.append(checkbox, swatch, colorInput, label, opacity);
  row.appendChild(top);

  checkbox.addEventListener('change', () => {
    st.visible = checkbox.checked;
    row.classList.toggle('is-off', !st.visible);
    applyAnatomyStyle(s.key);
    buildCaps(glb);
  });
  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', (e) => {
    swatch.style.background = e.target.value;
    st.color = parseInt(e.target.value.slice(1), 16);
    applyAnatomyStyle(s.key);
    buildCaps(glb);
  });
  opacity.addEventListener('input', () => {
    setFill(opacity);
    st.opacity = Number(opacity.value) / 100;
    applyAnatomyStyle(s.key);
  });

  anatomyRowRefs.set(s.key, { row, checkbox, swatch, colorInput, opacity });
  return row;
}

function buildLayerTree() {
  layerTree.innerHTML = '';
  let count = 0;
  for (const sample of samplesData.samples) {
    const group = document.createElement('div');
    group.className = 'sample';
    group.dataset.sampleId = sample.id;
    if (sample.demo) group.classList.add('is-demo');

    const headRow = document.createElement('div');
    headRow.className = 'sample-head-row';
    const head = document.createElement('button');
    head.className = 'sample-head open';
    head.innerHTML = `<span class="caret">▸</span><span class="sample-name">${sample.label}</span>`;
    const vis = document.createElement('input');
    vis.type = 'checkbox'; vis.className = 'sample-vis'; vis.checked = true; vis.title = 'Show / hide whole sample';
    const gear = document.createElement('button');
    gear.className = 'sample-gear icon-btn'; gear.title = 'Position & opacity';
    gear.innerHTML = '<span class="ms">tune</span>';
    headRow.append(head, vis, gear);
    if (sample.link) {
      const a = document.createElement('a');
      a.className = 'sample-src'; a.href = sample.link; a.target = '_blank'; a.rel = 'noopener'; a.title = 'Source dataset'; a.textContent = '↗';
      headRow.appendChild(a);
    }

    const ctl = buildSampleControls(sample);
    const body = document.createElement('div');
    body.className = 'sample-body open';

    head.addEventListener('click', () => { head.classList.toggle('open'); body.classList.toggle('open'); });
    vis.addEventListener('change', () => layers.setSampleVisible(sample.id, vis.checked));
    gear.addEventListener('click', () => { ctl.hidden = !ctl.hidden; gear.classList.toggle('active', !ctl.hidden); });

    for (const st of sample.structures) { body.appendChild(buildRow(st)); count++; }
    group.append(headRow, ctl, body);
    layerTree.appendChild(group);
  }
  $('#layer-count').textContent = count;
  $('#meta-layers').textContent = count;
  $('#live-label').textContent = `${count} LAYER${count === 1 ? '' : 'S'}`;
  if (samplesData.samples[0]) {
    $('#meta-sample').textContent = samplesData.samples[0].label;
    $('#study-label').textContent = `${samplesData.samples[0].label.toUpperCase()} · µCT · SEG`;
  }
}

// Per-sample transform panel: opacity + X/Y/Z offset (stack/separate) + reset.
function buildSampleControls(sample) {
  const wrap = document.createElement('div');
  wrap.className = 'sample-ctl'; wrap.hidden = true;
  wrap.innerHTML = `
    ${sample.demo ? '<div class="demo-badge">synthetic demo copy</div>' : ''}
    <div class="ctl-line"><span>Opacity</span><input type="range" class="slider s-op" min="0" max="100" value="${Math.round(sample.opacity * 100)}"></div>
    <div class="ctl-line"><span>Offset X</span><input type="range" class="slider s-ox" min="-100" max="100" value="${sample.offset.x * 100}"></div>
    <div class="ctl-line"><span>Offset Y</span><input type="range" class="slider s-oy" min="-100" max="100" value="${sample.offset.y * 100}"></div>
    <div class="ctl-line"><span>Offset Z</span><input type="range" class="slider s-oz" min="-100" max="100" value="${sample.offset.z * 100}"></div>
    <button class="link-btn s-reset">Reset position</button>`;

  const op = wrap.querySelector('.s-op'); setFill(op);
  op.addEventListener('input', () => { setFill(op); layers.setSampleOpacity(sample, Number(op.value) / 100); });

  const refs = {};
  for (const [ax, sel] of [['x', '.s-ox'], ['y', '.s-oy'], ['z', '.s-oz']]) {
    const sl = wrap.querySelector(sel); setFill(sl); refs['o' + ax] = sl;
    sl.addEventListener('input', () => { setFill(sl); layers.offsetChanged(sample, ax, Number(sl.value) / 100); });
  }
  sampleCtlRefs.set(sample.id, refs);

  wrap.querySelector('.s-reset').addEventListener('click', () => layers.resetOffsets(sample));
  return wrap;
}

function buildRow(structure) {
  const row = document.createElement('div');
  row.className = 'layer-row'; row.dataset.state = 'idle';
  const hex = `#${structure.color.toString(16).padStart(6, '0')}`;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.className = 'layer-check'; checkbox.id = `chk-${structure.id}`;

  const swatch = document.createElement('button');
  swatch.className = 'layer-swatch'; swatch.style.background = hex; swatch.title = 'Change colour';
  const colorInput = document.createElement('input');
  colorInput.type = 'color'; colorInput.value = hex; colorInput.className = 'layer-color-input';

  const label = document.createElement('label');
  label.className = 'layer-label'; label.htmlFor = checkbox.id;
  label.innerHTML = `<span class="layer-name">${structure.label}</span><span class="layer-size"></span>`;

  const opacity = document.createElement('input');
  opacity.type = 'range'; opacity.min = '0'; opacity.max = '100';
  opacity.value = String(Math.round(structure.opacity * 100));
  opacity.className = 'layer-opacity'; opacity.title = 'Opacity';
  setFill(opacity);

  const progress = document.createElement('div');
  progress.className = 'layer-progress'; progress.style.display = 'none';
  const bar = document.createElement('div'); bar.className = 'layer-bar'; progress.appendChild(bar);
  const status = document.createElement('div'); status.className = 'layer-status';

  const top = document.createElement('div'); top.className = 'layer-top';
  top.append(checkbox, swatch, colorInput, label, opacity);
  row.append(top, progress, status);

  const refs = { row, bar, status, progress, checkbox, sizeEl: label.querySelector('.layer-size') };
  rowRefs.set(structure.id, refs);

  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', (e) => {
    swatch.style.background = e.target.value;
    layers.setColor(structure, parseInt(e.target.value.slice(1), 16));
  });
  opacity.addEventListener('input', (e) => {
    setFill(e.target);
    layers.setOpacity(structure, Number(e.target.value) / 100);
  });

  checkbox.addEventListener('change', async () => {
    if (checkbox.checked) {
      if (layers.has(structure.id)) { layers.setVisible(structure.id, true); return; }
      if (!structure._resolved) {
        setRowState(rowRefs.get(structure.id), 'loading', 'Checking…');
        await resolveStructure(structure);
        annotateSize(structure);
        if (!checkbox.checked) { setRowState(rowRefs.get(structure.id), 'idle', ''); return; }
      }
      if (layers.isHeavy(structure) && !(await isCached(structure.path))) {
        const ok = await askConfirm({ title: 'Large layer', message: `“${structure.label}” is ${formatBytes(structure.bytes)}. It will download once and then be cached. Continue?`, confirmLabel: 'Download' });
        if (!ok) { checkbox.checked = false; return; }
      }
      layers.load(structure);
    } else {
      layers.abort(structure.id);
      layers.setVisible(structure.id, false);
    }
  });
  return row;
}

function annotateSize(structure) {
  const refs = rowRefs.get(structure.id);
  if (refs && structure.bytes) {
    refs.sizeEl.textContent = formatBytes(structure.bytes);
    refs.sizeEl.classList.toggle('heavy', structure.bytes > HEAVY_BYTES);
  }
}
// ---------------------------------------------------------------------------
//  Study selector (top bar) — pick & frame a sample
// ---------------------------------------------------------------------------
function focusSample(sampleId) {
  const sample = layers.findSample(sampleId);
  if (sample) $('#study-label').textContent = `${sample.label.toUpperCase()} · µCT · SEG`;

  layers.focusSample(sampleId);
  // Reveal the sample in the left rail.
  const el = layerTree.querySelector(`[data-sample-id="${sampleId}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildStudyMenu() {
  const menu = $('#study-menu');
  menu.innerHTML = '';
  for (const sample of samplesData.samples) {
    const n = sample.structures.length;
    const item = document.createElement('button');
    item.className = 'study-item'; item.setAttribute('role', 'menuitem');
    item.innerHTML = `<span class="ms">${sample.demo ? 'content_copy' : 'folder_open'}</span>
      <span class="study-item-name">${sample.label}</span>
      <span class="study-item-meta mono">${n} layer${n === 1 ? '' : 's'}</span>`;
    item.addEventListener('click', () => { focusSample(sample.id); closeStudyMenu(); });
    menu.appendChild(item);
  }
}

function openStudyMenu() {
  const menu = $('#study-menu');
  const r = $('#study-selector').getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.classList.add('open');
}
function closeStudyMenu() { $('#study-menu').classList.remove('open'); }

// ---------------------------------------------------------------------------
//  Toasts + confirm
// ---------------------------------------------------------------------------
function toast(message, type = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`; el.textContent = message;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}
function askConfirm({ title, message, confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-msg">${message}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-primary" data-act="ok">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const done = (v) => { back.remove(); resolve(v); };
    back.addEventListener('click', (e) => {
      if (e.target === back) done(false);
      if (e.target.dataset.act === 'ok') done(true);
      if (e.target.dataset.act === 'cancel') done(false);
    });
  });
}

// ---------------------------------------------------------------------------
//  Sliders fill helper
// ---------------------------------------------------------------------------
function setFill(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

// ---------------------------------------------------------------------------
//  Per-pane HUD
// ---------------------------------------------------------------------------
function addHUD(pane, paneEl) {
  const frag = document.createDocumentFragment();
  for (const c of ['tl', 'tr', 'bl', 'br']) {
    const b = document.createElement('div'); b.className = `hud-bracket ${c}`; frag.appendChild(b);
  }
  const [t, i, l, r] = (paneEl.dataset.orient || 'S I R L').split(' ');
  for (const [cls, txt] of [['t', t], ['b', i], ['l', l], ['r', r]]) {
    const s = document.createElement('div'); s.className = `hud-orient ${cls}`; s.textContent = txt; frag.appendChild(s);
  }
  const bar = document.createElement('div');
  bar.className = 'hud-toolbar';
  bar.innerHTML = `
    <button class="icon-btn" data-act="auto" title="Auto-rotate"><span class="ms">autorenew</span></button>
    <button class="icon-btn" data-act="reset" title="Reset view"><span class="ms">restart_alt</span></button>
    <button class="icon-btn" data-act="fit" title="Fit view"><span class="ms">center_focus_strong</span></button>`;
  bar.querySelector('[data-act="auto"]').onclick = () => setAutoRotate(!view.autoRotate);
  bar.querySelector('[data-act="reset"]').onclick = () => resetPane(pane);
  bar.querySelector('[data-act="fit"]').onclick = () => resetPane(pane);
  frag.appendChild(bar);
  paneEl.appendChild(frag);
}

function setAutoRotate(on) {
  view.autoRotate = on;
  panes.forEach((p) => { p.controls.autoRotate = on; });
  $('#auto-rotate').checked = on;
  document.querySelectorAll('.hud-toolbar [data-act="auto"]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
}

// ---------------------------------------------------------------------------
//  Controls wiring
// ---------------------------------------------------------------------------
function wireControls() {
  btnSync.addEventListener('click', () => setSync(!sync.enabled));
  $('#btn-reset').addEventListener('click', resetAll);
  $('#btn-fit').addEventListener('click', resetAll);

  // Study selector dropdown
  $('#study-selector').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#study-menu').classList.contains('open') ? closeStudyMenu() : openStudyMenu();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#study-menu') && !e.target.closest('#study-selector')) closeStudyMenu();
  });

  const help = $('#help-dialog');
  $('#btn-help').addEventListener('click', () => help.showModal());
  help.querySelector('.dialog-close').addEventListener('click', () => help.close());
  help.addEventListener('click', (e) => { if (e.target === help) help.close(); });

  const about = $('#about-dialog');
  $('#btn-about').addEventListener('click', () => about.showModal());
  about.querySelector('.dialog-close').addEventListener('click', () => about.close());
  about.addEventListener('click', (e) => { if (e.target === about) about.close(); });
  $('#help-to-about').addEventListener('click', () => { help.close(); about.showModal(); });

  // X-ray view — drives the global opacity so users can see inside solid structures.
  $('#xray-view').addEventListener('change', (e) => {
    const op = $('#global-opacity');
    op.value = e.target.checked ? 30 : 100;
    op.dispatchEvent(new Event('input', { bubbles: true }));
  });

  $('#solid-fill').addEventListener('change', (e) => {
    view.solidFill = e.target.checked;
    layers.reloadFillVariants();
  });

  $('#btn-clear-cache').addEventListener('click', async () => {
    const ok = await askConfirm({ title: 'Clear cache', message: 'Remove all locally cached meshes? They will re-download next time.', confirmLabel: 'Clear' });
    if (ok) { await clearCache(); toast('Cache cleared.', 'info'); }
  });

  // Render mode segmented control
  $('#render-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setRenderMode(btn.dataset.mode);
  });

  // Layout (split / overlay) + anatomy group controls
  $('#layout-seg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) setLayout(b.dataset.layout); });
  $('#an-vis').addEventListener('change', (e) => { if (anatomyObject) anatomyObject.visible = e.target.checked; });
  const modelBtn = $('#model-selector'), modelMenu = $('#model-menu');
  modelBtn?.addEventListener('click', (e) => { e.stopPropagation(); modelMenu.classList.toggle('open'); });
  document.addEventListener('click', (e) => {
    if (modelMenu?.classList.contains('open') && !modelMenu.contains(e.target)) modelMenu.classList.remove('open');
  });
  const anOp = $('#an-op'); setFill(anOp);
  anOp.addEventListener('input', () => {
    setFill(anOp);
    anatomyOpacity = Number(anOp.value) / 100;
    if (!anatomyObject) return;
    // Scale every structure's own alpha rather than flattening them all to one
    // value, so the model keeps its translucent-sclera / opaque-coats reading.
    if (anatomyParts.size) applyAnatomyStyleAll();
    else setObjectOpacity(anatomyObject, anatomyOpacity);
  });
  for (const [ax, id] of [['x', '#an-ox'], ['y', '#an-oy'], ['z', '#an-oz']]) {
    const sl = $(id); setFill(sl);
    sl.addEventListener('input', () => { setFill(sl); anatomyOffset[ax] = Number(sl.value) / 100; if (view.layout === 'overlay') { normalizeGroup(anatomyGroup, anatomyOffset); updateBounds(stl); } });
  }

  // Slice plane controls
  document.querySelectorAll('.slice-toggle input').forEach((cb) => {
    cb.addEventListener('change', () => { view.clipState[cb.dataset.axis].on = cb.checked; panes.forEach(updateClips); });
  });
  document.querySelectorAll('.slice-row .slider').forEach((sl) => {
    setFill(sl);
    sl.addEventListener('input', () => {
      setFill(sl);
      view.clipState[sl.dataset.axis].pos = Number(sl.value) / 100;
      $(`.slice-val[data-axis="${sl.dataset.axis}"]`).textContent = `${sl.value}%`;
      panes.forEach(updateClips);
    });
  });
  $('#slice-flip').addEventListener('change', (e) => { view.clipState.flip = e.target.checked; panes.forEach(updateClips); });
  $('#slice-show').addEventListener('change', (e) => { view.clipState.showPlanes = e.target.checked; applyRenderModeAll(); });

  // Display controls
  const op = $('#global-opacity'); setFill(op);
  op.addEventListener('input', (e) => {
    setFill(e.target);
    view.globalOpacity = Number(e.target.value) / 100;
    $('#opacity-val').textContent = `${e.target.value}%`;
    layers.reapplyAllOpacity();
  });
  $('#auto-rotate').addEventListener('change', (e) => setAutoRotate(e.target.checked));
  $('#show-grid').addEventListener('change', (e) => panes.forEach((p) => { p.grid.visible = e.target.checked && !p.bounds.isEmpty(); }));
  $('#link-offsets').addEventListener('change', (e) => {
    view.linkOffsets = e.target.checked;
    if (view.linkOffsets) layers.snapOffsetsToFirst();   // snap every sample to the first sample's offset
  });

  // Mobile left-rail drawer
  $('#rail-left-restore').addEventListener('click', () => document.body.classList.toggle('no-left'));
  if (window.matchMedia('(max-width: 620px)').matches) document.body.classList.add('no-left');
  viewportEl.addEventListener('pointerdown', () => {
    if (window.matchMedia('(max-width: 620px)').matches) document.body.classList.add('no-left');
  });
}

// ---------------------------------------------------------------------------
//  Draggable divider
// ---------------------------------------------------------------------------
function wireDivider() {
  let dragging = false;
  const horizontal = () => getComputedStyle(viewportEl).flexDirection === 'row';
  divider.addEventListener('pointerdown', (e) => {
    if (!horizontal()) return;
    dragging = true; divider.setPointerCapture(e.pointerId); document.body.classList.add('dragging');
  });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = viewportEl.getBoundingClientRect();
    let ratio = Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width));
    glbPane.style.flex = `0 0 ${ratio * 100}%`; stlPane.style.flex = '1 1 0';
  });
  const stop = (e) => { if (!dragging) return; dragging = false; try { divider.releasePointerCapture(e.pointerId); } catch {} document.body.classList.remove('dragging'); };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
}

// ---------------------------------------------------------------------------
//  Render loop + status bar
// ---------------------------------------------------------------------------
let lastStat = 0, frames = 0, fpsT = performance.now(), fps = 0;
const statCam = $('#stat-cam'), statTris = $('#stat-tris'), statFps = $('#stat-fps');

function animate(now) {
  requestAnimationFrame(animate);
  glb.controls.update();
  stl.controls.update();
  if (glb.headLight) {
    glb.headLight.position.copy(glb.camera.position);
    glb.headLight.target.position.copy(glb.controls.target);
    glb.headLight.target.updateMatrixWorld();
  }
  glb.render();
  stl.render();

  frames++;
  if (now - fpsT >= 500) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
  if (now - lastStat >= 250) {
    lastStat = now;
    const az = Math.round(THREE.MathUtils.radToDeg(stl.controls.getAzimuthalAngle()));
    const el = Math.round(90 - THREE.MathUtils.radToDeg(stl.controls.getPolarAngle()));
    statCam.innerHTML = `az ${az}°&nbsp;&nbsp;el ${el}°`;
    const tris = (glb.renderer.info.render.triangles + stl.renderer.info.render.triangles);
    statTris.textContent = `${tris.toLocaleString()} triangles`;
    statFps.textContent = `${fps} fps`;
  }
}

// ---------------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------------
async function init() {
  addHUD(glb, glbPane);
  addHUD(stl, stlPane);
  wireControls();
  wireLayerEvents();
  wireDivider();
  setRenderMode('surface');
  buildModelMenu();
  buildAnatomyTree();
  renderOverlay('idle');
  layers.syncVisibility();
  requestAnimationFrame(animate);

  try {
    await loadCSVData();
    layers.setSamples(samplesData.samples);
    buildLayerTree();
    buildStudyMenu();
    probeSizes(annotateSize);
  } catch (err) {
    console.error(err);
    toast(`Failed to load dataset: ${err.message}`, 'error', 10000);
    layerTree.innerHTML = `<div class="tree-error">Could not load the dataset manifest.<br>${err.message}</div>`;
  }
}

init();
