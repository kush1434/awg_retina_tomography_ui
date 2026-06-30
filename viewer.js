// ============================================================================
//  viewer.js — Retina Tomography Viewer
//  Two independent Three.js scenes (eye-anatomy GLB | segmented layers) with
//  synchronised orbit, on-demand loading, progress, caching and layer controls.
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
// The left-pane anatomy model. Prefer the optimized copy that ships with the
// app (same-origin, ~7 MB); fall back to the original 137 MB GLB on HF.
const ANATOMY_OPTIMIZED = 'optimized/eye-anatomy.glb';
const ANATOMY_ORIGINAL = `${HF_BASE}/eye-anatomy.glb`;
// Files larger than this prompt a confirmation before download.
const HEAVY_BYTES = 400 * 1024 * 1024;

// ---------------------------------------------------------------------------
//  DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const sidebar = $('#sidebar');
const sidebarRestore = $('#sidebar-restore');
const layerTree = $('#layer-tree');
const stage = $('#stage');
const glbPane = $('#pane-glb');
const stlPane = $('#pane-stl');
const divider = $('#divider');
const glbOverlay = $('#glb-overlay');
const stlEmpty = $('#stl-empty');
const toastHost = $('#toast-host');
const btnSync = $('#btn-sync');

// ---------------------------------------------------------------------------
//  Shared GLTF/Draco loader
// ---------------------------------------------------------------------------
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
const stlLoader = new STLLoader();

// ---------------------------------------------------------------------------
//  Pane factory — builds an isolated scene/camera/renderer/controls
// ---------------------------------------------------------------------------
function createPane(mountEl) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x202028, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(1, 1.2, 1);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.5); fill.position.set(-1, -0.6, -0.8);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1e7);
  camera.position.set(0, 0, 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mountEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const root = new THREE.Group();
  scene.add(root);

  function size() {
    const w = mountEl.clientWidth || 1;
    const h = mountEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  new ResizeObserver(size).observe(mountEl);

  return { scene, camera, renderer, controls, root, size, defaultDist: 100 };
}

const glb = createPane(glbPane);
const stl = createPane(stlPane);

// ---------------------------------------------------------------------------
//  Camera framing
// ---------------------------------------------------------------------------
function fitToObject(pane, object, offset = 1.4) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fov = pane.camera.fov * (Math.PI / 180);
  let dist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * offset;

  pane.camera.near = Math.max(maxDim / 1000, 0.001);
  pane.camera.far = maxDim * 1000;
  pane.camera.updateProjectionMatrix();

  pane.controls.target.copy(center);
  pane.camera.position.copy(center).add(new THREE.Vector3(0, 0, dist));
  pane.controls.update();
  pane.defaultDist = dist;
}

function resetPane(pane) {
  if (pane.root.children.length) fitToObject(pane, pane.root);
}

// ---------------------------------------------------------------------------
//  Orientation sync (mirrors orbit angles only — keeps each pane's own zoom)
// ---------------------------------------------------------------------------
let syncEnabled = false;
let isSyncing = false;

function applyOrientation(pane, azimuth, polar) {
  const dist = pane.controls.getDistance();
  const t = pane.controls.target;
  const sinPhi = Math.sin(polar);
  const offset = new THREE.Vector3(
    sinPhi * Math.sin(azimuth),
    Math.cos(polar),
    sinPhi * Math.cos(azimuth)
  ).multiplyScalar(dist);
  pane.camera.position.copy(t).add(offset);
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
  btnSync.classList.toggle('active', on);
  if (on) {
    glb.controls.addEventListener('change', glbToStl);
    stl.controls.addEventListener('change', stlToGlb);
    mirror(glb, stl); // align once, keeping each pane's zoom
  } else {
    glb.controls.removeEventListener('change', glbToStl);
    stl.controls.removeEventListener('change', stlToGlb);
  }
}

// ---------------------------------------------------------------------------
//  Material helpers
// ---------------------------------------------------------------------------
function makeMaterial(colorHex, opacity) {
  return new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.85,
    metalness: 0.0,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  });
}

function applyColor(object, colorHex) {
  object.traverse((c) => { if (c.isMesh && c.material) c.material.color.setHex(colorHex); });
}

function applyOpacity(object, opacity) {
  object.traverse((c) => {
    if (c.isMesh && c.material) {
      c.material.opacity = opacity;
      c.material.transparent = opacity < 1;
      c.material.depthWrite = opacity >= 1;
      c.renderOrder = opacity < 1 ? 1 : 0;
      c.material.needsUpdate = true;
    }
  });
}

// ---------------------------------------------------------------------------
//  Layer (STL / GLB) loading
// ---------------------------------------------------------------------------
const featureObjects = new Map();   // id -> Object3D
const rowRefs = new Map();          // id -> { bar, status, size, checkbox }
const inFlight = new Map();         // id -> AbortController

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

    const object = structure.kind === 'gltf'
      ? await parseGLTF(buffer)
      : parseSTL(buffer, structure);

    object.userData.id = structure.id;
    featureObjects.set(structure.id, object);
    stl.root.add(object);
    applyColor(object, structure.color);
    applyOpacity(object, structure.opacity);

    if (stl.root.children.length === 1) fitToObject(stl, stl.root);
    refreshStlEmpty();
    setRowState(refs, 'loaded', (await isCached(structure.path)) ? 'Loaded · cached' : 'Loaded');
  } catch (err) {
    if (err.name === 'AbortError') {
      setRowState(refs, 'idle', '');
    } else {
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
          c.material = makeMaterial(0xffffff, 1); // recolored by applyColor()
        }
      });
      resolve(gltf.scene);
    }, reject);
  });
}

// ---------------------------------------------------------------------------
//  Eye-anatomy GLB (left pane) — lazy, opt-in
// ---------------------------------------------------------------------------
let anatomyController = null;

async function resolveAnatomyURL() {
  const override = new URLSearchParams(location.search).get('anatomy');
  if (override) return override;
  try {
    const res = await fetch(ANATOMY_OPTIMIZED, { method: 'HEAD', mode: 'cors' });
    if (res.ok) return ANATOMY_OPTIMIZED;
  } catch { /* fall through */ }
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
        renderOverlay('loading', {
          pct,
          label: total
            ? `${pct}% · ${formatBytes(loaded)} / ${formatBytes(total)}`
            : formatBytes(loaded),
        });
      },
    });
    renderOverlay('loading', { pct: 100, label: 'Building model…' });

    const scene = await parseGLTF_anatomy(buffer);
    glb.root.clear();
    glb.root.add(scene);
    fitToObject(glb, scene, 1.5);
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
      gltf.scene.traverse((c) => {
        if (c.isMesh) {
          c.frustumCulled = false;
          if (c.material) { c.material.side = THREE.DoubleSide; c.material.needsUpdate = true; }
        }
      });
      resolve(gltf.scene);
    }, reject);
  });
}

// ---------------------------------------------------------------------------
//  Overlay (GLB pane) state machine
// ---------------------------------------------------------------------------
async function renderOverlay(state, data = {}) {
  glbOverlay.classList.remove('hidden');
  if (state === 'idle') {
    const cached = await isCached(ANATOMY_ORIGINAL) || await isCached(ANATOMY_OPTIMIZED);
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <svg viewBox="0 0 24 24" class="overlay-icon" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8zm0-2a2 2 0 100-4 2 2 0 000 4z"/></svg>
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
//  Sidebar / layer tree UI
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
  for (const sample of samplesData.samples) {
    const group = document.createElement('div');
    group.className = 'sample';

    const head = document.createElement('button');
    head.className = 'sample-head';
    head.innerHTML = `<span class="caret">▸</span><span class="sample-name">${sample.label}</span>`;
    if (sample.link) {
      head.innerHTML += `<a class="sample-src" href="${sample.link}" target="_blank" rel="noopener" title="Open source dataset">↗</a>`;
    }

    const body = document.createElement('div');
    body.className = 'sample-body open';
    head.classList.add('open');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.sample-src')) return;
      head.classList.toggle('open');
      body.classList.toggle('open');
    });

    for (const st of sample.structures) {
      body.appendChild(buildRow(st));
    }
    group.append(head, body);
    layerTree.appendChild(group);
  }
}

function buildRow(structure) {
  const row = document.createElement('div');
  row.className = 'layer-row';
  row.dataset.state = 'idle';

  const hex = `#${structure.color.toString(16).padStart(6, '0')}`;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'layer-check';
  checkbox.id = `chk-${structure.id}`;

  const swatch = document.createElement('button');
  swatch.className = 'layer-swatch';
  swatch.style.background = hex;
  swatch.title = 'Change colour';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = hex;
  colorInput.className = 'layer-color-input';

  const label = document.createElement('label');
  label.className = 'layer-label';
  label.htmlFor = checkbox.id;
  label.innerHTML = `<span class="layer-name">${structure.label}</span><span class="layer-size"></span>`;

  const opacity = document.createElement('input');
  opacity.type = 'range';
  opacity.min = '0'; opacity.max = '100';
  opacity.value = String(Math.round(structure.opacity * 100));
  opacity.className = 'layer-opacity';
  opacity.title = 'Opacity';

  const progress = document.createElement('div');
  progress.className = 'layer-progress';
  progress.style.display = 'none';
  const bar = document.createElement('div');
  bar.className = 'layer-bar';
  progress.appendChild(bar);

  const status = document.createElement('div');
  status.className = 'layer-status';

  const top = document.createElement('div');
  top.className = 'layer-top';
  top.append(checkbox, swatch, colorInput, label, opacity);
  row.append(top, progress, status);

  const refs = { row, bar, status, progress, checkbox, sizeEl: label.querySelector('.layer-size') };
  rowRefs.set(structure.id, refs);

  // Interactions ---------------------------------------------------------
  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', (e) => {
    const val = e.target.value;
    swatch.style.background = val;
    structure.color = parseInt(val.slice(1), 16);
    const obj = featureObjects.get(structure.id);
    if (obj) applyColor(obj, structure.color);
  });

  opacity.addEventListener('input', (e) => {
    structure.opacity = Number(e.target.value) / 100;
    const obj = featureObjects.get(structure.id);
    if (obj) applyOpacity(obj, structure.opacity);
  });

  checkbox.addEventListener('change', async () => {
    const existing = featureObjects.get(structure.id);
    if (checkbox.checked) {
      if (existing) { existing.visible = true; refreshStlEmpty(); return; }
      // Make sure we've picked optimized-vs-original (and know the size) before
      // loading, in case the user clicks before the background probe finishes.
      if (!structure._resolved) {
        setRowState(rowRefs.get(structure.id), 'loading', 'Checking…');
        await resolveStructure(structure);
        annotateSize(structure);
        if (!checkbox.checked) { setRowState(rowRefs.get(structure.id), 'idle', ''); return; }
      }
      // Heavy-file gate.
      if (structure.bytes && structure.bytes > HEAVY_BYTES && !(await isCached(structure.path))) {
        const ok = await askConfirm({
          title: 'Large layer',
          message: `“${structure.label}” is ${formatBytes(structure.bytes)}. It will download once and then be cached. Continue?`,
          confirmLabel: 'Download',
        });
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
//  Toasts + confirm dialog
// ---------------------------------------------------------------------------
function toast(message, type = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
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
    const done = (val) => { back.remove(); resolve(val); };
    back.addEventListener('click', (e) => {
      if (e.target === back) done(false);
      const act = e.target.dataset.act;
      if (act === 'ok') done(true);
      if (act === 'cancel') done(false);
    });
  });
}

// ---------------------------------------------------------------------------
//  Top-bar / global controls
// ---------------------------------------------------------------------------
function wireControls() {
  btnSync.addEventListener('click', () => setSync(!syncEnabled));
  $('#btn-reset').addEventListener('click', () => { resetPane(glb); resetPane(stl); });
  $('#pane-glb .pane-reset').addEventListener('click', () => resetPane(glb));
  $('#pane-stl .pane-reset').addEventListener('click', () => resetPane(stl));

  const help = $('#help-dialog');
  $('#btn-help').addEventListener('click', () => help.showModal());
  help.querySelector('.dialog-close').addEventListener('click', () => help.close());
  help.addEventListener('click', (e) => { if (e.target === help) help.close(); });

  $('#btn-clear-cache').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Clear cache',
      message: 'Remove all locally cached meshes? They will re-download next time.',
      confirmLabel: 'Clear',
    });
    if (ok) { await clearCache(); toast('Cache cleared.', 'info'); }
  });

  // Sidebar collapse / restore (+ mobile drawer backdrop)
  const collapse = () => document.body.classList.add('sidebar-collapsed');
  const expand = () => document.body.classList.remove('sidebar-collapsed');
  $('#sidebar-collapse').addEventListener('click', collapse);
  sidebarRestore.addEventListener('click', expand);
  $('#sidebar-backdrop').addEventListener('click', collapse);

  // On small screens start with the drawer closed so the 3D views are visible.
  if (window.matchMedia('(max-width: 860px)').matches) collapse();
}

// ---------------------------------------------------------------------------
//  Draggable divider (desktop, horizontal layout only)
// ---------------------------------------------------------------------------
function wireDivider() {
  let dragging = false;
  const isHorizontal = () => getComputedStyle(stage).flexDirection === 'row';

  divider.addEventListener('pointerdown', (e) => {
    if (!isHorizontal()) return;
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
  });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    let ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.min(0.85, Math.max(0.15, ratio));
    glbPane.style.flex = `0 0 ${ratio * 100}%`;
    stlPane.style.flex = '1 1 0';
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { divider.releasePointerCapture(e.pointerId); } catch {}
    document.body.classList.remove('dragging');
  };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
}

// ---------------------------------------------------------------------------
//  Render loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  glb.controls.update();
  stl.controls.update();
  glb.renderer.render(glb.scene, glb.camera);
  stl.renderer.render(stl.scene, stl.camera);
}

// ---------------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------------
async function init() {
  wireControls();
  wireDivider();
  renderOverlay('idle');
  refreshStlEmpty();
  animate();

  try {
    await loadCSVData();
    buildLayerTree();
    probeSizes(annotateSize); // non-blocking
  } catch (err) {
    console.error(err);
    toast(`Failed to load dataset: ${err.message}`, 'error', 10000);
    layerTree.innerHTML = `<div class="tree-error">Could not load the dataset manifest.<br>${err.message}</div>`;
  }
}

init();
