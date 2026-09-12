// ============================================================================
//  chrome.js — the frame around the two panes: the slider fill helper, toasts,
//  the confirm modal, the per-pane HUD (brackets, orientation labels, toolbar),
//  the study selector and the status-bar / segmented-control mirrors of the
//  workbench's view events. Pure view: each function receives the workbench
//  it renders (or nothing) and touches the document only when it is called,
//  so nothing here runs at import time.
// ============================================================================

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
//  Sliders fill helper
// ---------------------------------------------------------------------------
export function setFill(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

// ---------------------------------------------------------------------------
//  Toasts + confirm
// ---------------------------------------------------------------------------
export function toast(message, type = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`; el.textContent = message;
  $('#toast-host').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}
export function askConfirm({ title, message, confirmLabel = 'OK' }) {
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
//  Per-pane HUD
// ---------------------------------------------------------------------------
export function addHUD(wb, pane, paneEl) {
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
//  View events — render mode, clips, layout, sync, auto-rotate, status bar
// ---------------------------------------------------------------------------
// `mounts` are the { glb, stl } pane mounts from app/browser-adapters.js; the
// layout switch re-measures them once the panes have reflowed.
export function wireViewEvents(wb, mounts) {
  const btnSync = $('#btn-sync');
  const statCam = $('#stat-cam'), statTris = $('#stat-tris'), statFps = $('#stat-fps');

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
//  Study selector (top bar) — pick & frame a sample
// ---------------------------------------------------------------------------
export function focusSample(wb, sampleId) {
  const sample = wb.layers.findSample(sampleId);
  if (sample) $('#study-label').textContent = `${sample.label.toUpperCase()} · µCT · SEG`;

  wb.layers.focusSample(sampleId);
  // Reveal the sample in the left rail.
  const el = $('#layer-tree').querySelector(`[data-sample-id="${sampleId}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function buildStudyMenu(wb, samples) {
  const menu = $('#study-menu');
  menu.innerHTML = '';
  for (const sample of samples) {
    const n = sample.structures.length;
    const item = document.createElement('button');
    item.className = 'study-item'; item.setAttribute('role', 'menuitem');
    item.innerHTML = `<span class="ms">${sample.demo ? 'content_copy' : 'folder_open'}</span>
      <span class="study-item-name">${sample.label}</span>
      <span class="study-item-meta mono">${n} layer${n === 1 ? '' : 's'}</span>`;
    item.addEventListener('click', () => { focusSample(wb, sample.id); closeStudyMenu(); });
    menu.appendChild(item);
  }
}

export function openStudyMenu() {
  const menu = $('#study-menu');
  const r = $('#study-selector').getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.classList.add('open');
}
export function closeStudyMenu() { $('#study-menu').classList.remove('open'); }
