// ============================================================================
//  viewer.js — Retina Tomography Workbench
//  Two linked Three.js scenes (eye-anatomy GLB | segmented layers) wrapped in a
//  clinical instrument-panel UI: synced orbit, render modes (surface / wireframe
//  / tri-planar slices via clipping planes), on-demand loading, caching & HUD.
//  The scenes, the view state and every transition live in core/ (DOM-free);
//  this file is the view + controller: it turns DOM input into calls on the
//  workbench and renders the workbench's events back into the DOM.
// ============================================================================

import { loadCSVData, probeSizes, resolveStructure, samplesData, formatBytes } from './data-loader.js';
import { fetchBuffer, isCached, clearCache } from './asset-loader.js';
import { browserAdapters, mountPane } from './app/browser-adapters.js';
import { createWorkbench } from './core/workbench.js';
import { ANATOMY_MODELS } from './core/anatomy-models.js';
import { HEAVY_BYTES } from './core/layers.js';

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
//  Workbench
// ---------------------------------------------------------------------------
// core/workbench.js owns the two panes, the camera sync, the layer and
// anatomy controllers and the view state; the WebGL renderer, DOM-wired
// OrbitControls and ResizeObserver come from app/browser-adapters.js. The
// core talks outward only through wb.on(...) and the listeners (wired in
// init) render each transition into the DOM.
//
// `?model=<id>` picks a registry model for the reference eye at load;
// `?anatomy=<url>` still overrides the file outright, for a model that isn't
// in the registry. Both are read once, here.
const params = new URLSearchParams(location.search);
const wb = createWorkbench({
  adapters: { glb: browserAdapters(glbPane), stl: browserAdapters(stlPane) },
  io: { fetchBuffer, isCached },
  modelId: params.get('model'),
  anatomyUrl: params.get('anatomy'),
  startTime: performance.now(),
});
const mounts = { glb: mountPane(wb.panes.glb, glbPane), stl: mountPane(wb.panes.stl, stlPane) };
const sampleCtlRefs = new Map();    // sampleId -> { ox, oy, oz } offset slider inputs

// ---------------------------------------------------------------------------
//  View events — render mode, clips, layout, sync, auto-rotate, status bar
// ---------------------------------------------------------------------------
const statCam = $('#stat-cam'), statTris = $('#stat-tris'), statFps = $('#stat-fps');

function wireViewEvents() {
  wb.on('rendermode', ({ mode }) => {
    $('#render-mode').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#slice-sec').hidden = mode !== 'slices';
    $('#mode-desc').textContent = {
      surface: 'Shaded surface · solid meshes',
      wireframe: 'Wireframe · edge view',
      slices: 'Tri-planar MPR · orthogonal clipping',
    }[mode];
    $('#stat-mode').textContent = mode;
  });
  // Only mirrors the axis checkboxes (entering Slices auto-enables X); the
  // sliders keep writing their own readouts from their input handlers.
  wb.on('clip', (c) => {
    document.querySelectorAll('.slice-toggle input').forEach((cb) => { cb.checked = c[cb.dataset.axis].on; });
  });
  wb.on('layout', ({ layout }) => {
    document.querySelectorAll('#layout-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
    document.body.classList.toggle('overlay-layout', layout === 'overlay');
    $('#overlay-ctl').hidden = layout !== 'overlay';
    $('#layout-desc').textContent = layout === 'overlay' ? 'Everything superimposed & aligned' : 'Anatomy & layers side by side';
    // Re-size + re-fit after the pane reflows to its new width (twice, to be safe:
    // once on the next frame, once after layout has fully settled).
    const resize = () => {
      mounts.glb.measure(); mounts.stl.measure();
      wb.refitAfterReflow(layout);
    };
    requestAnimationFrame(resize);
    setTimeout(resize, 90);
  });
  wb.on('sync', ({ on }) => {
    btnSync.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('synced', on);
    const label = btnSync.querySelector('.sync-toggle-label');
    if (label) label.textContent = on ? 'Synced' : 'Sync views';
  });
  wb.on('autorotate', ({ on }) => {
    $('#auto-rotate').checked = on;
    document.querySelectorAll('.hud-toolbar [data-act="auto"]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
  });
  wb.on('stats', ({ az, el, triangles, fps }) => {
    statCam.innerHTML = `az ${az}°&nbsp;&nbsp;el ${el}°`;
    statTris.textContent = `${triangles.toLocaleString()} triangles`;
    statFps.textContent = `${fps} fps`;
  });
}

// ---------------------------------------------------------------------------
//  Layer rows
// ---------------------------------------------------------------------------
// Downloading, parsing and placing a layer lives in core/layers.js; the app
// keeps the row elements and renders the controller's events onto them.
const rowRefs = new Map();

function wireLayerEvents() {
  wb.on('layer:state', ({ id, state, phase, cached }) => {
    const refs = rowRefs.get(id);
    if (!refs) return;
    const label = state === 'loading'
      ? { start: 'Downloading… 0%', cache: 'Loading from cache…', build: 'Building mesh…' }[phase]
      : state === 'loaded' ? (cached ? 'Loaded · cached' : 'Loaded')
        : state === 'error' ? 'Failed to load' : '';
    setRowState(refs, state, label);
    if (state === 'loading' && phase === 'build') refs.bar.style.width = '100%';
  });
  wb.on('layer:progress', ({ id, loaded, total, pct }) => {
    const refs = rowRefs.get(id);
    if (!refs) return;
    refs.bar.style.width = `${total ? Math.min(pct, 99) : 50}%`;
    refs.status.textContent = total
      ? `Downloading… ${pct}% (${formatBytes(loaded)} / ${formatBytes(total)})`
      : `Downloading… ${formatBytes(loaded)}`;
  });
  wb.on('layer:error', ({ id, label, error }) => {
    toast(`Couldn't load "${label}". ${error.message}`, 'error');
    const refs = rowRefs.get(id);
    if (refs) refs.checkbox.checked = false;
  });
  wb.on('layers:visible', ({ anyVisible }) => stlEmpty.classList.toggle('hidden', anyVisible));
  // Keep a sample's offset sliders in step with its 3D group.
  wb.on('sample:offset', ({ sampleId, axis, value }) => {
    const ref = sampleCtlRefs.get(sampleId);
    if (ref && ref['o' + axis]) { ref['o' + axis].value = Math.round(value * 100); setFill(ref['o' + axis]); }
  });
}

// ---------------------------------------------------------------------------
//  Anatomy GLB (left pane) — lazy
// ---------------------------------------------------------------------------
// Downloading, parsing, placing and styling the reference eye lives in
// core/anatomy.js; the app keeps the structure rows and the overlay card and
// renders the controller's events onto them.
const anatomyRowRefs = new Map();   // key -> { row, checkbox, swatch, colorInput, opacity }

function wireAnatomyEvents() {
  // A model switch: the URL mirrors the choice, the menu and the (now empty)
  // tree follow — all before the new model starts downloading.
  wb.on('anatomy:model', ({ id, isDefault }) => {
    const url = new URL(location.href);
    if (isDefault) url.searchParams.delete('model');
    else url.searchParams.set('model', id);
    history.replaceState(null, '', url);
    syncModelMenu();
    buildAnatomyTree();
  });
  wb.on('anatomy:status', (s) => {
    if (s.state === 'loaded') { glbOverlay.classList.add('hidden'); return; }
    if (s.state === 'loading') {
      const label = s.phase === 'start' ? 'Starting…'
        : s.phase === 'build' ? 'Building model…'
          : s.fromCache ? 'Loading from cache…'
            : s.total ? `${s.pct}% · ${formatBytes(s.loaded)} / ${formatBytes(s.total)}` : formatBytes(s.loaded);
      renderOverlay('loading', { pct: s.pct, label });
    } else if (s.state === 'error') {
      renderOverlay('error', { message: s.message });
      toast(`Couldn't load the eye-anatomy model. ${s.message}`, 'error');
    } else {
      renderOverlay('idle');
    }
  });
  wb.on('anatomy:parts', () => buildAnatomyTree());
  wb.on('anatomy:preset', ({ name, preset }) => {
    syncAnatomyRows();
    document.querySelectorAll('#anatomy-preset .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
    const desc = $('#anatomy-preset-desc');
    if (desc) desc.textContent = preset.desc;
  });
}

function syncAnatomyRows() {
  for (const [key, refs] of anatomyRowRefs) {
    const st = wb.anatomy.stateFor(key);
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
    const cached = await isCached(wb.anatomy.url());
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <span class="ms overlay-icon">visibility</span>
        <div class="overlay-title">${wb.anatomy.model().label}</div>
        <div class="overlay-sub">${wb.anatomy.model().blurb}${cached ? ' · cached' : ''}</div>
        <button class="btn btn-primary" id="overlay-load">Load model</button>
      </div>`;
    glbOverlay.querySelector('#overlay-load').onclick = () => wb.anatomy.load();
  } else if (state === 'loading') {
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <div class="overlay-title">Loading eye anatomy</div>
        <div class="progress"><div class="progress-fill" style="width:${data.pct || 0}%"></div></div>
        <div class="overlay-sub">${data.label || ''}</div>
        <button class="btn btn-ghost" id="overlay-cancel">Cancel</button>
      </div>`;
    glbOverlay.querySelector('#overlay-cancel').onclick = () => wb.anatomy.cancel();
  } else if (state === 'error') {
    glbOverlay.innerHTML = `
      <div class="overlay-card">
        <div class="overlay-title">Couldn't load model</div>
        <div class="overlay-sub">${data.message || ''}</div>
        <button class="btn btn-primary" id="overlay-retry">Try again</button>
      </div>`;
    glbOverlay.querySelector('#overlay-retry').onclick = () => wb.anatomy.load();
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
  const presets = wb.anatomy.presets();
  const names = Object.keys(presets);
  host.innerHTML = '';
  host.classList.toggle('seg-2', names.length === 2);
  for (const name of names) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (name === wb.anatomy.preset ? ' active' : '');
    b.dataset.preset = name;
    b.textContent = presets[name].label;
    b.addEventListener('click', () => wb.anatomy.setPreset(name));
    host.appendChild(b);
  }
  const desc = $('#anatomy-preset-desc');
  if (desc) desc.textContent = presets[wb.anatomy.preset]?.desc || '';
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
      item.addEventListener('click', () => { menu.classList.remove('open'); wb.anatomy.setModel(m.id); });
    }
    menu.appendChild(item);
  }
  syncModelMenu();
}

function syncModelMenu() {
  const m = wb.anatomy.model();
  const label = $('#model-label');
  if (label) label.textContent = m.label;
  const src = $('#anatomy-source');
  if (src) {
    src.innerHTML = m.href
      ? `<a href="${m.href}" target="_blank" rel="noopener">${m.source} ↗</a> · ${m.license}`
      : `${m.source} · ${m.license}`;
  }
  document.querySelectorAll('#model-menu .model-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.modelId === wb.anatomy.modelId());
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
  if (!wb.anatomy.parts.size) { const c = $('#anatomy-count'); if (c) c.textContent = '—'; return; }

  let lastGroup = null;
  for (const s of wb.anatomy.structures()) {
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
  if (count) count.textContent = wb.anatomy.parts.size;
}

function buildAnatomyRow(s) {
  const st = wb.anatomy.stateFor(s.key);
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
    row.classList.toggle('is-off', !checkbox.checked);
    wb.anatomy.setVisible(s.key, checkbox.checked);
  });
  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', (e) => {
    swatch.style.background = e.target.value;
    wb.anatomy.setColor(s.key, parseInt(e.target.value.slice(1), 16));
  });
  opacity.addEventListener('input', () => {
    setFill(opacity);
    wb.anatomy.setOpacity(s.key, Number(opacity.value) / 100);
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
    vis.addEventListener('change', () => wb.layers.setSampleVisible(sample.id, vis.checked));
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
  op.addEventListener('input', () => { setFill(op); wb.layers.setSampleOpacity(sample, Number(op.value) / 100); });

  const refs = {};
  for (const [ax, sel] of [['x', '.s-ox'], ['y', '.s-oy'], ['z', '.s-oz']]) {
    const sl = wrap.querySelector(sel); setFill(sl); refs['o' + ax] = sl;
    sl.addEventListener('input', () => { setFill(sl); wb.layers.offsetChanged(sample, ax, Number(sl.value) / 100); });
  }
  sampleCtlRefs.set(sample.id, refs);

  wrap.querySelector('.s-reset').addEventListener('click', () => wb.layers.resetOffsets(sample));
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
    wb.layers.setColor(structure, parseInt(e.target.value.slice(1), 16));
  });
  opacity.addEventListener('input', (e) => {
    setFill(e.target);
    wb.layers.setOpacity(structure, Number(e.target.value) / 100);
  });

  checkbox.addEventListener('change', async () => {
    if (checkbox.checked) {
      if (wb.layers.has(structure.id)) { wb.layers.setVisible(structure.id, true); return; }
      if (!structure._resolved) {
        setRowState(rowRefs.get(structure.id), 'loading', 'Checking…');
        await resolveStructure(structure);
        annotateSize(structure);
        if (!checkbox.checked) { setRowState(rowRefs.get(structure.id), 'idle', ''); return; }
      }
      if (wb.layers.isHeavy(structure) && !(await isCached(structure.path))) {
        const ok = await askConfirm({ title: 'Large layer', message: `“${structure.label}” is ${formatBytes(structure.bytes)}. It will download once and then be cached. Continue?`, confirmLabel: 'Download' });
        if (!ok) { checkbox.checked = false; return; }
      }
      wb.layers.load(structure);
    } else {
      wb.layers.abort(structure.id);
      wb.layers.setVisible(structure.id, false);
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
  const sample = wb.layers.findSample(sampleId);
  if (sample) $('#study-label').textContent = `${sample.label.toUpperCase()} · µCT · SEG`;

  wb.layers.focusSample(sampleId);
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
  bar.querySelector('[data-act="auto"]').onclick = () => wb.setAutoRotate(!wb.state().autoRotate);
  bar.querySelector('[data-act="reset"]').onclick = () => wb.resetPane(pane.id);
  bar.querySelector('[data-act="fit"]').onclick = () => wb.resetPane(pane.id);
  frag.appendChild(bar);
  paneEl.appendChild(frag);
}

// ---------------------------------------------------------------------------
//  Controls wiring
// ---------------------------------------------------------------------------
function wireControls() {
  btnSync.addEventListener('click', () => wb.setSync(!wb.state().sync));
  $('#btn-reset').addEventListener('click', () => wb.resetAll());
  $('#btn-fit').addEventListener('click', () => wb.resetAll());

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

  $('#solid-fill').addEventListener('change', (e) => wb.setSolidFill(e.target.checked));

  $('#btn-clear-cache').addEventListener('click', async () => {
    const ok = await askConfirm({ title: 'Clear cache', message: 'Remove all locally cached meshes? They will re-download next time.', confirmLabel: 'Clear' });
    if (ok) { await clearCache(); toast('Cache cleared.', 'info'); }
  });

  // Render mode segmented control
  $('#render-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) wb.setRenderMode(btn.dataset.mode);
  });

  // Layout (split / overlay) + anatomy group controls
  $('#layout-seg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) wb.setLayout(b.dataset.layout); });
  $('#an-vis').addEventListener('change', (e) => wb.anatomy.setObjectVisible(e.target.checked));
  const modelBtn = $('#model-selector'), modelMenu = $('#model-menu');
  modelBtn?.addEventListener('click', (e) => { e.stopPropagation(); modelMenu.classList.toggle('open'); });
  document.addEventListener('click', (e) => {
    if (modelMenu?.classList.contains('open') && !modelMenu.contains(e.target)) modelMenu.classList.remove('open');
  });
  const anOp = $('#an-op'); setFill(anOp);
  anOp.addEventListener('input', () => { setFill(anOp); wb.anatomy.setPaneOpacity(Number(anOp.value) / 100); });
  for (const [ax, id] of [['x', '#an-ox'], ['y', '#an-oy'], ['z', '#an-oz']]) {
    const sl = $(id); setFill(sl);
    sl.addEventListener('input', () => { setFill(sl); wb.anatomy.setOffset(ax, Number(sl.value) / 100); });
  }

  // Slice plane controls
  document.querySelectorAll('.slice-toggle input').forEach((cb) => {
    cb.addEventListener('change', () => wb.setClipAxis(cb.dataset.axis, cb.checked));
  });
  document.querySelectorAll('.slice-row .slider').forEach((sl) => {
    setFill(sl);
    sl.addEventListener('input', () => {
      setFill(sl);
      $(`.slice-val[data-axis="${sl.dataset.axis}"]`).textContent = `${sl.value}%`;
      wb.setClipPos(sl.dataset.axis, Number(sl.value) / 100);
    });
  });
  $('#slice-flip').addEventListener('change', (e) => wb.setClipFlip(e.target.checked));
  $('#slice-show').addEventListener('change', (e) => wb.setShowPlanes(e.target.checked));

  // Display controls
  const op = $('#global-opacity'); setFill(op);
  op.addEventListener('input', (e) => {
    setFill(e.target);
    $('#opacity-val').textContent = `${e.target.value}%`;
    wb.setGlobalOpacity(Number(e.target.value) / 100);
  });
  $('#auto-rotate').addEventListener('change', (e) => wb.setAutoRotate(e.target.checked));
  $('#show-grid').addEventListener('change', (e) => wb.setGrid(e.target.checked));
  $('#link-offsets').addEventListener('change', (e) => wb.setLinkOffsets(e.target.checked));

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
//  Render loop
// ---------------------------------------------------------------------------
// The frame body (controls, headlight, render, fps / status stats) is
// wb.tick; the app only owns the rAF loop and the clock.
function animate(now) {
  requestAnimationFrame(animate);
  wb.tick(now);
}

// ---------------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------------
async function init() {
  addHUD(wb.panes.glb, glbPane);
  addHUD(wb.panes.stl, stlPane);
  wireControls();
  wireViewEvents();
  wireLayerEvents();
  wireAnatomyEvents();
  wireDivider();
  wb.setRenderMode('surface');
  buildModelMenu();
  buildAnatomyTree();
  renderOverlay('idle');
  wb.layers.syncVisibility();
  requestAnimationFrame(animate);

  try {
    await loadCSVData();
    wb.layers.setSamples(samplesData.samples);
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
