// ============================================================================
//  anatomy-panel.js — the reference-eye panel: the model menu and source line,
//  the preset segmented control, one row per structure (visibility, colour,
//  opacity) and the overlay card over the left pane (idle / loading / error).
//  Downloading, parsing, placing and styling the reference eye lives in
//  core/anatomy.js; the panel keeps the structure rows and the overlay card,
//  turns their input into wb.anatomy.* calls and renders the controller's
//  events back onto them. Pure view: it receives the workbench and the asset
//  I/O, and touches the document only from the factory onwards.
// ============================================================================

import { formatBytes } from '../../data-loader.js';
import { ANATOMY_MODELS } from '../../core/index.js';
import { setFill, toast } from './chrome.js';

const $ = (s) => document.querySelector(s);

/**
 * Build the anatomy panel over `wb`.
 * @param {object} wb the workbench (core/workbench.js)
 * @param {{ isCached: (url: string) => Promise<boolean> }} io the same asset
 *   I/O the workbench downloads through — the idle card says when the model
 *   is already in the cache.
 */
export function createAnatomyPanel(wb, io) {
  const glbOverlay = $('#glb-overlay');
  const anatomyRowRefs = new Map();   // key -> { row, checkbox, swatch, colorInput, opacity }

  // -------------------------------------------------------------------------
  //  Anatomy events → menu, tree, overlay
  // -------------------------------------------------------------------------
  function wireEvents() {
    // A model switch: the menu and the (now empty) tree follow — before the
    // new model starts downloading. (viewer.js mirrors the choice into the URL
    // from its own listener, registered ahead of this one.)
    wb.on('anatomy:model', () => {
      syncModelMenu();
      buildTree();
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
    wb.on('anatomy:parts', () => buildTree());
    wb.on('anatomy:preset', ({ name, preset }) => {
      syncRows();
      document.querySelectorAll('#anatomy-preset .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
      const desc = $('#anatomy-preset-desc');
      if (desc) desc.textContent = preset.desc;
    });
  }

  function syncRows() {
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

  // -------------------------------------------------------------------------
  //  GLB overlay state machine
  // -------------------------------------------------------------------------
  async function renderOverlay(state, data = {}) {
    glbOverlay.classList.remove('hidden');
    if (state === 'idle') {
      const cached = await io.isCached(wb.anatomy.url());
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

  // -------------------------------------------------------------------------
  //  Presets, model menu, structure tree
  // -------------------------------------------------------------------------
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
  function buildTree() {
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
      host.appendChild(buildRow(s));
    }
    syncRows();
    const count = $('#anatomy-count');
    if (count) count.textContent = wb.anatomy.parts.size;
  }

  function buildRow(s) {
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

  return { wireEvents, buildModelMenu, buildTree, renderOverlay };
}
