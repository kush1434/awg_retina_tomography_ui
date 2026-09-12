// ============================================================================
//  layer-panel.js — the segmented-layer rail: one collapsible group per sample
//  with its transform controls and one row per structure (visibility, colour,
//  opacity, download progress). Downloading, parsing and placing a layer lives
//  in core/layers.js; the panel keeps the row elements, turns row input into
//  wb.layers.* calls and renders the controller's events back onto the rows.
//  Pure view: it receives the workbench and the asset I/O, and touches the
//  document only from the factory onwards.
// ============================================================================

import { resolveStructure, formatBytes } from '../../data-loader.js';
import { HEAVY_BYTES } from '../../core/index.js';
import { setFill, toast, askConfirm } from './chrome.js';

const $ = (s) => document.querySelector(s);

/**
 * Build the layer panel over `wb`.
 * @param {object} wb the workbench (core/workbench.js)
 * @param {{ isCached: (url: string) => Promise<boolean> }} io the same asset
 *   I/O the workbench downloads through — the heavy-download confirm is
 *   skipped for a mesh that is already in the cache.
 */
export function createLayerPanel(wb, io) {
  const layerTree = $('#layer-tree');
  const stlEmpty = $('#stl-empty');
  const rowRefs = new Map();          // structureId -> { row, bar, status, progress, checkbox, sizeEl }
  const sampleCtlRefs = new Map();    // sampleId -> { ox, oy, oz } offset slider inputs

  // -------------------------------------------------------------------------
  //  Layer events → rows
  // -------------------------------------------------------------------------
  function wireEvents() {
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

  function setRowState(refs, state, status) {
    if (!refs) return;
    refs.row.dataset.state = state;
    refs.status.textContent = status || '';
    if (state !== 'loading') refs.bar.style.width = state === 'loaded' ? '100%' : '0%';
    refs.progress.style.display = state === 'loading' ? 'block' : 'none';
  }

  // -------------------------------------------------------------------------
  //  Layer tree
  // -------------------------------------------------------------------------
  function build(samples) {
    layerTree.innerHTML = '';
    let count = 0;
    for (const sample of samples) {
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
    if (samples[0]) {
      $('#meta-sample').textContent = samples[0].label;
      $('#study-label').textContent = `${samples[0].label.toUpperCase()} · µCT · SEG`;
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
        if (wb.layers.isHeavy(structure) && !(await io.isCached(structure.path))) {
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

  // The manifest could not be loaded: the tree shows why instead of rows.
  function showError(message) {
    layerTree.innerHTML = `<div class="tree-error">Could not load the dataset manifest.<br>${message}</div>`;
  }

  return { wireEvents, build, annotateSize, showError };
}
