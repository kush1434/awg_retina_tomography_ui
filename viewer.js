// ============================================================================
//  viewer.js — Retina Tomography Workbench
//  Two linked Three.js scenes (eye-anatomy GLB | segmented layers) wrapped in a
//  clinical instrument-panel UI: synced orbit, render modes (surface / wireframe
//  / tri-planar slices via clipping planes), on-demand loading, caching & HUD.
// ============================================================================

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { loadCSVData, probeSizes, resolveStructure, samplesData, formatBytes } from './data-loader.js';
import { fetchBuffer, isCached, clearCache } from './asset-loader.js';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------
const HF_BASE = 'https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui/resolve/main';
const ANATOMY_OPTIMIZED = 'optimized/eye-anatomy.glb';
const ANATOMY_ORIGINAL = `${HF_BASE}/eye-anatomy.glb`;
const HEAVY_BYTES = 400 * 1024 * 1024;
const PLANE_COLORS = { x: 0x7bd88f, y: 0xebb46e, z: 0x78aaeb };  // sagittal / axial / coronal

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
let renderMode = 'surface';                         // surface | wireframe | slices
let globalOpacity = 1;
let autoRotate = false;
const clipState = {
  x: { on: false, pos: 0.5 },
  y: { on: false, pos: 0.5 },
  z: { on: false, pos: 0.5 },
  flip: false,
  showPlanes: true,
};

// ---------------------------------------------------------------------------
//  Shared loaders
// ---------------------------------------------------------------------------
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
const stlLoader = new STLLoader();

// ---------------------------------------------------------------------------
//  Pane factory
// ---------------------------------------------------------------------------
function createPane(mountEl) {
  const scene = new THREE.Scene();

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x141820, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(1, 1.2, 1);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.45); fill.position.set(-1, -0.6, -0.8);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 1e7);
  camera.position.set(0, 0, 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  mountEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.1;

  const root = new THREE.Group();
  scene.add(root);

  // Slice helpers (clip planes, plane quads, bounding box, grid).
  const clipPlanes = {
    x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    y: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    z: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  };
  const sliceGroup = new THREE.Group(); sliceGroup.visible = false; scene.add(sliceGroup);
  const sliceQuads = {};
  for (const ax of ['x', 'y', 'z']) {
    const mat = new THREE.MeshBasicMaterial({ color: PLANE_COLORS[ax], transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    q.userData.noClip = true;
    if (ax === 'x') q.rotation.y = Math.PI / 2;
    if (ax === 'y') q.rotation.x = Math.PI / 2;
    sliceQuads[ax] = q; sliceGroup.add(q);
  }
  const boxHelper = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
  );
  boxHelper.userData.noClip = true; boxHelper.visible = false; scene.add(boxHelper);

  const grid = new THREE.GridHelper(1, 20, 0x2a3340, 0x1a2029);
  grid.visible = false; grid.userData.noClip = true; scene.add(grid);

  function size() {
    const w = mountEl.clientWidth || 1, h = mountEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  size();
  new ResizeObserver(size).observe(mountEl);

  return {
    mountEl, scene, camera, renderer, controls, root,
    clipPlanes, activeClips: [], sliceGroup, sliceQuads, boxHelper, grid,
    bounds: new THREE.Box3(), size, defaultDist: 100,
  };
}

const glb = createPane(glbPane);
const stl = createPane(stlPane);
const panes = [glb, stl];

// ---------------------------------------------------------------------------
//  Camera framing
// ---------------------------------------------------------------------------
function fitToObject(pane, object, offset = 1.45) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fov = pane.camera.fov * (Math.PI / 180);
  const dist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * offset;

  pane.camera.near = Math.max(maxDim / 1000, 0.001);
  pane.camera.far = maxDim * 1000;
  pane.camera.updateProjectionMatrix();
  pane.controls.target.copy(center);
  pane.camera.position.copy(center).add(new THREE.Vector3(0, 0, dist));
  pane.controls.update();
  pane.defaultDist = dist;

  updateBounds(pane);
}

function resetPane(pane) { if (pane.root.children.length) fitToObject(pane, pane.root); }
function resetAll() { panes.forEach(resetPane); }

// ---------------------------------------------------------------------------
//  Slicing / clipping
// ---------------------------------------------------------------------------
function updateBounds(pane) {
  if (!pane.root.children.length) return;
  pane.bounds.setFromObject(pane.root);
  const size = pane.bounds.getSize(new THREE.Vector3());
  const center = pane.bounds.getCenter(new THREE.Vector3());

  // bounding-cube wireframe
  pane.boxHelper.scale.copy(size); pane.boxHelper.position.copy(center);
  // grid floor at the base
  const gmax = Math.max(size.x, size.z) * 1.2 || 1;
  pane.grid.scale.set(gmax, 1, gmax);
  pane.grid.position.set(center.x, pane.bounds.min.y, center.z);

  updateClips(pane);
}

function updateClips(pane) {
  if (pane.bounds.isEmpty()) return;
  const { min, max } = pane.bounds;
  const center = pane.bounds.getCenter(new THREE.Vector3());
  const size = pane.bounds.getSize(new THREE.Vector3());
  const sign = clipState.flip ? 1 : -1;
  const axes = ['x', 'y', 'z'];
  pane.activeClips = [];

  for (const ax of axes) {
    const pos = min[ax] + (max[ax] - min[ax]) * clipState[ax].pos;
    const plane = pane.clipPlanes[ax];
    plane.normal.set(ax === 'x' ? sign : 0, ax === 'y' ? sign : 0, ax === 'z' ? sign : 0);
    plane.constant = sign === -1 ? pos : -pos;
    if (clipState[ax].on) pane.activeClips.push(plane);

    // position the visual quad at the cut
    const q = pane.sliceQuads[ax];
    if (ax === 'x') { q.position.set(pos, center.y, center.z); q.scale.set(size.z, size.y, 1); }
    if (ax === 'y') { q.position.set(center.x, pos, center.z); q.scale.set(size.x, size.z, 1); }
    if (ax === 'z') { q.position.set(center.x, center.y, pos); q.scale.set(size.x, size.y, 1); }
    q.visible = clipState[ax].on;
  }
  applyRenderModeToPane(pane);
}

function applyRenderModeToPane(pane) {
  const slicing = renderMode === 'slices';
  pane.sliceGroup.visible = slicing && clipState.showPlanes;
  pane.boxHelper.visible = slicing && !pane.bounds.isEmpty();
  pane.scene.traverse((o) => {
    if (!o.isMesh || o.userData.noClip) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.wireframe = renderMode === 'wireframe';
      m.clippingPlanes = slicing && pane.activeClips.length ? pane.activeClips : null;
      m.clipIntersection = false;
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  });
}
function applyRenderModeAll() { panes.forEach(applyRenderModeToPane); }

function setRenderMode(mode) {
  renderMode = mode;
  $('#render-mode').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#slice-sec').hidden = mode !== 'slices';
  // Entering Slices with nothing cut shows no slice — enable one for discoverability.
  if (mode === 'slices' && !clipState.x.on && !clipState.y.on && !clipState.z.on) {
    clipState.x.on = true;
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
let syncEnabled = false, isSyncing = false;
function applyOrientation(pane, az, polar) {
  const dist = pane.controls.getDistance();
  const t = pane.controls.target;
  const sp = Math.sin(polar);
  pane.camera.position.copy(t).add(new THREE.Vector3(sp * Math.sin(az), Math.cos(polar), sp * Math.cos(az)).multiplyScalar(dist));
  pane.camera.lookAt(t);
  pane.controls.update();
}
function mirror(from, to) {
  if (isSyncing) return;
  isSyncing = true;
  applyOrientation(to, from.controls.getAzimuthalAngle(), from.controls.getPolarAngle());
  isSyncing = false;
}
const glbToStl = () => mirror(glb, stl);
const stlToGlb = () => mirror(stl, glb);
function setSync(on) {
  syncEnabled = on;
  btnSync.setAttribute('aria-pressed', String(on));
  if (on) {
    glb.controls.addEventListener('change', glbToStl);
    stl.controls.addEventListener('change', stlToGlb);
    mirror(glb, stl);
  } else {
    glb.controls.removeEventListener('change', glbToStl);
    stl.controls.removeEventListener('change', stlToGlb);
  }
}

// ---------------------------------------------------------------------------
//  Materials
// ---------------------------------------------------------------------------
function makeMaterial(colorHex, opacity) {
  return new THREE.MeshStandardMaterial({
    color: colorHex, roughness: 0.82, metalness: 0.0,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide,
  });
}
function applyColor(object, colorHex) {
  object.traverse((c) => { if (c.isMesh && c.material) c.material.color.setHex(colorHex); });
}
function applyOpacity(object, opacity) {
  const o = opacity * globalOpacity;
  object.traverse((c) => {
    if (c.isMesh && c.material && !c.userData.noClip) {
      c.material.opacity = o;
      c.material.transparent = o < 1;
      c.material.depthWrite = o >= 1;
      c.renderOrder = o < 1 ? 1 : 0;
      c.material.needsUpdate = true;
    }
  });
}

// ---------------------------------------------------------------------------
//  Layer loading
// ---------------------------------------------------------------------------
const featureObjects = new Map();
const rowRefs = new Map();
const inFlight = new Map();

async function loadLayer(structure) {
  const refs = rowRefs.get(structure.id);
  const controller = new AbortController();
  inFlight.set(structure.id, controller);
  setRowState(refs, 'loading', 'Downloading… 0%');

  try {
    const buffer = await fetchBuffer(structure.path, {
      signal: controller.signal,
      onProgress: ({ loaded, total, fromCache }) => {
        if (fromCache) { setRowState(refs, 'loading', 'Loading from cache…'); return; }
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        refs.bar.style.width = `${total ? Math.min(pct, 99) : 50}%`;
        refs.status.textContent = total
          ? `Downloading… ${pct}% (${formatBytes(loaded)} / ${formatBytes(total)})`
          : `Downloading… ${formatBytes(loaded)}`;
      },
    });
    setRowState(refs, 'loading', 'Building mesh…');
    refs.bar.style.width = '100%';

    const object = structure.kind === 'gltf' ? await parseGLTF(buffer) : parseSTL(buffer, structure);
    object.userData.id = structure.id;
    featureObjects.set(structure.id, object);
    stl.root.add(object);
    applyColor(object, structure.color);
    applyOpacity(object, structure.opacity);

    if (stl.root.children.length === 1) fitToObject(stl, stl.root);
    else updateBounds(stl);
    applyRenderModeToPane(stl);
    refreshStlEmpty();
    setRowState(refs, 'loaded', (await isCached(structure.path)) ? 'Loaded · cached' : 'Loaded');
  } catch (err) {
    if (err.name === 'AbortError') setRowState(refs, 'idle', '');
    else {
      console.error(`Layer "${structure.label}" failed:`, err);
      setRowState(refs, 'error', 'Failed to load');
      toast(`Couldn't load "${structure.label}". ${err.message}`, 'error');
      refs.checkbox.checked = false;
    }
  } finally {
    inFlight.delete(structure.id);
  }
}

function parseSTL(buffer, structure) {
  const geometry = stlLoader.parse(buffer);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, makeMaterial(structure.color, structure.opacity));
}
function parseGLTF(buffer) {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(buffer, '', (gltf) => {
      gltf.scene.traverse((c) => {
        if (c.isMesh) {
          c.frustumCulled = false;
          if (!c.geometry.attributes.normal) c.geometry.computeVertexNormals();
          c.material = makeMaterial(0xffffff, 1);
        }
      });
      resolve(gltf.scene);
    }, reject);
  });
}

// ---------------------------------------------------------------------------
//  Anatomy GLB (left pane) — lazy
// ---------------------------------------------------------------------------
let anatomyController = null;
async function resolveAnatomyURL() {
  const override = new URLSearchParams(location.search).get('anatomy');
  if (override) return override;
  try { const res = await fetch(ANATOMY_OPTIMIZED, { method: 'HEAD', mode: 'cors' }); if (res.ok) return ANATOMY_OPTIMIZED; }
  catch { /* fall through */ }
  return ANATOMY_ORIGINAL;
}
async function loadAnatomy() {
  const url = await resolveAnatomyURL();
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
    glb.root.add(scene);
    fitToObject(glb, scene, 1.5);
    applyRenderModeToPane(glb);
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
function parseGLTF_anatomy(buffer) {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(buffer, '', (gltf) => {
      gltf.scene.traverse((c) => { if (c.isMesh) { c.frustumCulled = false; if (c.material) { c.material.side = THREE.DoubleSide; c.material.needsUpdate = true; } } });
      resolve(gltf.scene);
    }, reject);
  });
}

// ---------------------------------------------------------------------------
//  GLB overlay state machine
// ---------------------------------------------------------------------------
async function renderOverlay(state, data = {}) {
  glbOverlay.classList.remove('hidden');
  if (state === 'idle') {
    const cached = (await isCached(ANATOMY_OPTIMIZED)) || (await isCached(ANATOMY_ORIGINAL));
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <span class="ms overlay-icon">visibility</span>
        <div class="overlay-title">Eye anatomy model</div>
        <div class="overlay-sub">${cached ? 'Cached — loads instantly' : 'Large file · downloads once, then cached'}</div>
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

function buildLayerTree() {
  layerTree.innerHTML = '';
  let count = 0;
  for (const sample of samplesData.samples) {
    const group = document.createElement('div');
    group.className = 'sample';
    const head = document.createElement('button');
    head.className = 'sample-head open';
    head.innerHTML = `<span class="caret">▸</span><span class="sample-name">${sample.label}</span>`;
    if (sample.link) head.innerHTML += `<a class="sample-src" href="${sample.link}" target="_blank" rel="noopener" title="Open source dataset">↗</a>`;
    const body = document.createElement('div');
    body.className = 'sample-body open';
    head.addEventListener('click', (e) => {
      if (e.target.closest('.sample-src')) return;
      head.classList.toggle('open'); body.classList.toggle('open');
    });
    for (const st of sample.structures) { body.appendChild(buildRow(st)); count++; }
    group.append(head, body);
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
    structure.color = parseInt(e.target.value.slice(1), 16);
    const obj = featureObjects.get(structure.id);
    if (obj) applyColor(obj, structure.color);
  });
  opacity.addEventListener('input', (e) => {
    setFill(e.target);
    structure.opacity = Number(e.target.value) / 100;
    const obj = featureObjects.get(structure.id);
    if (obj) applyOpacity(obj, structure.opacity);
  });

  checkbox.addEventListener('change', async () => {
    const existing = featureObjects.get(structure.id);
    if (checkbox.checked) {
      if (existing) { existing.visible = true; refreshStlEmpty(); return; }
      if (!structure._resolved) {
        setRowState(rowRefs.get(structure.id), 'loading', 'Checking…');
        await resolveStructure(structure);
        annotateSize(structure);
        if (!checkbox.checked) { setRowState(rowRefs.get(structure.id), 'idle', ''); return; }
      }
      if (structure.bytes && structure.bytes > HEAVY_BYTES && !(await isCached(structure.path))) {
        const ok = await askConfirm({ title: 'Large layer', message: `“${structure.label}” is ${formatBytes(structure.bytes)}. It will download once and then be cached. Continue?`, confirmLabel: 'Download' });
        if (!ok) { checkbox.checked = false; return; }
      }
      loadLayer(structure);
    } else {
      if (inFlight.has(structure.id)) inFlight.get(structure.id).abort();
      if (existing) existing.visible = false;
      refreshStlEmpty();
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
function refreshStlEmpty() {
  const anyVisible = [...featureObjects.values()].some((o) => o.visible);
  stlEmpty.classList.toggle('hidden', anyVisible);
}

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
  bar.querySelector('[data-act="auto"]').onclick = () => setAutoRotate(!autoRotate);
  bar.querySelector('[data-act="reset"]').onclick = () => resetPane(pane);
  bar.querySelector('[data-act="fit"]').onclick = () => resetPane(pane);
  frag.appendChild(bar);
  paneEl.appendChild(frag);
}

function setAutoRotate(on) {
  autoRotate = on;
  panes.forEach((p) => { p.controls.autoRotate = on; });
  $('#auto-rotate').checked = on;
  document.querySelectorAll('.hud-toolbar [data-act="auto"]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
}

// ---------------------------------------------------------------------------
//  Controls wiring
// ---------------------------------------------------------------------------
function wireControls() {
  btnSync.addEventListener('click', () => setSync(!syncEnabled));
  $('#btn-reset').addEventListener('click', resetAll);
  $('#btn-fit').addEventListener('click', resetAll);

  const help = $('#help-dialog');
  $('#btn-help').addEventListener('click', () => help.showModal());
  help.querySelector('.dialog-close').addEventListener('click', () => help.close());
  help.addEventListener('click', (e) => { if (e.target === help) help.close(); });

  $('#btn-clear-cache').addEventListener('click', async () => {
    const ok = await askConfirm({ title: 'Clear cache', message: 'Remove all locally cached meshes? They will re-download next time.', confirmLabel: 'Clear' });
    if (ok) { await clearCache(); toast('Cache cleared.', 'info'); }
  });

  // Render mode segmented control
  $('#render-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setRenderMode(btn.dataset.mode);
  });

  // Slice plane controls
  document.querySelectorAll('.slice-toggle input').forEach((cb) => {
    cb.addEventListener('change', () => { clipState[cb.dataset.axis].on = cb.checked; panes.forEach(updateClips); });
  });
  document.querySelectorAll('.slice-row .slider').forEach((sl) => {
    setFill(sl);
    sl.addEventListener('input', () => {
      setFill(sl);
      clipState[sl.dataset.axis].pos = Number(sl.value) / 100;
      $(`.slice-val[data-axis="${sl.dataset.axis}"]`).textContent = `${sl.value}%`;
      panes.forEach(updateClips);
    });
  });
  $('#slice-flip').addEventListener('change', (e) => { clipState.flip = e.target.checked; panes.forEach(updateClips); });
  $('#slice-show').addEventListener('change', (e) => { clipState.showPlanes = e.target.checked; applyRenderModeAll(); });

  // Display controls
  const op = $('#global-opacity'); setFill(op);
  op.addEventListener('input', (e) => {
    setFill(e.target);
    globalOpacity = Number(e.target.value) / 100;
    $('#opacity-val').textContent = `${e.target.value}%`;
    for (const [id, obj] of featureObjects) {
      const st = findStructure(id);
      applyOpacity(obj, st ? st.opacity : 1);
    }
  });
  $('#auto-rotate').addEventListener('change', (e) => setAutoRotate(e.target.checked));
  $('#show-grid').addEventListener('change', (e) => panes.forEach((p) => { p.grid.visible = e.target.checked && !p.bounds.isEmpty(); }));

  // Mobile left-rail drawer
  $('#rail-left-restore').addEventListener('click', () => document.body.classList.toggle('no-left'));
  if (window.matchMedia('(max-width: 620px)').matches) document.body.classList.add('no-left');
  viewportEl.addEventListener('pointerdown', () => {
    if (window.matchMedia('(max-width: 620px)').matches) document.body.classList.add('no-left');
  });
}

function findStructure(id) {
  for (const s of samplesData.samples) { const f = s.structures.find((x) => x.id === id); if (f) return f; }
  return null;
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
  glb.renderer.render(glb.scene, glb.camera);
  stl.renderer.render(stl.scene, stl.camera);

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
  wireDivider();
  setRenderMode('surface');
  renderOverlay('idle');
  refreshStlEmpty();
  requestAnimationFrame(animate);

  try {
    await loadCSVData();
    buildLayerTree();
    probeSizes(annotateSize);
  } catch (err) {
    console.error(err);
    toast(`Failed to load dataset: ${err.message}`, 'error', 10000);
    layerTree.innerHTML = `<div class="tree-error">Could not load the dataset manifest.<br>${err.message}</div>`;
  }
}

init();
