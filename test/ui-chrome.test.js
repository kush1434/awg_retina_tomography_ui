// ============================================================================
//  Tests for app/ui/chrome.js — the frame around the panes, rendered into a
//  fake DOM over a real headless workbench: the slider fill helper, toasts
//  (show on the next frame, remove after the timeout), the confirm modal's
//  three ways out, the HUD's brackets / orientation labels / toolbar, the
//  status-bar and segmented-control mirrors of the view events (render mode,
//  clip axes, layout re-measure, sync, auto-rotate, stats) and the study
//  selector.
// ============================================================================

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbench } from '../core/workbench.js';
import { headlessAdapters } from '../core/adapters-headless.js';
import { binarySTL, stubIo } from './helpers/fixtures.js';
import { installFakeDom, FakeElement } from './helpers/fake-dom.js';
import {
  setFill, toast, askConfirm, addHUD, wireViewEvents,
  focusSample, buildStudyMenu, openStudyMenu, closeStudyMenu,
} from '../app/ui/chrome.js';

let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => dom.restore());

function makeWb() {
  const io = stubIo({ 'a.stl': binarySTL(2), 'b.stl': binarySTL(3) });
  const wb = createWorkbench({ adapters: headlessAdapters(), io });
  const a = { id: 'a', sampleId: 's1', label: 'A', kind: 'stl', path: 'a.stl', color: 0xff0000, opacity: 1, bytes: null };
  const b = { id: 'b', sampleId: 's2', label: 'B', kind: 'stl', path: 'b.stl', color: 0x00ff00, opacity: 1, bytes: null };
  const samples = [
    { id: 's1', label: 'Mouse f10', offset: { x: 0, y: 0, z: 0 }, opacity: 1, structures: [a] },
    { id: 's2', label: 'Demo copy', offset: { x: 0.4, y: 0, z: 0 }, opacity: 1, structures: [b], demo: true },
  ];
  wb.layers.setSamples(samples);
  return { wb, io, samples, a, b };
}

// A segmented button with the given data attribute, appended to `host`.
function segBtn(host, key, value) {
  const b = new FakeElement('button');
  b.classList.add('seg-btn'); b.dataset[key] = value;
  host.appendChild(b);
  return b;
}

// ---------------------------------------------------------------------------
//  setFill
// ---------------------------------------------------------------------------
describe('setFill', () => {
  test('writes the value as a percentage of the range into --fill', () => {
    const input = { min: '0', max: '100', value: '25', style: { setProperty: mock.fn() } };
    setFill(input);
    assert.deepEqual(input.style.setProperty.mock.calls[0].arguments, ['--fill', '25%']);
  });

  test('honours a negative range and defaults min/max to 0..100', () => {
    const offset = { min: '-100', max: '100', value: '-50', style: { setProperty: mock.fn() } };
    setFill(offset);
    assert.equal(offset.style.setProperty.mock.calls[0].arguments[1], '25%');
    const bare = { value: '40', style: { setProperty: mock.fn() } };
    setFill(bare);
    assert.equal(bare.style.setProperty.mock.calls[0].arguments[1], '40%');
  });
});

// ---------------------------------------------------------------------------
//  toast + askConfirm
// ---------------------------------------------------------------------------
describe('toast', () => {
  test('appends a typed toast to #toast-host, shows it next frame and removes it after ms + 300', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    toast('Cache cleared.', 'info', 1000);
    const host = dom.doc.el('#toast-host');
    assert.equal(host.children.length, 1);
    const el = host.children[0];
    assert.equal(el.className, 'toast toast-info');
    assert.equal(el.textContent, 'Cache cleared.');
    assert.equal(el.classList.contains('show'), false);
    dom.flushRaf();
    assert.equal(el.classList.contains('show'), true);
    t.mock.timers.tick(999);
    assert.equal(el.classList.contains('show'), true);
    t.mock.timers.tick(1);
    assert.equal(el.classList.contains('show'), false, 'hidden at the timeout');
    assert.equal(host.children.length, 1, 'still in the DOM for the fade');
    t.mock.timers.tick(300);
    assert.equal(host.children.length, 0, 'removed after the fade');
  });

  test('defaults to an info toast that lives 6 s; an error toast carries the type class', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    toast('plain');
    toast('bad', 'error');
    const [info, error] = dom.doc.el('#toast-host').children;
    assert.equal(info.className, 'toast toast-info');
    assert.equal(error.className, 'toast toast-error');
    t.mock.timers.tick(5999);
    assert.equal(dom.doc.el('#toast-host').children.length, 2);
    t.mock.timers.tick(1);          // the hide fires and schedules the fade
    t.mock.timers.tick(300);
    assert.equal(dom.doc.el('#toast-host').children.length, 0);
  });
});

describe('askConfirm', () => {
  const back = () => dom.doc.body.querySelectorAll('.modal-back')[0];

  test('renders the title, message and confirm label into a modal on body', () => {
    askConfirm({ title: 'Large layer', message: 'Continue?', confirmLabel: 'Download' });
    const modal = back();
    assert.ok(modal, 'modal-back appended to body');
    assert.match(modal.innerHTML, /<div class="modal-title">Large layer<\/div>/);
    assert.match(modal.innerHTML, /<div class="modal-msg">Continue\?<\/div>/);
    assert.match(modal.innerHTML, /data-act="ok">Download</);
  });

  test('resolves true on OK, false on Cancel or a backdrop click, removing the modal each time', async () => {
    const okTarget = { dataset: { act: 'ok' } };
    const cancelTarget = { dataset: { act: 'cancel' } };
    const other = { dataset: {} };

    let p = askConfirm({ title: 't', message: 'm' });
    back().dispatch('click', { target: okTarget });
    assert.equal(await p, true);
    assert.equal(back(), undefined, 'removed after OK');

    p = askConfirm({ title: 't', message: 'm' });
    back().dispatch('click', { target: cancelTarget });
    assert.equal(await p, false);
    assert.equal(back(), undefined);

    p = askConfirm({ title: 't', message: 'm' });
    const el = back();
    el.dispatch('click', { target: other });          // a click inside the card
    assert.equal(back(), el, 'a click on the card itself does nothing');
    el.dispatch('click', { target: el });             // the backdrop
    assert.equal(await p, false);
    assert.equal(back(), undefined);
  });

  test('the default confirm label is OK', () => {
    askConfirm({ title: 't', message: 'm' });
    assert.match(back().innerHTML, /data-act="ok">OK</);
  });
});

// ---------------------------------------------------------------------------
//  addHUD
// ---------------------------------------------------------------------------
describe('addHUD', () => {
  test('adds four brackets, the pane\'s orientation labels and a toolbar wired to the workbench', () => {
    const { wb } = makeWb();
    const paneEl = new FakeElement('div');
    paneEl.dataset.orient = 'A P L R';
    addHUD(wb, wb.panes.glb, paneEl);

    assert.deepEqual(paneEl.querySelectorAll('.hud-bracket').map((b) => b.className), ['hud-bracket tl', 'hud-bracket tr', 'hud-bracket bl', 'hud-bracket br']);
    assert.deepEqual(paneEl.querySelectorAll('.hud-orient').map((o) => [o.className, o.textContent]),
      [['hud-orient t', 'A'], ['hud-orient b', 'P'], ['hud-orient l', 'L'], ['hud-orient r', 'R']]);
    const bar = paneEl.querySelector('.hud-toolbar');
    assert.ok(bar);
    assert.match(bar.innerHTML, /data-act="auto"/);

    const auto = mock.method(wb, 'setAutoRotate');
    const reset = mock.method(wb, 'resetPane');
    bar.querySelector('[data-act="auto"]').onclick();
    assert.deepEqual(auto.mock.calls[0].arguments, [true], 'toggles from the current state');
    bar.querySelector('[data-act="auto"]').onclick();
    assert.deepEqual(auto.mock.calls[1].arguments, [false]);
    bar.querySelector('[data-act="reset"]').onclick();
    bar.querySelector('[data-act="fit"]').onclick();
    assert.deepEqual(reset.mock.calls.map((c) => c.arguments), [['glb'], ['glb']]);
  });

  test('falls back to S I R L when the pane declares no orientation', () => {
    const { wb } = makeWb();
    const paneEl = new FakeElement('div');
    addHUD(wb, wb.panes.stl, paneEl);
    assert.deepEqual(paneEl.querySelectorAll('.hud-orient').map((o) => o.textContent), ['S', 'I', 'R', 'L']);
    const reset = mock.method(wb, 'resetPane');
    paneEl.querySelector('.hud-toolbar').querySelector('[data-act="fit"]').onclick();
    assert.deepEqual(reset.mock.calls[0].arguments, ['stl']);
  });
});

// ---------------------------------------------------------------------------
//  wireViewEvents
// ---------------------------------------------------------------------------
describe('wireViewEvents', () => {
  function wired() {
    const ctx = makeWb();
    const doc = dom.doc;
    const modes = ['surface', 'wireframe', 'slices'].map((m) => segBtn(doc.el('#render-mode'), 'mode', m));
    const layouts = ['split', 'overlay'].map((l) => segBtn(doc.el('#layout-seg'), 'layout', l));
    const toggles = ['x', 'y', 'z'].map((ax) => {
      const wrap = new FakeElement('label'); wrap.classList.add('slice-toggle');
      const cb = new FakeElement('input'); cb.dataset.axis = ax; wrap.appendChild(cb);
      doc.body.appendChild(wrap);
      return cb;
    });
    const label = new FakeElement('span'); label.classList.add('sync-toggle-label');
    doc.el('#btn-sync').appendChild(label);
    const mounts = { glb: { measure: mock.fn() }, stl: { measure: mock.fn() } };
    wireViewEvents(ctx.wb, mounts);
    return { ...ctx, doc, modes, layouts, toggles, label, mounts };
  }

  test('rendermode: marks the active segment, shows the slice section only for slices, writes both readouts', () => {
    const { wb, doc, modes } = wired();
    wb.setRenderMode('surface');
    assert.deepEqual(modes.map((b) => b.classList.contains('active')), [true, false, false]);
    assert.equal(doc.el('#slice-sec').hidden, true);
    assert.equal(doc.el('#mode-desc').textContent, 'Shaded surface · solid meshes');
    assert.equal(doc.el('#stat-mode').textContent, 'surface');

    wb.setRenderMode('slices');
    assert.deepEqual(modes.map((b) => b.classList.contains('active')), [false, false, true]);
    assert.equal(doc.el('#slice-sec').hidden, false);
    assert.equal(doc.el('#mode-desc').textContent, 'Tri-planar MPR · orthogonal clipping');
    assert.equal(doc.el('#stat-mode').textContent, 'slices');

    wb.setRenderMode('wireframe');
    assert.equal(doc.el('#mode-desc').textContent, 'Wireframe · edge view');
    assert.equal(doc.el('#slice-sec').hidden, true);
  });

  test('clip: mirrors the axis checkboxes — entering slices auto-checks X, setClipAxis flips the others', () => {
    const { wb, toggles } = wired();
    wb.setRenderMode('slices');
    assert.deepEqual(toggles.map((t) => t.checked), [true, false, false]);
    wb.setClipAxis('z', true);
    assert.deepEqual(toggles.map((t) => t.checked), [true, false, true]);
    wb.setClipAxis('x', false);
    assert.deepEqual(toggles.map((t) => t.checked), [false, false, true]);
  });

  test('layout: marks the segment, toggles the body class and overlay controls, then re-measures twice with the captured layout', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { wb, doc, layouts, mounts } = wired();
    const refit = mock.method(wb, 'refitAfterReflow');

    wb.setLayout('overlay');
    assert.deepEqual(layouts.map((b) => b.classList.contains('active')), [false, true]);
    assert.equal(doc.body.classList.contains('overlay-layout'), true);
    assert.equal(doc.el('#overlay-ctl').hidden, false);
    assert.equal(doc.el('#layout-desc').textContent, 'Everything superimposed & aligned');
    assert.equal(mounts.glb.measure.mock.callCount(), 0, 'nothing measured synchronously');

    assert.equal(dom.flushRaf(), 1);
    assert.equal(mounts.glb.measure.mock.callCount(), 1);
    assert.equal(mounts.stl.measure.mock.callCount(), 1);
    assert.deepEqual(refit.mock.calls[0].arguments, ['overlay']);

    t.mock.timers.tick(89);
    assert.equal(refit.mock.callCount(), 1);
    t.mock.timers.tick(1);
    assert.equal(refit.mock.callCount(), 2);
    assert.equal(mounts.stl.measure.mock.callCount(), 2);

    wb.setLayout('split');
    assert.deepEqual(layouts.map((b) => b.classList.contains('active')), [true, false]);
    assert.equal(doc.body.classList.contains('overlay-layout'), false);
    assert.equal(doc.el('#overlay-ctl').hidden, true);
    assert.equal(doc.el('#layout-desc').textContent, 'Anatomy & layers side by side');
    dom.flushRaf();
    assert.deepEqual(refit.mock.calls[2].arguments, ['split']);
  });

  test('sync: aria-pressed, the body class and the button label follow the link state', () => {
    const { wb, doc, label } = wired();
    wb.setSync(true);
    assert.equal(doc.el('#btn-sync').getAttribute('aria-pressed'), 'true');
    assert.equal(doc.body.classList.contains('synced'), true);
    assert.equal(label.textContent, 'Synced');
    wb.setSync(false);
    assert.equal(doc.el('#btn-sync').getAttribute('aria-pressed'), 'false');
    assert.equal(doc.body.classList.contains('synced'), false);
    assert.equal(label.textContent, 'Sync views');
  });

  test('autorotate: the checkbox and every HUD auto button follow', () => {
    const { wb, doc } = wired();
    const paneA = new FakeElement('div'), paneB = new FakeElement('div');
    doc.body.append(paneA, paneB);
    // Real toolbars come from innerHTML, so build two matchable buttons here.
    const buttons = [paneA, paneB].map((p) => {
      const bar = new FakeElement('div'); bar.classList.add('hud-toolbar');
      const b = new FakeElement('button'); b.dataset.act = 'auto'; bar.appendChild(b); p.appendChild(bar);
      return b;
    });
    wb.setAutoRotate(true);
    assert.equal(doc.el('#auto-rotate').checked, true);
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'true']);
    wb.setAutoRotate(false);
    assert.equal(doc.el('#auto-rotate').checked, false);
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'false']);
  });

  test('stats: the status bar shows azimuth/elevation, a formatted triangle count and fps', () => {
    const { wb, doc } = wired();
    wb.tick(0);
    wb.tick(250);
    assert.match(doc.el('#stat-cam').innerHTML, /^az -?\d+°&nbsp;&nbsp;el -?\d+°$/);
    assert.equal(doc.el('#stat-tris').textContent, '0 triangles');
    assert.equal(doc.el('#stat-fps').textContent, '0 fps');
  });
});

// ---------------------------------------------------------------------------
//  Study selector
// ---------------------------------------------------------------------------
describe('study selector', () => {
  test('buildStudyMenu lists every sample with its icon, name and layer count', () => {
    const { wb, samples } = makeWb();
    buildStudyMenu(wb, samples);
    const items = dom.doc.el('#study-menu').children;
    assert.equal(items.length, 2);
    assert.equal(items[0].className, 'study-item');
    assert.equal(items[0].getAttribute('role'), 'menuitem');
    assert.match(items[0].innerHTML, /folder_open/);
    assert.match(items[0].innerHTML, /Mouse f10/);
    assert.match(items[0].innerHTML, /1 layer</);
    assert.match(items[1].innerHTML, /content_copy/, 'a demo sample gets the copy icon');
    buildStudyMenu(wb, samples.slice(0, 1));
    assert.equal(dom.doc.el('#study-menu').children.length, 1, 'rebuilt from scratch');
  });

  test('clicking an item focuses that sample and closes the menu', () => {
    const { wb, samples } = makeWb();
    const focus = mock.method(wb.layers, 'focusSample');
    buildStudyMenu(wb, samples);
    openStudyMenu();
    const menu = dom.doc.el('#study-menu');
    assert.equal(menu.classList.contains('open'), true);
    assert.equal(menu.style.left, '12px');
    assert.equal(menu.style.top, '36px');
    menu.children[1].click();
    assert.deepEqual(focus.mock.calls[0].arguments, ['s2']);
    assert.equal(menu.classList.contains('open'), false);
    assert.equal(dom.doc.el('#study-label').textContent, 'DEMO COPY · µCT · SEG');
  });

  test('focusSample updates the label, frames the sample and scrolls its rail group into view', () => {
    const { wb } = makeWb();
    const focus = mock.method(wb.layers, 'focusSample');
    const group = new FakeElement('div'); group.dataset.sampleId = 's1';
    dom.doc.el('#layer-tree').appendChild(group);
    focusSample(wb, 's1');
    assert.equal(dom.doc.el('#study-label').textContent, 'MOUSE F10 · µCT · SEG');
    assert.deepEqual(focus.mock.calls[0].arguments, ['s1']);
    assert.equal(group.scrolledInto, 1);
    // An unknown id still delegates (the core ignores it) and leaves the label alone.
    focusSample(wb, 'nope');
    assert.equal(dom.doc.el('#study-label').textContent, 'MOUSE F10 · µCT · SEG');
    assert.deepEqual(focus.mock.calls[1].arguments, ['nope']);
  });

  test('closeStudyMenu drops the open class', () => {
    openStudyMenu();
    closeStudyMenu();
    assert.equal(dom.doc.el('#study-menu').classList.contains('open'), false);
  });
});
