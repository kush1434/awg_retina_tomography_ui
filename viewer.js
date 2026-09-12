// ============================================================================
//  viewer.js — Retina Tomography Workbench
//  Two linked Three.js scenes (eye-anatomy GLB | segmented layers) wrapped in a
//  clinical instrument-panel UI: synced orbit, render modes (surface / wireframe
//  / tri-planar slices via clipping planes), on-demand loading, caching & HUD.
//  The scenes, the view state and every transition live in core/ (DOM-free);
//  the view lives in app/ui/ (the chrome and the two panels, which render the
//  workbench's events); this file is the controller entry: it builds the
//  workbench with the browser adapters, reads the URL, turns the top-level
//  controls into workbench calls and runs the frame loop.
// ============================================================================

import { loadCSVData, probeSizes, samplesData } from './data-loader.js';
import { fetchBuffer, isCached, clearCache } from './asset-loader.js';
import { browserAdapters, mountPane } from './app/browser-adapters.js';
import { setFill, toast, askConfirm, addHUD, wireViewEvents, buildStudyMenu, openStudyMenu, closeStudyMenu } from './app/ui/chrome.js';
import { createLayerPanel } from './app/ui/layer-panel.js';
import { createAnatomyPanel } from './app/ui/anatomy-panel.js';
import { createWorkbench } from './core/index.js';

// ---------------------------------------------------------------------------
//  DOM
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const viewportEl = $('#viewport');
const glbPane = $('#pane-glb');
const stlPane = $('#pane-stl');
const divider = $('#divider');
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
const io = { fetchBuffer, isCached };
const wb = createWorkbench({
  adapters: { glb: browserAdapters(glbPane), stl: browserAdapters(stlPane) },
  io,
  modelId: params.get('model'),
  anatomyUrl: params.get('anatomy'),
  startTime: performance.now(),
});
const mounts = { glb: mountPane(wb.panes.glb, glbPane), stl: mountPane(wb.panes.stl, stlPane) };

// The two panels keep their own row elements and render the layer / anatomy
// events onto them; they share the asset I/O with the workbench so a cached
// mesh is recognised the same way on both sides.
const layerPanel = createLayerPanel(wb, io);
const anatomyPanel = createAnatomyPanel(wb, io);

// ---------------------------------------------------------------------------
//  URL ↔ anatomy model
// ---------------------------------------------------------------------------
// A model switch: the URL mirrors the choice, then the panel's menu and (now
// empty) tree follow — all before the new model starts downloading. This
// listener is registered ahead of the panel's so the URL lands first.
function wireAnatomyUrl() {
  wb.on('anatomy:model', ({ id, isDefault }) => {
    const url = new URL(location.href);
    if (isDefault) url.searchParams.delete('model');
    else url.searchParams.set('model', id);
    history.replaceState(null, '', url);
  });
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
  addHUD(wb, wb.panes.glb, glbPane);
  addHUD(wb, wb.panes.stl, stlPane);
  wireControls();
  wireViewEvents(wb, mounts);
  layerPanel.wireEvents();
  wireAnatomyUrl();
  anatomyPanel.wireEvents();
  wireDivider();
  wb.setRenderMode('surface');
  anatomyPanel.buildModelMenu();
  anatomyPanel.buildTree();
  anatomyPanel.renderOverlay('idle');
  wb.layers.syncVisibility();
  requestAnimationFrame(animate);

  try {
    await loadCSVData();
    wb.layers.setSamples(samplesData.samples);
    layerPanel.build(samplesData.samples);
    buildStudyMenu(wb, samplesData.samples);
    probeSizes(layerPanel.annotateSize);
  } catch (err) {
    console.error(err);
    toast(`Failed to load dataset: ${err.message}`, 'error', 10000);
    layerPanel.showError(err.message);
  }
}

init();
