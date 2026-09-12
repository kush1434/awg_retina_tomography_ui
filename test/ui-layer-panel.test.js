// ============================================================================
//  Tests for app/ui/layer-panel.js — the segmented-layer rail rendered into a
//  fake DOM over a real headless workbench: the tree built from the manifest
//  (groups, rows, counts, labels), row input turned into wb.layers.* calls
//  (colour, opacity, sample visibility / opacity / offsets / reset), the
//  checkbox's load path (Checking… while resolving, the heavy-download
//  confirm, load / re-show / abort+hide) and the layer events rendered back
//  onto the rows (state + labels, progress bar, error toast, the empty-pane
//  placeholder, offset sliders following the core).
// ============================================================================

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbench } from '../core/workbench.js';
import { headlessAdapters } from '../core/adapters-headless.js';
import { HEAVY_BYTES } from '../core/layers.js';
import { binarySTL, stubIo } from './helpers/fixtures.js';
import { installFakeDom, tick, waitFor } from './helpers/fake-dom.js';
import { createLayerPanel } from '../app/ui/layer-panel.js';

let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => dom.restore());

// Structures are pre-resolved unless a test says otherwise, so no HEAD probe runs.
function structure(id, sampleId, over = {}) {
  return { id, sampleId, label: id.toUpperCase(), kind: 'stl', path: `${id}.stl`, color: 0xff0000, opacity: 1, bytes: null, _resolved: true, ...over };
}
function sample(id, structures, over = {}) {
  return { id, label: id.toUpperCase(), offset: { x: 0, y: 0, z: 0 }, opacity: 1, structures, ...over };
}

function makePanel({ cached = [], samplesOver = null } = {}) {
  const io = stubIo({ 'a.stl': binarySTL(2), 'b.stl': binarySTL(3), 'c.stl': binarySTL(4), cached });
  const wb = createWorkbench({ adapters: headlessAdapters(), io });
  const a = structure('a', 's1'), b = structure('b', 's1', { color: 0x00ff00, opacity: 0.5 });
  const c = structure('c', 's2');
  const samples = samplesOver || [
    sample('s1', [a, b], { link: 'https://example.test/s1' }),
    sample('s2', [c], { offset: { x: 0.4, y: 0, z: 0 }, demo: true }),
  ];
  wb.layers.setSamples(samples);
  const panel = createLayerPanel(wb, io);
  panel.wireEvents();
  const tree = dom.doc.el('#layer-tree');
  const rows = () => tree.querySelectorAll('.layer-row');
  const rowOf = (id) => rows().find((r) => r.querySelector(`#chk-${id}`));
  const checkOf = (id) => tree.querySelector(`#chk-${id}`);
  return { wb, io, panel, samples, a, b, c, tree, rows, rowOf, checkOf };
}

// ---------------------------------------------------------------------------
//  build
// ---------------------------------------------------------------------------
describe('build', () => {
  test('one group per sample with head, whole-sample toggle, gear and source link; one row per structure', () => {
    const { panel, samples, tree } = makePanel();
    panel.build(samples);
    const groups = tree.children;
    assert.equal(groups.length, 2);
    assert.equal(groups[0].className, 'sample');
    assert.equal(groups[0].dataset.sampleId, 's1');
    assert.equal(groups[1].className, 'sample is-demo', 'the demo sample is marked');

    const headRow = groups[0].querySelector('.sample-head-row');
    assert.equal(headRow.querySelector('.sample-head').className, 'sample-head open');
    assert.match(headRow.querySelector('.sample-head').innerHTML, /S1/);
    assert.equal(headRow.querySelector('.sample-vis').checked, true);
    assert.ok(headRow.querySelector('.sample-gear'));
    assert.equal(headRow.querySelector('.sample-src').href, 'https://example.test/s1');
    assert.equal(groups[1].querySelector('.sample-head-row').querySelector('.sample-src'), null, 'no link → no anchor');

    assert.equal(groups[0].querySelector('.sample-ctl').hidden, true);
    assert.equal(groups[0].querySelector('.sample-body').className, 'sample-body open');
    assert.deepEqual(groups[0].querySelector('.sample-body').children.map((r) => r.dataset.state), ['idle', 'idle']);
    assert.equal(tree.querySelectorAll('.layer-row').length, 3);
  });

  test('a row carries the structure colour, opacity and label and starts idle', () => {
    const { panel, samples, rowOf, b } = makePanel();
    panel.build(samples);
    const row = rowOf('b');
    assert.equal(row.className, 'layer-row');
    assert.equal(row.querySelector('.layer-check').id, 'chk-b');
    assert.equal(row.querySelector('.layer-swatch').style.background, '#00ff00');
    assert.equal(row.querySelector('.layer-color-input').value, '#00ff00');
    assert.equal(row.querySelector('.layer-label').htmlFor, 'chk-b');
    assert.match(row.querySelector('.layer-label').innerHTML, new RegExp(`<span class="layer-name">${b.label}</span>`));
    const op = row.querySelector('.layer-opacity');
    assert.equal(op.value, '50');
    assert.equal(op.style['--fill'], '50%');
    assert.equal(row.querySelector('.layer-progress').style.display, 'none');
    assert.equal(row.querySelector('.layer-status').textContent, '');
  });

  test('writes the counts, the live label and the first sample into the chrome', () => {
    const { panel, samples } = makePanel();
    panel.build(samples);
    assert.equal(dom.doc.el('#layer-count').textContent, 3);
    assert.equal(dom.doc.el('#meta-layers').textContent, 3);
    assert.equal(dom.doc.el('#live-label').textContent, '3 LAYERS');
    assert.equal(dom.doc.el('#meta-sample').textContent, 'S1');
    assert.equal(dom.doc.el('#study-label').textContent, 'S1 · µCT · SEG');
  });

  test('a single layer is singular; an empty manifest leaves the sample labels alone', () => {
    const { panel } = makePanel();
    panel.build([sample('only', [structure('x', 'only')])]);
    assert.equal(dom.doc.el('#live-label').textContent, '1 LAYER');
    dom.doc.el('#meta-sample').textContent = 'untouched';
    panel.build([]);
    assert.equal(dom.doc.el('#layer-count').textContent, 0);
    assert.equal(dom.doc.el('#live-label').textContent, '0 LAYERS');
    assert.equal(dom.doc.el('#meta-sample').textContent, 'untouched');
    assert.equal(dom.doc.el('#layer-tree').children.length, 0);
  });

  test('rebuilding replaces the previous tree', () => {
    const { panel, samples, tree } = makePanel();
    panel.build(samples);
    panel.build(samples.slice(1));
    assert.equal(tree.children.length, 1);
    assert.equal(tree.querySelectorAll('.layer-row').length, 1);
  });

  test('the sample controls carry the manifest opacity and offsets and a demo badge', () => {
    const { panel, samples, tree } = makePanel();
    panel.build(samples);
    const [s1, s2] = tree.children.map((g) => g.querySelector('.sample-ctl'));
    assert.match(s1.innerHTML, /class="slider s-op" min="0" max="100" value="100"/);
    assert.match(s2.innerHTML, /class="slider s-ox" min="-100" max="100" value="40"/);
    assert.doesNotMatch(s1.innerHTML, /demo-badge/);
    assert.match(s2.innerHTML, /demo-badge/);
  });

  test('showError replaces the tree with the manifest error', () => {
    const { panel, samples, tree } = makePanel();
    panel.build(samples);
    panel.showError('HTTP 404');
    assert.equal(tree.children.length, 0);
    assert.equal(tree.innerHTML, '<div class="tree-error">Could not load the dataset manifest.<br>HTTP 404</div>');
  });
});

// ---------------------------------------------------------------------------
//  Row input → workbench
// ---------------------------------------------------------------------------
describe('row input', () => {
  test('the head collapses its body; the gear reveals the controls', () => {
    const { panel, samples, tree } = makePanel();
    panel.build(samples);
    const group = tree.children[0];
    const head = group.querySelector('.sample-head'), body = group.querySelector('.sample-body');
    const gear = group.querySelector('.sample-gear'), ctl = group.querySelector('.sample-ctl');
    head.click();
    assert.equal(head.classList.contains('open'), false);
    assert.equal(body.classList.contains('open'), false);
    head.click();
    assert.equal(body.classList.contains('open'), true);
    gear.click();
    assert.equal(ctl.hidden, false);
    assert.equal(gear.classList.contains('active'), true);
    gear.click();
    assert.equal(ctl.hidden, true);
    assert.equal(gear.classList.contains('active'), false);
  });

  test('whole-sample visibility, sample opacity, offsets and reset delegate to wb.layers', () => {
    const { wb, panel, samples, tree } = makePanel();
    const vis = mock.method(wb.layers, 'setSampleVisible');
    const op = mock.method(wb.layers, 'setSampleOpacity');
    const off = mock.method(wb.layers, 'offsetChanged');
    const reset = mock.method(wb.layers, 'resetOffsets');
    panel.build(samples);
    const group = tree.children[1], ctl = group.querySelector('.sample-ctl');

    const cb = group.querySelector('.sample-vis');
    cb.checked = false; cb.dispatch('change');
    assert.deepEqual(vis.mock.calls[0].arguments, ['s2', false]);

    const sOp = ctl.querySelector('.s-op'); sOp.value = '35'; sOp.dispatch('input');
    assert.equal(op.mock.calls[0].arguments[0], samples[1]);
    assert.equal(op.mock.calls[0].arguments[1], 0.35);
    assert.equal(sOp.style['--fill'], '35%');

    const sz = ctl.querySelector('.s-oz'); sz.min = '-100'; sz.max = '100'; sz.value = '-20'; sz.dispatch('input');
    assert.deepEqual(off.mock.calls[0].arguments, [samples[1], 'z', -0.2]);
    assert.equal(sz.style['--fill'], '40%');

    ctl.querySelector('.s-reset').click();
    assert.deepEqual(reset.mock.calls[0].arguments, [samples[1]]);
  });

  test('colour and opacity on a row delegate with the structure record', () => {
    const { wb, panel, samples, rowOf, a } = makePanel();
    const color = mock.method(wb.layers, 'setColor');
    const opacity = mock.method(wb.layers, 'setOpacity');
    panel.build(samples);
    const row = rowOf('a');
    const swatch = row.querySelector('.layer-swatch'), input = row.querySelector('.layer-color-input');
    const opened = mock.method(input, 'click');
    swatch.click();
    assert.equal(opened.mock.callCount(), 1, 'the swatch opens the colour picker');
    input.dispatch('input', { target: { value: '#123456' } });
    assert.equal(swatch.style.background, '#123456');
    assert.deepEqual(color.mock.calls[0].arguments, [a, 0x123456]);

    const op = row.querySelector('.layer-opacity');
    op.value = '20'; op.dispatch('input');
    assert.deepEqual(opacity.mock.calls[0].arguments, [a, 0.2]);
    assert.equal(op.style['--fill'], '20%');
  });
});

// ---------------------------------------------------------------------------
//  The checkbox: load / show / hide
// ---------------------------------------------------------------------------
describe('checkbox', () => {
  test('checking a resolved, light layer loads it and the row walks idle → loading → loaded', async () => {
    const { wb, panel, samples, rowOf, checkOf } = makePanel();
    const load = mock.method(wb.layers, 'load');
    panel.build(samples);
    const row = rowOf('a'), cb = checkOf('a');
    const bar = row.querySelector('.layer-bar'), status = row.querySelector('.layer-status'), progress = row.querySelector('.layer-progress');

    cb.checked = true;
    const [p] = cb.dispatch('change');
    await p;
    assert.equal(load.mock.callCount(), 1);
    assert.equal(row.dataset.state, 'loading');
    assert.equal(progress.style.display, 'block');
    await waitFor(() => row.dataset.state === 'loaded');
    assert.equal(row.dataset.state, 'loaded');
    assert.equal(status.textContent, 'Loaded');
    assert.equal(bar.style.width, '100%');
    assert.equal(progress.style.display, 'none');
    assert.equal(dom.doc.el('#stl-empty').classList.contains('hidden'), true, 'placeholder hidden once something is visible');
    assert.equal(wb.layers.has('a'), true);
  });

  test('a cached mesh says so; unchecking hides without disposing and re-checking re-shows without a download', async () => {
    const { wb, panel, samples, rowOf, checkOf } = makePanel({ cached: ['a.stl'] });
    panel.build(samples);
    const row = rowOf('a'), cb = checkOf('a');
    cb.checked = true; await cb.dispatch('change')[0];
    await waitFor(() => row.dataset.state === 'loaded');
    assert.equal(row.querySelector('.layer-status').textContent, 'Loaded · cached');

    const load = mock.method(wb.layers, 'load');
    const abort = mock.method(wb.layers, 'abort');
    cb.checked = false; await cb.dispatch('change')[0];
    assert.deepEqual(abort.mock.calls[0].arguments, ['a']);
    assert.equal(wb.layers.has('a'), true, 'kept, only hidden');
    assert.equal(wb.layers.anyVisible(), false);
    assert.equal(dom.doc.el('#stl-empty').classList.contains('hidden'), false);

    cb.checked = true; await cb.dispatch('change')[0];
    assert.equal(load.mock.callCount(), 0, 'no second download');
    assert.equal(wb.layers.anyVisible(), true);
    assert.equal(dom.doc.el('#stl-empty').classList.contains('hidden'), true);
  });

  test('an unresolved layer shows Checking… while it resolves, then annotates its size and loads', async () => {
    const { wb, panel, samples, rowOf, checkOf, a } = makePanel();
    delete a._resolved;
    let release;
    const gate = new Promise((r) => { release = r; });
    // HEAD probes go through global fetch; hold the first one so the state is observable.
    const saved = globalThis.fetch;
    globalThis.fetch = async () => { await gate; return new Response(null, { status: 200, headers: { 'content-length': '2048' } }); };
    try {
      const load = mock.method(wb.layers, 'load');
      panel.build(samples);
      const row = rowOf('a'), cb = checkOf('a');
      cb.checked = true;
      const [p] = cb.dispatch('change');
      await tick();
      assert.equal(row.dataset.state, 'loading');
      assert.equal(row.querySelector('.layer-status').textContent, 'Checking…');
      assert.equal(load.mock.callCount(), 0);
      release();
      await p;
      assert.equal(load.mock.callCount(), 1);
      assert.equal(a._resolved, true);
      // The size span is part of the label's innerHTML (opaque to the fake DOM).
      assert.equal(row.querySelector('.layer-label').querySelector('.layer-size').textContent, '2.00 KB');
    } finally {
      globalThis.fetch = saved;
    }
  });

  test('unchecking during Checking… returns the row to idle without loading', async () => {
    const { wb, panel, samples, rowOf, checkOf, a } = makePanel();
    delete a._resolved;
    let release;
    const gate = new Promise((r) => { release = r; });
    const saved = globalThis.fetch;
    globalThis.fetch = async () => { await gate; return new Response(null, { status: 404 }); };
    try {
      const load = mock.method(wb.layers, 'load');
      panel.build(samples);
      const row = rowOf('a'), cb = checkOf('a');
      cb.checked = true;
      const [p] = cb.dispatch('change');
      await tick();
      cb.checked = false;
      release();
      await p;
      assert.equal(load.mock.callCount(), 0);
      assert.equal(row.dataset.state, 'idle');
      assert.equal(row.querySelector('.layer-status').textContent, '');
    } finally {
      globalThis.fetch = saved;
    }
  });

  test('a heavy, uncached layer asks first: Download loads, Cancel unchecks the box', async () => {
    const { wb, panel, samples, checkOf, a } = makePanel();
    a.bytes = HEAVY_BYTES + 1;
    const load = mock.method(wb.layers, 'load');
    panel.build(samples);
    const cb = checkOf('a');
    const modal = () => dom.doc.body.querySelectorAll('.modal-back')[0];

    cb.checked = true;
    let p = cb.dispatch('change')[0];
    await tick();
    assert.ok(modal(), 'confirm shown');
    assert.match(modal().innerHTML, /“A” is 400 MB\. It will download once/);
    assert.match(modal().innerHTML, /data-act="ok">Download</);
    modal().dispatch('click', { target: { dataset: { act: 'cancel' } } });
    await p;
    assert.equal(cb.checked, false);
    assert.equal(load.mock.callCount(), 0);

    cb.checked = true;
    p = cb.dispatch('change')[0];
    await tick();
    modal().dispatch('click', { target: { dataset: { act: 'ok' } } });
    await p;
    assert.equal(load.mock.callCount(), 1);
    assert.equal(load.mock.calls[0].arguments[0], a);
  });

  test('a heavy layer that is already cached loads without asking', async () => {
    const { wb, panel, samples, checkOf, a } = makePanel({ cached: ['a.stl'] });
    a.bytes = HEAVY_BYTES + 1;
    const load = mock.method(wb.layers, 'load');
    panel.build(samples);
    const cb = checkOf('a');
    cb.checked = true;
    await cb.dispatch('change')[0];
    assert.equal(dom.doc.body.querySelectorAll('.modal-back').length, 0);
    assert.equal(load.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
//  Events → rows
// ---------------------------------------------------------------------------
describe('layer events', () => {
  test('layer:state renders each phase label, the bar and the progress strip', () => {
    const { wb, panel, samples, rowOf } = makePanel();
    panel.build(samples);
    const row = rowOf('b');
    const bar = row.querySelector('.layer-bar'), status = row.querySelector('.layer-status'), progress = row.querySelector('.layer-progress');
    const emit = (payload) => wb.layers.emitter.emit('layer:state', { id: 'b', ...payload });

    emit({ state: 'loading', phase: 'start' });
    assert.equal(row.dataset.state, 'loading');
    assert.equal(status.textContent, 'Downloading… 0%');
    assert.equal(progress.style.display, 'block');
    assert.equal(bar.style.width, undefined, 'the bar is left to layer:progress while loading');

    emit({ state: 'loading', phase: 'cache' });
    assert.equal(status.textContent, 'Loading from cache…');

    emit({ state: 'loading', phase: 'build' });
    assert.equal(status.textContent, 'Building mesh…');
    assert.equal(bar.style.width, '100%');

    emit({ state: 'error' });
    assert.equal(row.dataset.state, 'error');
    assert.equal(status.textContent, 'Failed to load');
    assert.equal(bar.style.width, '0%');
    assert.equal(progress.style.display, 'none');

    emit({ state: 'loaded', cached: true });
    assert.equal(status.textContent, 'Loaded · cached');
    assert.equal(bar.style.width, '100%');

    emit({ state: 'idle' });
    assert.equal(row.dataset.state, 'idle');
    assert.equal(status.textContent, '');
    assert.equal(bar.style.width, '0%');
  });

  test('layer:progress fills the bar (capped at 99 %) and prints the byte counts; no total → 50 % and bytes only', () => {
    const { wb, panel, samples, rowOf } = makePanel();
    panel.build(samples);
    const row = rowOf('a');
    const bar = row.querySelector('.layer-bar'), status = row.querySelector('.layer-status');
    wb.layers.emitter.emit('layer:progress', { id: 'a', loaded: 512 * 1024, total: 2 * 1024 * 1024, pct: 25 });
    assert.equal(bar.style.width, '25%');
    assert.equal(status.textContent, 'Downloading… 25% (512 KB / 2.00 MB)');
    wb.layers.emitter.emit('layer:progress', { id: 'a', loaded: 2 * 1024 * 1024, total: 2 * 1024 * 1024, pct: 100 });
    assert.equal(bar.style.width, '99%');
    wb.layers.emitter.emit('layer:progress', { id: 'a', loaded: 3072, total: 0, pct: 0 });
    assert.equal(bar.style.width, '50%');
    assert.equal(status.textContent, 'Downloading… 3.00 KB');
  });

  test('events for an unknown row are ignored', () => {
    const { wb, panel, samples } = makePanel();
    panel.build(samples);
    assert.doesNotThrow(() => {
      wb.layers.emitter.emit('layer:state', { id: 'nope', state: 'loaded' });
      wb.layers.emitter.emit('layer:progress', { id: 'nope', loaded: 1, total: 2, pct: 50 });
    });
  });

  test('layer:error toasts the label and message and unchecks the row', () => {
    const { wb, panel, samples, checkOf } = makePanel();
    panel.build(samples);
    const cb = checkOf('a'); cb.checked = true;
    wb.layers.emitter.emit('layer:error', { id: 'a', label: 'Retina', error: new Error('HTTP 500') });
    const toasts = dom.doc.el('#toast-host').children;
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].className, 'toast toast-error');
    assert.equal(toasts[0].textContent, 'Couldn\'t load "Retina". HTTP 500');
    assert.equal(cb.checked, false);
  });

  test('a real failed download drives the row to error and the toast through the controller', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { panel, rowOf, checkOf } = makePanel({
      samplesOver: [sample('s1', [structure('missing', 's1', { path: 'missing.stl' })])],
    });
    panel.build([sample('s1', [structure('missing', 's1', { path: 'missing.stl' })])]);
    const cb = checkOf('missing'), row = rowOf('missing');
    cb.checked = true;
    await cb.dispatch('change')[0];
    await waitFor(() => row.dataset.state === 'error');
    assert.equal(row.dataset.state, 'error');
    assert.equal(row.querySelector('.layer-status').textContent, 'Failed to load');
    assert.equal(cb.checked, false);
    assert.match(dom.doc.el('#toast-host').children[0].textContent, /Couldn't load "MISSING"\. HTTP 404/);
  });

  test('sample:offset moves the matching slider and its fill; other axes and unknown samples are untouched', () => {
    const { wb, panel, samples, tree } = makePanel();
    panel.build(samples);
    const ctl = tree.children[1].querySelector('.sample-ctl');
    const ox = ctl.querySelector('.s-ox'), oy = ctl.querySelector('.s-oy');
    ox.min = oy.min = '-100'; ox.max = oy.max = '100';
    oy.value = '7';
    wb.layers.setSampleOffset(samples[1], 'x', -0.25);
    assert.equal(ox.value, -25);
    assert.equal(ox.style['--fill'], '37.5%');
    assert.equal(oy.value, '7');
    assert.doesNotThrow(() => wb.layers.emitter.emit('sample:offset', { sampleId: 'nope', axis: 'x', value: 1 }));
  });
});
